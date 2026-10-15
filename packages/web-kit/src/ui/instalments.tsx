'use client';
import { useTr } from '../client';
import { Card, DateTime, Money } from './basics';

export interface Instalment { seq: number; percent: string; amount: string; dueAt: string }

/** Decimal string to integer ten-thousandths, so comparisons stay exact. */
const units = (v: string) => {
  const [i = '0', f = ''] = v.split('.');
  return BigInt(i) * 10000n + BigInt((f + '0000').slice(0, 4));
};

/**
 * The booking's frozen instalment schedule (clause 46): the deposit first, then each instalment with its due date,
 * marked paid once verified payments cover it.
 */
export function InstalmentSchedule({ plan, upfrontAmount, paidAmount, currency }: { plan: Instalment[] | null | undefined; upfrontAmount: string; paidAmount: string; currency: string }) {
  const tr = useTr();
  if (!plan?.length) return null;
  const paid = units(paidAmount);
  let target = units(upfrontAmount);
  const rows = [{ key: 'upfront', label: tr({ ar: 'العربون / المقدم', en: 'Deposit / upfront' }), amount: upfrontAmount, dueAt: null as string | null, done: paid >= target }];
  for (const i of [...plan].sort((a, b) => a.seq - b.seq)) {
    target += units(i.amount);
    rows.push({ key: String(i.seq), label: `${tr({ ar: 'القسط', en: 'Instalment' })} ${i.seq} (${i.percent}%)`, amount: i.amount, dueAt: i.dueAt, done: paid >= target });
  }
  return (
    <Card title={tr({ ar: 'جدول الدفعات', en: 'Payment schedule' })}>
      <div className="table-wrap"><table className="table" data-testid="instalments">
        <thead><tr><th>{tr({ ar: 'الدفعة', en: 'Payment' })}</th><th>{tr({ ar: 'المبلغ', en: 'Amount' })}</th><th>{tr({ ar: 'الاستحقاق', en: 'Due' })}</th><th>{tr({ ar: 'الحالة', en: 'Status' })}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td><Money amount={r.amount} currency={currency} /></td>
              <td>{r.dueAt ? <DateTime value={r.dueAt} dateOnly /> : tr({ ar: 'عند الحجز', en: 'At booking' })}</td>
              <td><span className={`badge badge-${r.done ? 'ok' : 'warn'}`}>{r.done ? tr({ ar: 'مدفوع', en: 'Paid' }) : tr({ ar: 'غير مدفوع', en: 'Unpaid' })}</span></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Card>
  );
}
