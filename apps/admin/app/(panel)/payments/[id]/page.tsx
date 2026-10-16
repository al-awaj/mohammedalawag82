'use client';
import Link from 'next/link';
import { use } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, DateTime, Detail, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';

interface Payment {
  id: string; number: string; orderId: string; model: string; method: string; purpose: string; amount: string; currency: string; reportedAmount: string | null; verifiedAmount: string | null;
  gatewayFee: string; status: string; failureReason: string | null; needsAttention: string | null; reviewNote: string | null; verifiedAt: string | null; succeededAt: string | null; createdAt: string;
  externalRef: string | null; receivedCurrency: string | null; receivedAmount: string | null; fxRate: string | null; fxRateAt: string | null;
  fxRateSource: string | null; convertedAmount: string | null; fxConversionFee: string; fxDifference: string; allocations: { bookingId: string; amount: string; verifiedAmount: string | null }[];
  history: { from: string | null; to: string; actorKind: string; reason: string | null; at: string }[];
  proofs: { id: string; mimeType: string; sizeBytes: number; createdAt: string }[]; ledgerEntries: { number: string; description: string; occurredAt: string }[];
}

export default function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const can = useCan();
  const { data: p, error, isLoading } = useGet<Payment>(`/v1/admin/payments/${id}`);
  if (isLoading) return <Loading />;
  if (error || !p) return <ErrorBox error={error} />;
  return (
    <Page title={`${tr({ ar: 'دفعة', en: 'Payment' })} ${p.number}`} actions={can('payments.review') && p.status === 'awaiting_verification' ? (
      <ActionButton variant="primary" label={tr({ ar: 'مراجعة الإثبات', en: 'Review proof' })}
        note={tr({ ar: 'سجّل المبلغ الذي وصل فعلًا حسب كشف الحساب، لا المبلغ الذي أبلغ عنه العميل.', en: 'Record the amount that actually arrived per the statement, not what the customer reported.' })}
        fields={[
          { name: 'decision', label: { ar: 'القرار', en: 'Decision' }, type: 'select', required: true, options: [{ value: 'approve', label: { ar: 'اعتماد', en: 'Approve' } }, { value: 'reject', label: { ar: 'رفض', en: 'Reject' } }] },
          { name: 'verifiedAmount', label: { ar: 'المبلغ المتحقق منه', en: 'Verified amount' }, type: 'decimal', defaultValue: p.reportedAmount ?? undefined },
          { name: 'note', label: { ar: 'ملاحظة المراجعة', en: 'Review note' }, type: 'textarea', required: true },
          { name: 'receivedCurrency', label: { ar: 'وصل بعملة أخرى؟ العملة (مثل USD)', en: 'Arrived in another currency? Currency (e.g. USD)' }, placeholder: 'USD' },
          { name: 'receivedAmount', label: { ar: 'المبلغ الذي وصل بتلك العملة', en: 'Amount received in that currency' }, type: 'decimal' },
          { name: 'rate', label: { ar: 'سعر الصرف (فارغ = آخر سعر معتمد)', en: 'Exchange rate (empty = latest published)' }, type: 'decimal' },
          { name: 'rateSource', label: { ar: 'مصدر السعر إن أدخلته', en: 'Rate source if entered' } },
          { name: 'conversionFee', label: { ar: 'رسوم التحويل الفعلية (بعملة الحجز)', en: 'Actual conversion fee (booking currency)' }, type: 'decimal' },
        ]}
        run={(api, v) => {
          const { receivedCurrency, receivedAmount, rate, rateSource, conversionFee, ...rest } = v;
          const received = receivedCurrency && receivedAmount ? {
            currency: String(receivedCurrency).toUpperCase(), amount: receivedAmount,
            ...(rate ? { rate } : {}), ...(rateSource ? { rateSource } : {}), ...(conversionFee ? { conversionFee } : {}),
          } : undefined;
          return api.post(`/v1/admin/payments/${id}/review`, { ...rest, ...(received ? { received } : {}) });
        }} />
    ) : null}>
      {p.needsAttention && <Notice kind="warning">{tr({ ar: 'تحتاج متابعة:', en: 'Needs attention:' })} {p.needsAttention}</Notice>}
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="payment" value={p.status} />],
          [tr({ ar: 'النموذج', en: 'Model' }), <Badge key="m" group="paymentModel" value={p.model} />],
          [tr({ ar: 'الطريقة', en: 'Method' }), <Badge key="me" group="paymentMethod" value={p.method} />],
          [tr({ ar: 'الغرض', en: 'Purpose' }), p.purpose === 'upfront' ? tr({ ar: 'عربون/مقدم', en: 'Upfront' }) : tr({ ar: 'المتبقي', en: 'Balance' })],
          [tr({ ar: 'المطلوب', en: 'Amount' }), <Money key="a" amount={p.amount} currency={p.currency} />],
          [tr({ ar: 'أبلغ عنه العميل', en: 'Reported by customer' }), <Money key="r" amount={p.reportedAmount} currency={p.currency} />],
          [tr({ ar: 'المتحقق منه', en: 'Verified' }), <Money key="v" amount={p.verifiedAmount} currency={p.currency} />],
          [tr({ ar: 'رسوم مزود الدفع', en: 'Provider fee' }), <Money key="f" amount={p.gatewayFee} currency={p.currency} />],
          [tr({ ar: 'المرجع الخارجي', en: 'External reference' }), <code key="x">{p.externalRef ?? '—'}</code>],
          [tr({ ar: 'سبب الفشل', en: 'Failure reason' }), p.failureReason],
          [tr({ ar: 'ملاحظة المراجعة', en: 'Review note' }), p.reviewNote],
          [tr({ ar: 'تاريخ النجاح', en: 'Succeeded' }), <DateTime key="d" value={p.succeededAt} />],
        ]} />
      </Card>
      {p.receivedCurrency && (
        <Card title={tr({ ar: 'تحويل العملة', en: 'Currency conversion' })}>
          <Detail items={[
            [tr({ ar: 'المبلغ الأصلي', en: 'Original amount' }), <Money key="o" amount={p.receivedAmount} currency={p.receivedCurrency} />],
            [tr({ ar: 'سعر الصرف', en: 'Exchange rate' }), p.fxRate],
            [tr({ ar: 'تاريخ السعر', en: 'Rate date' }), <DateTime key="rd" value={p.fxRateAt} />],
            [tr({ ar: 'مصدر السعر', en: 'Rate source' }), p.fxRateSource],
            [tr({ ar: 'المبلغ المحوّل', en: 'Converted amount' }), <Money key="c" amount={p.convertedAmount} currency={p.currency} />],
            [tr({ ar: 'رسوم التحويل', en: 'Conversion fee' }), <Money key="cf" amount={p.fxConversionFee} currency={p.currency} />],
            [tr({ ar: 'فرق الصرف (موجب = خسارة)', en: 'Exchange difference (positive = loss)' }), <Money key="d" amount={p.fxDifference} currency={p.currency} />],
          ]} />
        </Card>
      )}
      <Card title={tr({ ar: 'التوزيع على الحجوزات', en: 'Applied to bookings' })}>
        <DataTable rowKey="bookingId" rows={p.allocations} columns={[
          { key: 'bookingId', label: { ar: 'الحجز', en: 'Booking' }, render: (a) => <Link href={`/bookings/${a.bookingId}`}>{a.bookingId.slice(0, 8)}</Link> },
          { key: 'amount', label: { ar: 'المطلوب', en: 'Requested' }, render: (a) => <Money amount={a.amount} currency={p.currency} /> },
          { key: 'verifiedAmount', label: { ar: 'المتحقق', en: 'Verified' }, render: (a) => <Money amount={a.verifiedAmount} currency={p.currency} /> },
        ]} />
      </Card>
      {p.proofs.length > 0 && <Card title={tr({ ar: 'إثباتات الدفع', en: 'Payment proofs' })}>
        <DataTable rows={p.proofs} columns={[
          { key: 'mimeType', label: { ar: 'الملف', en: 'File' }, render: (f) => <a href={`/bff/v1/admin/payments/${id}/proofs/${f.id}`} target="_blank" rel="noopener noreferrer">{f.mimeType}</a> },
          { key: 'createdAt', label: { ar: 'رُفع', en: 'Uploaded' }, render: (f) => <DateTime value={f.createdAt} /> },
        ]} />
      </Card>}
      <Card title={tr({ ar: 'القيود المحاسبية', en: 'Ledger entries' })}>
        <DataTable rowKey="number" rows={p.ledgerEntries} columns={[
          { key: 'number', label: { ar: 'القيد', en: 'Entry' } },
          { key: 'description', label: { ar: 'البيان', en: 'Description' } },
          { key: 'occurredAt', label: { ar: 'التاريخ', en: 'Date' }, render: (e) => <DateTime value={e.occurredAt} /> },
        ]} />
      </Card>
      <Card title={tr({ ar: 'السجل', en: 'History' })}>
        <DataTable rows={p.history.map((h, i) => ({ ...h, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (h) => <DateTime value={h.at} /> },
          { key: 'to', label: { ar: 'إلى', en: 'To' }, render: (h) => <Badge group="payment" value={h.to} /> },
          { key: 'actorKind', label: { ar: 'بواسطة', en: 'By' } },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
        ]} />
      </Card>
    </Page>
  );
}
