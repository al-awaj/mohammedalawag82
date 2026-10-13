'use client';
import Link from 'next/link';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { Card, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';

interface Overview {
  rows: Record<string, string | number>[];
  counts?: { countryId: string; countryCode: string; customers: number; providers: number; publishedServices: number; openDisputes: number; closedDisputes: number }[];
  notes: string[];
}

export default function Dashboard() {
  const tr = useTr();
  const can = useCan();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<Overview>(can('reports.view') ? '/v1/admin/reports/overview' : null);
  const queue = (path: string, perm: string, label: { ar: string; en: string }, query?: Record<string, string>) =>
    can(perm) ? <QueueCard path={path} query={query} label={tr(label)} /> : null;
  return (
    <Page title={tr({ ar: 'لوحة المتابعة', en: 'Dashboard' })}>
      <div className="grid">
        {queue('/v1/admin/provider-applications', 'provider_applications.view', { ar: 'طلبات تسجيل بانتظار المراجعة', en: 'Applications awaiting review' }, { status: 'submitted' })}
        {queue('/v1/admin/payments', 'finance.view', { ar: 'مدفوعات بانتظار التحقق', en: 'Payments awaiting verification' }, { status: 'awaiting_verification' })}
        {queue('/v1/admin/payments', 'finance.view', { ar: 'مدفوعات تحتاج متابعة', en: 'Payments needing attention' }, { needsAttention: 'true' })}
        {queue('/v1/admin/refunds', 'refunds.execute', { ar: 'استردادات بانتظار الاعتماد', en: 'Refunds awaiting approval' }, { status: 'requested' })}
        {queue('/v1/admin/disputes', 'disputes.view', { ar: 'نزاعات جديدة', en: 'New disputes' }, { status: 'new' })}
        {queue('/v1/admin/cancellation-requests', 'bookings.cancel', { ar: 'طلبات إلغاء معلقة', en: 'Pending cancellation requests' }, { status: 'pending' })}
      </div>
      {!can('reports.view') ? null : isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : data && (
        <>
          <Notice>{tr({ ar: 'قيمة الحجوزات ليست إيرادًا للمنصة؛ إيراد المنصة هو العمولة المعترف بها. الأرقام لكل دولة وعملة على حدة.', en: 'Booking value is not platform revenue; platform revenue is the recognised commission. Figures are per country and currency.' })}</Notice>
          {data.rows.map((r) => (
            <Card key={`${r.countryId}-${r.currency}`} title={`${countries.code(String(r.countryId))} · ${r.currency}`}>
              <div className="grid">
                <Stat label={tr({ ar: 'حجوزات مؤكدة/جارية', en: 'Confirmed / in progress' })} value={String(r.bookingsConfirmed)} />
                <Stat label={tr({ ar: 'حجوزات مكتملة', en: 'Completed' })} value={String(r.bookingsCompleted)} />
                <Stat label={tr({ ar: 'بانتظار موافقة/دفع', en: 'Pending approval/payment' })} value={String(r.bookingsPending)} />
                <Stat label={tr({ ar: 'ملغاة', en: 'Cancelled' })} value={String(r.bookingsCancelled)} />
                <Stat label={tr({ ar: 'قيمة الحجوزات', en: 'Bookings value' })} value={<Money amount={String(r.bookingsValue)} currency={String(r.currency)} />} />
                <Stat label={tr({ ar: 'المدفوع', en: 'Paid' })} value={<Money amount={String(r.paid)} currency={String(r.currency)} />} />
                <Stat label={tr({ ar: 'المتبقي على العملاء', en: 'Remaining from customers' })} value={<Money amount={String(r.remaining)} currency={String(r.currency)} />} />
                <Stat label={tr({ ar: 'إيراد العمولات', en: 'Commission revenue' })} value={<Money amount={String(r.commissionRevenue)} currency={String(r.currency)} />} />
                <Stat label={tr({ ar: 'المسترد', en: 'Refunded' })} value={<Money amount={String(r.refunded)} currency={String(r.currency)} />} />
                <Stat label={tr({ ar: 'مستحقات أصحاب الخدمات', en: 'Provider earnings due' })} value={<Money amount={String(r.providerEarningsDue)} currency={String(r.currency)} />} />
                <Stat label={tr({ ar: 'معلق بسبب نزاعات', en: 'On hold (disputes)' })} value={<Money amount={String(r.providerEarningsOnHold)} currency={String(r.currency)} />} />
                <Stat label={tr({ ar: 'مدفوعات فاشلة', en: 'Failed payments' })} value={String(r.failedPayments)} />
              </div>
            </Card>
          ))}
          {data.counts && data.counts.length > 0 && (
            <Card title={tr({ ar: 'الدول', en: 'Countries' })}>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>{tr({ ar: 'الدولة', en: 'Country' })}</th><th>{tr({ ar: 'العملاء', en: 'Customers' })}</th><th>{tr({ ar: 'أصحاب الخدمات', en: 'Providers' })}</th><th>{tr({ ar: 'خدمات منشورة', en: 'Published services' })}</th><th>{tr({ ar: 'نزاعات مفتوحة', en: 'Open disputes' })}</th></tr></thead>
                <tbody>{data.counts.map((c) => <tr key={c.countryId}><td>{c.countryCode}</td><td>{c.customers}</td><td>{c.providers}</td><td>{c.publishedServices}</td><td>{c.openDisputes}</td></tr>)}</tbody>
              </table></div>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div></div>;
}

const LINKS: Record<string, string> = {
  '/v1/admin/provider-applications': '/applications', '/v1/admin/payments': '/payments', '/v1/admin/refunds': '/refunds',
  '/v1/admin/disputes': '/disputes', '/v1/admin/cancellation-requests': '/cancellation-requests',
};
function QueueCard({ path, query, label }: { path: string; query?: Record<string, string>; label: string }) {
  const { data } = useGet<unknown>(path, { ...query, limit: 200 });
  const n = Array.isArray(data) ? data.length : (data as { total?: number } | undefined)?.total;
  return (
    <Link href={LINKS[path] ?? '/'} className="stat" style={{ color: 'inherit' }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{n === undefined ? '…' : n === 200 ? '200+' : n}</div>
    </Link>
  );
}
