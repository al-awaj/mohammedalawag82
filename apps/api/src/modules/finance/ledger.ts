import type { Executor } from '../../db/pool.js';
import { AppError } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';

export type AccountKind =
  | 'cash' | 'bank' | 'wallet' | 'gateway'
  | 'provider_payable_not_due' | 'provider_payable_due' | 'provider_payable_on_hold' | 'customer_advances' | 'refunds_payable'
  | 'commission_revenue' | 'gateway_fees' | 'platform_discount_cost' | 'fx_difference'
  | 'direct_payments_memo' | 'direct_payments_memo_contra';

/** Chart of accounts approved in docs/05-financial-design.md (one set per country × currency). */
export const CHART: Record<AccountKind, { code: string; type: 'asset' | 'liability' | 'revenue' | 'expense' | 'memo'; ar: string; en: string; fund?: true }> = {
  cash: { code: '1100', type: 'asset', ar: 'الصندوق النقدي', en: 'Cash', fund: true },
  bank: { code: '1200', type: 'asset', ar: 'الحسابات البنكية', en: 'Bank accounts', fund: true },
  wallet: { code: '1300', type: 'asset', ar: 'المحافظ الإلكترونية', en: 'E-wallets', fund: true },
  gateway: { code: '1400', type: 'asset', ar: 'ذمم بوابات الدفع', en: 'Payment gateway receivables', fund: true },
  provider_payable_not_due: { code: '2100', type: 'liability', ar: 'مستحقات أصحاب الخدمات - غير مستحقة بعد', en: 'Provider payables - not yet due' },
  provider_payable_due: { code: '2110', type: 'liability', ar: 'مستحقات أصحاب الخدمات - مستحقة', en: 'Provider payables - due' },
  provider_payable_on_hold: { code: '2120', type: 'liability', ar: 'مستحقات معلقة (نزاع)', en: 'Provider payables - on hold' },
  customer_advances: { code: '2200', type: 'liability', ar: 'أموال العملاء المقدمة', en: 'Customer advances' },
  refunds_payable: { code: '2300', type: 'liability', ar: 'استردادات مستحقة للعملاء', en: 'Refunds payable' },
  commission_revenue: { code: '4100', type: 'revenue', ar: 'إيراد العمولات', en: 'Commission revenue' },
  gateway_fees: { code: '5100', type: 'expense', ar: 'رسوم مزودي الدفع', en: 'Payment provider fees' },
  platform_discount_cost: { code: '5200', type: 'expense', ar: 'تكلفة الخصومات على المنصة', en: 'Platform-borne discounts' },
  fx_difference: { code: '5900', type: 'expense', ar: 'فروق الصرف', en: 'FX differences' },
  direct_payments_memo: { code: '9100', type: 'memo', ar: 'حساب تذكيري - مدفوعات مباشرة لأصحاب الخدمات', en: 'Memo - direct payments to providers' },
  // Balancing side of the memo entry (a single-sided memo cannot balance).
  direct_payments_memo_contra: { code: '9190', type: 'memo', ar: 'مقابل الحساب التذكيري للمدفوعات المباشرة', en: 'Memo contra - direct payments' },
};

/** Finds or creates the system account of a kind for a country and currency. */
export async function systemAccount(c: Executor, countryId: string, currency: string, kind: AccountKind): Promise<string> {
  const def = CHART[kind];
  await c.query(
    `INSERT INTO ledger_accounts (country_id, currency_code, code, kind, type, name, is_system)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     ON CONFLICT (country_id, currency_code, kind) WHERE is_system DO NOTHING`,
    [countryId, currency, def.code, kind, def.type, JSON.stringify({ ar: def.ar, en: def.en })]);
  return (await c.query<{ id: string }>(
    'SELECT id FROM ledger_accounts WHERE country_id = $1 AND currency_code = $2 AND kind = $3 AND is_system', [countryId, currency, kind])).rows[0]!.id;
}

export interface LineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  currency: string;
  providerId?: string | null;
  bookingId?: string | null;
  paymentId?: string | null;
  memo?: string | null;
}

export interface EntryInput {
  countryId: string;
  description: string;
  sourceType: string;
  sourceId: string | null;
  /** Identifies the business event; posting the same event twice returns the first entry. */
  idempotencyKey: string;
  createdBy: string | null;
  lines: LineInput[];
}

/**
 * Posts a balanced journal entry. Zero lines are dropped; a debit and credit are normalised so a
 * negative amount flips side. The database re-checks balance, accounts and currencies at commit.
 */
export async function post(c: Executor, e: EntryInput): Promise<{ id: string; created: boolean }> {
  const existing = (await c.query<{ id: string }>('SELECT id FROM journal_entries WHERE idempotency_key = $1', [e.idempotencyKey])).rows[0];
  if (existing) return { id: existing.id, created: false };

  const lines = e.lines.flatMap((l) => {
    const net = toUnits(l.debit ?? '0') - toUnits(l.credit ?? '0');
    if (net === 0n) return [];
    return [{ ...l, debit: net > 0n ? fromUnits(net) : '0', credit: net < 0n ? fromUnits(-net) : '0' }];
  });
  const byCurrency = new Map<string, bigint>();
  for (const l of lines) byCurrency.set(l.currency, (byCurrency.get(l.currency) ?? 0n) + toUnits(l.debit) - toUnits(l.credit));
  if ([...byCurrency.values()].some((v) => v !== 0n)) throw new AppError('INTERNAL_ERROR', 500, { reason: 'unbalanced entry', sourceType: e.sourceType });
  if (lines.length < 2) return { id: '', created: false }; // nothing to record (e.g. zero amounts)

  const id = (await c.query<{ id: string }>(
    `INSERT INTO journal_entries (country_id, description, source_type, source_id, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [e.countryId, e.description, e.sourceType, e.sourceId, e.idempotencyKey, e.createdBy])).rows[0]!.id;
  for (const l of lines) {
    await c.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, currency_code, provider_id, booking_id, payment_id, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, l.accountId, l.debit, l.credit, l.currency, l.providerId ?? null, l.bookingId ?? null, l.paymentId ?? null, l.memo ?? null]);
  }
  return { id, created: true };
}

/**
 * Balance in the account's natural sign: debit-positive for assets, expenses and the direct-payments
 * memo; credit-positive for liabilities, revenue and the memo contra.
 */
export const NATURAL_SIGN_SQL = `CASE WHEN a.type IN ('asset', 'expense') OR a.kind = 'direct_payments_memo' THEN 1 ELSE -1 END`;
