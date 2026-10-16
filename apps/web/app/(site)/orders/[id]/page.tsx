'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { enumLabel, formatDateTime, localized } from '@events/shared';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Button, Card, DataTable, DateTime, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';
import { RequireCustomer } from '@/lib/account';

type Booking = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; upfrontAmount: string; paidAmount: string; remainingAmount: string; currency: string; holdExpiresAt: string | null; approvalDeadline: string | null; balanceDueAt: string | null };
type Order = { id: string; number: string; currency: string; total: string; upfrontTotal: string; bookings: Booking[] };
type Option = { purpose: 'upfront' | 'balance'; model: 'platform' | 'direct'; method: string; proofRequired: boolean; currency: string; bookingIds: string[]; amount: string; minAmount: string | null; nextInstalmentAmount: string | null };
type Payment = { id: string; number: string; model: string; method: string; purpose: string; amount: string; currency: string; status: string; checkoutUrl: string | null; instructions: Record<string, string> | null; reportedAmount: string | null; verifiedAmount: string | null; failureReason: string | null; proofCount: number; createdAt: string };

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequireCustomer><OrderView id={id} /></RequireCustomer>;
}

function OrderView({ id }: { id: string }) {
  const tr = useTr();
  const { api, lang } = useApp();
  const order = useGet<Order>(`/v1/orders/${id}`, undefined, { refetchInterval: 10_000 });
  const options = useGet<Option[]>(`/v1/orders/${id}/payment-options`);
  const payments = useGet<Payment[]>(`/v1/orders/${id}/payments`, undefined, { refetchInterval: 5_000 });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (order.isLoading) return <Loading />;
  if (order.error || !order.data) return <ErrorBox error={order.error} />;
  const o = order.data;
  const inProgress = (payments.data ?? []).filter((p) => p.status === 'pending' || p.status === 'awaiting_verification');
  const start = async (opt: Option, amount?: string) => {
    setBusy(true); setErr(null);
    try {
      const p = await api.post<Payment>(`/v1/orders/${id}/payments`, { model: opt.model, method: opt.method, purpose: opt.purpose, bookingIds: opt.bookingIds, ...(amount && amount !== opt.amount ? { amount } : {}) }, { 'idempotency-key': crypto.randomUUID() });
      await payments.refetch(); await options.refetch();
      if (p.checkoutUrl && opt.method !== 'bank_transfer') window.open(p.checkoutUrl, '_blank', 'noopener');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Page title={`${tr({ ar: 'الطلب', en: 'Order' })} ${o.number}`}>
      <ErrorBox error={err ?? options.error ?? payments.error} />
      <Card title={tr({ ar: 'الحجوزات', en: 'Bookings' })}>
        <DataTable rows={o.bookings} rowHref={(b) => `/account/bookings/${b.id}`} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (b) => localized(b.serviceTitle, lang) },
          { key: 'startAt', label: { ar: 'الموعد', en: 'Date' }, render: (b) => <DateTime value={b.startAt} /> },
          { key: 'total', label: { ar: 'الإجمالي', en: 'Total' }, render: (b) => <Money amount={b.total} currency={b.currency} /> },
          { key: 'paidAmount', label: { ar: 'المدفوع', en: 'Paid' }, render: (b) => <Money amount={b.paidAmount} currency={b.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (b) => <Badge group="booking" value={b.status} /> },
          { key: 'deadline', label: { ar: 'المهلة', en: 'Deadline' }, render: (b) => b.status === 'awaiting_payment' && b.holdExpiresAt ? <span className="badge badge-warn">{tr({ ar: 'ادفع قبل', en: 'Pay before' })} {formatDateTime(b.holdExpiresAt, lang)}</span>
            : b.status === 'pending_provider_approval' ? <span className="muted small">{tr({ ar: 'بانتظار تأكيد صاحب الخدمة', en: 'Waiting for the provider' })}</span> : '—' },
        ]} />
      </Card>
      <Card title={tr({ ar: 'الدفع', en: 'Payment' })}>
        {inProgress.length > 0 && <Notice>{tr({ ar: 'لديك دفعة قيد المعالجة؛ تتحدث الحالة تلقائيًا.', en: 'A payment is in progress; the status updates automatically.' })}</Notice>}
        {inProgress.filter((p) => p.instructions).map((p) => (
          <Notice key={p.id} kind="warning"><strong>{p.number}:</strong> {localized(p.instructions, lang)} — <Money amount={p.amount} currency={p.currency} /></Notice>
        ))}
        {!options.data?.length ? <p className="muted">{tr({ ar: 'لا يوجد مبلغ مستحق الآن.', en: 'Nothing is due right now.' })}</p> : (
          <div className="grid">
            {options.data.map((opt, i) => (
              <div key={i} className="stat">
                <div className="stat-label">{opt.purpose === 'upfront' ? tr({ ar: 'العربون / المبلغ المقدم', en: 'Deposit / upfront' }) : tr({ ar: 'المبلغ المتبقي', en: 'Remaining balance' })}</div>
                <div className="stat-value"><Money amount={opt.amount} currency={opt.currency} /></div>
                <div className="small muted">{enumLabel('paymentMethod', opt.method, lang)} · {enumLabel('paymentModel', opt.model, lang)}</div>
                {opt.purpose === 'balance' && (opt.nextInstalmentAmount || (opt.minAmount && opt.minAmount !== opt.amount))
                  ? <PartialPay opt={opt} busy={busy} onPay={(a) => start(opt, a)} />
                  : <Button variant="primary" disabled={busy} onClick={() => start(opt)}>{tr({ ar: 'ادفع بهذه الطريقة', en: 'Pay this way' })}</Button>}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title={tr({ ar: 'المدفوعات', en: 'Payments' })}>
        <DataTable rows={payments.data ?? []} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'method', label: { ar: 'الطريقة', en: 'Method' }, render: (p) => <Badge group="paymentMethod" value={p.method} /> },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (p) => <Money amount={p.amount} currency={p.currency} /> },
          { key: 'verifiedAmount', label: { ar: 'المستلم', en: 'Received' }, render: (p) => <Money amount={p.verifiedAmount} currency={p.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (p) => <Badge group="payment" value={p.status} /> },
          { key: 'action', label: '', render: (p) => p.status === 'pending' && p.checkoutUrl ? (
            <a className="btn btn-secondary" href={p.checkoutUrl} target="_blank" rel="noopener noreferrer">{tr({ ar: 'إكمال الدفع', en: 'Complete payment' })}</a>
          ) : p.status === 'awaiting_verification' || (p.status === 'pending' && p.method === 'bank_transfer') ? (
            <ActionButton label={tr({ ar: 'رفع إثبات التحويل', en: 'Upload transfer proof' })}
              note={tr({ ar: 'يراجع فريق المالية الإثبات ويؤكد المبلغ الذي وصل فعلًا.', en: 'The finance team reviews the proof and confirms the amount actually received.' })}
              fields={[{ name: 'file', label: { ar: 'صورة أو PDF', en: 'Image or PDF' }, type: 'file', required: true }]}
              run={(a, v) => { const f = new FormData(); f.append('file', v.file as File); return a.upload(`/v1/payments/${p.id}/proofs`, f); }} />
          ) : p.failureReason },
          { key: 'cancel', label: '', render: (p) => p.status === 'pending' ? <ActionButton variant="ghost" label={tr({ ar: 'إلغاء', en: 'Cancel' })} run={(a) => a.post(`/v1/payments/${p.id}/cancel`)} /> : null },
        ]} />
        <p className="small muted">{tr({ ar: 'لا تُعتبر الدفعة مكتملة إلا بعد تأكيدها من مزود الدفع أو من فريق المالية.', en: 'A payment counts only once confirmed by the payment provider or the finance team.' })}</p>
      </Card>
      <p><Link href="/account/bookings">{tr({ ar: 'كل حجوزاتي', en: 'All my bookings' })}</Link></p>
    </Page>
  );
}

/** Paying part of the balance: the next instalment, the full remainder, or any amount from the admin's minimum (clauses 46-47). */
function PartialPay({ opt, busy, onPay }: { opt: Option; busy: boolean; onPay: (amount: string) => void }) {
  const tr = useTr();
  const [amount, setAmount] = useState(opt.nextInstalmentAmount ?? opt.amount);
  const flexible = !!opt.minAmount && opt.minAmount !== opt.amount;
  return (
    <div className="partial-pay" data-testid="partial-pay">
      <div className="row gap wrap">
        {opt.nextInstalmentAmount && <button type="button" className={`pick${amount === opt.nextInstalmentAmount ? ' pick-active' : ''}`} onClick={() => setAmount(opt.nextInstalmentAmount!)}>
          {tr({ ar: 'القسط التالي', en: 'Next instalment' })}: <Money amount={opt.nextInstalmentAmount} currency={opt.currency} /></button>}
        <button type="button" className={`pick${amount === opt.amount ? ' pick-active' : ''}`} onClick={() => setAmount(opt.amount)}>
          {tr({ ar: 'كامل المتبقي', en: 'Full balance' })}</button>
      </div>
      {flexible && (
        <label className="field">
          <span>{tr({ ar: 'أو أدخل مبلغًا', en: 'Or enter an amount' })}</span>
          <input id="f-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
          <small className="muted">{tr({ ar: 'الحد الأدنى', en: 'Minimum' })} <Money amount={opt.minAmount} currency={opt.currency} /></small>
        </label>
      )}
      <Button variant="primary" disabled={busy || !amount} onClick={() => onPay(amount)}>{tr({ ar: 'ادفع', en: 'Pay' })} {/^\d+(\.\d+)?$/.test(amount) && <Money amount={amount} currency={opt.currency} />}</Button>
    </div>
  );
}
