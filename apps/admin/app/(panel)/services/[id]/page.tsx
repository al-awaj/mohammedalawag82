'use client';
import { use } from 'react';
import { useApp, useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, Detail, ErrorBox, Json, Loading, Money, Page, reasonField, Text } from '@events/web-kit/ui';
import { localized } from '@events/shared';

interface Service {
  id: string; title: Record<string, string>; description: Record<string, string>; terms: Record<string, string> | null; status: string; statusReason: string | null;
  basePrice: string; currency: string; pricingUnit: string; capacity: number | null; requiresProviderApproval: boolean; depositType: string; depositValue: string;
  city: string; countryCode: string; providerName: string; providerStatus: string; typeName: Record<string, string>; bookingMode: string;
  attributes: Record<string, unknown>; fields: { key: string; label: Record<string, string>; isPublic: boolean }[];
  cancellationPolicy: unknown; packages: { id: string; name: Record<string, string>; price: string; currency: string; status: string }[];
  rentalItems: { id: string; name: Record<string, string>; quantityTotal: number; pricePerDay: string | null; currency: string; status: string }[];
  media: { id: string; kind: string; mimeType: string; caption: string | null; url: string }[]; rating: { average: string | null; count: number };
}

// Mirrors the API's moderation table (the API is authoritative).
const ACTIONS: Record<string, string[]> = {
  draft: ['suspend'], pending_review: ['publish', 'reject', 'suspend'], published: ['unpublish', 'suspend'], unpublished: ['suspend'], suspended: ['reinstate'],
};
const PERMS: Record<string, string> = { publish: 'services.publish', reject: 'services.publish', unpublish: 'services.unpublish', suspend: 'services.unpublish', reinstate: 'services.publish' };
const LABELS: Record<string, { ar: string; en: string }> = {
  publish: { ar: 'اعتماد ونشر', en: 'Approve & publish' }, reject: { ar: 'رفض', en: 'Reject' }, unpublish: { ar: 'إلغاء النشر', en: 'Unpublish' },
  suspend: { ar: 'إيقاف', en: 'Suspend' }, reinstate: { ar: 'إعادة', en: 'Reinstate' },
};

export default function ServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const { lang } = useApp();
  const can = useCan();
  const { data: s, error, isLoading } = useGet<Service>(`/v1/admin/services/${id}`);
  if (isLoading) return <Loading />;
  if (error || !s) return <ErrorBox error={error} />;
  return (
    <Page title={localized(s.title, lang)} actions={(ACTIONS[s.status] ?? []).filter((a) => can(PERMS[a]!)).map((a) => (
      <ActionButton key={a} label={tr(LABELS[a]!)} variant={a === 'publish' ? 'primary' : 'secondary'}
        fields={[reasonField(a !== 'publish')]}
        run={(api, v) => api.post(`/v1/admin/services/${id}/actions`, { action: a, ...v })} />
    ))}>
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <span key="s"><Badge group="service" value={s.status} /> {s.statusReason}</span>],
          [tr({ ar: 'صاحب الخدمة', en: 'Provider' }), `${s.providerName} (${s.providerStatus})`],
          [tr({ ar: 'النوع', en: 'Type' }), <Text key="t" value={s.typeName} />],
          [tr({ ar: 'الموقع', en: 'Location' }), `${s.countryCode} · ${s.city}`],
          [tr({ ar: 'السعر الأساسي', en: 'Base price' }), <span key="p"><Money amount={s.basePrice} currency={s.currency} /> / {s.pricingUnit}</span>],
          [tr({ ar: 'العربون', en: 'Deposit' }), `${s.depositType} ${s.depositValue}`],
          [tr({ ar: 'يتطلب موافقة صاحب الخدمة', en: 'Provider approval required' }), s.requiresProviderApproval ? '✓' : '✗'],
          [tr({ ar: 'السعة', en: 'Capacity' }), s.capacity ?? '—'],
          [tr({ ar: 'التقييم', en: 'Rating' }), s.rating.average ? `${s.rating.average} (${s.rating.count})` : '—'],
        ]} />
        <p><Text value={s.description} /></p>
        {s.terms && <p className="muted"><Text value={s.terms} /></p>}
      </Card>
      <Card title={tr({ ar: 'الحقول الديناميكية', en: 'Type-specific fields' })}><Json value={s.attributes} /></Card>
      <Card title={tr({ ar: 'الصور والفيديو', en: 'Media' })}>
        <div className="row gap">
          {s.media.map((m) => m.kind === 'image'
            ? <img key={m.id} src={`/bff/v1/media/${m.id}`} alt={m.caption ?? ''} style={{ width: 160, height: 110, objectFit: 'cover', borderRadius: 8 }} />
            : <a key={m.id} href={`/bff/v1/media/${m.id}`} target="_blank" rel="noopener noreferrer">{m.mimeType}</a>)}
        </div>
      </Card>
      {s.packages.length > 0 && (
        <Card title={tr({ ar: 'الباقات', en: 'Packages' })}>
          <DataTable rows={s.packages} columns={[
            { key: 'name', label: { ar: 'الباقة', en: 'Package' }, render: (p) => <Text value={p.name} /> },
            { key: 'price', label: { ar: 'السعر', en: 'Price' }, render: (p) => <Money amount={p.price} currency={p.currency} /> },
            { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
          ]} />
        </Card>
      )}
      {s.rentalItems.length > 0 && (
        <Card title={tr({ ar: 'عناصر التأجير', en: 'Rental items' })}>
          <DataTable rows={s.rentalItems} columns={[
            { key: 'name', label: { ar: 'العنصر', en: 'Item' }, render: (p) => <Text value={p.name} /> },
            { key: 'quantityTotal', label: { ar: 'الكمية', en: 'Quantity' } },
            { key: 'pricePerDay', label: { ar: 'السعر اليومي', en: 'Per day' }, render: (p) => <Money amount={p.pricePerDay} currency={p.currency} /> },
            { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
          ]} />
        </Card>
      )}
      <Card title={tr({ ar: 'سياسة الإلغاء', en: 'Cancellation policy' })}>{s.cancellationPolicy ? <Json value={s.cancellationPolicy} /> : '—'}</Card>
    </Page>
  );
}
