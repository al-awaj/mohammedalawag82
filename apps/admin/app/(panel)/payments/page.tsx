'use client';
import { useSearchParams } from 'next/navigation';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; number: string; model: string; method: string; purpose: string; amount: string; verifiedAmount: string | null; reportedAmount: string | null; currency: string; status: string; needsAttention: string | null; customerName: string; proofCount: number; createdAt: string };

export default function Payments() {
  const tr = useTr();
  const sp = useSearchParams();
  const initial = Object.fromEntries(['orderId', 'status', 'needsAttention'].map((k) => [k, sp.get(k) ?? '']).filter(([, v]) => v));
  return (
    <Page title={tr({ ar: 'المدفوعات', en: 'Payments' })}>
      <ListView<Row>
        path="/v1/admin/payments"
        initialFilters={initial}
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('payment') },
          { name: 'needsAttention', label: tr({ ar: 'تحتاج متابعة', en: 'Needs attention' }), type: 'checkbox' },
        ]}
        rowHref={(r) => `/payments/${r.id}`}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'customerName', label: { ar: 'العميل', en: 'Customer' } },
          { key: 'model', label: { ar: 'النموذج', en: 'Model' }, render: (r) => <Badge group="paymentModel" value={r.model} /> },
          { key: 'method', label: { ar: 'الطريقة', en: 'Method' }, render: (r) => <Badge group="paymentMethod" value={r.method} /> },
          { key: 'amount', label: { ar: 'المطلوب', en: 'Amount' }, render: (r) => <Money amount={r.amount} currency={r.currency} /> },
          { key: 'verifiedAmount', label: { ar: 'المتحقق منه', en: 'Verified' }, render: (r) => <Money amount={r.verifiedAmount} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="payment" value={r.status} /> },
          { key: 'needsAttention', label: { ar: 'متابعة', en: 'Attention' }, render: (r) => (r.needsAttention ? <span className="badge badge-warn">{r.needsAttention}</span> : '—') },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
        ]}
      />
    </Page>
  );
}
