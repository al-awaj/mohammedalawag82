'use client';
import Link from 'next/link';
import { useGet, useTr } from '@events/web-kit/client';
import { Badge, Card, DataTable, DateTime, Money, Page, Text } from '@events/web-kit/ui';

type Booking = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; paidAmount: string; currency: string; customerName: string; approvalDeadline: string | null };
type Summary = { rows: { serviceId: string; serviceTitle: Record<string, string>; currency: string; bookings: number; completed: number; net: string; settled: string; outstanding: string; rating: string | null }[] };

export default function Dashboard() {
  const tr = useTr();
  const pending = useGet<Booking[]>('/v1/provider/bookings', { status: 'pending_provider_approval', when: 'all' }).data ?? [];
  const upcoming = useGet<Booking[]>('/v1/provider/bookings', { when: 'upcoming', limit: 10 }).data ?? [];
  const summary = useGet<Summary>('/v1/provider/reports/summary').data;
  const cols = [
    { key: 'number', label: { ar: 'الحجز', en: 'Booking' } },
    { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (b: Booking) => <Text value={b.serviceTitle} /> },
    { key: 'customerName', label: { ar: 'العميل', en: 'Customer' } },
    { key: 'startAt', label: { ar: 'الموعد', en: 'Date' }, render: (b: Booking) => <DateTime value={b.startAt} /> },
    { key: 'total', label: { ar: 'الإجمالي', en: 'Total' }, render: (b: Booking) => <Money amount={b.total} currency={b.currency} /> },
    { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (b: Booking) => <Badge group="booking" value={b.status} /> },
  ];
  return (
    <Page title={tr({ ar: 'لوحة المتابعة', en: 'Dashboard' })}>
      {pending.length > 0 && (
        <Card title={tr({ ar: 'حجوزات بانتظار موافقتك', en: 'Bookings awaiting your approval' })}>
          <DataTable rows={pending} rowHref={(b) => `/bookings/${b.id}`} columns={[...cols, { key: 'approvalDeadline', label: { ar: 'آخر موعد للرد', en: 'Respond by' }, render: (b: Booking) => <DateTime value={b.approvalDeadline} /> }]} />
        </Card>
      )}
      <Card title={tr({ ar: 'الحجوزات القادمة', en: 'Upcoming bookings' })} actions={<Link href="/bookings">{tr({ ar: 'الكل', en: 'All' })}</Link>}>
        <DataTable rows={upcoming} rowHref={(b) => `/bookings/${b.id}`} columns={cols} />
      </Card>
      <Card title={tr({ ar: 'أداء الخدمات', en: 'Service performance' })} actions={<Link href="/reports">{tr({ ar: 'التقارير', en: 'Reports' })}</Link>}>
        <DataTable rowKey="serviceId" rows={summary?.rows ?? []} columns={[
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (r) => <Text value={r.serviceTitle} /> },
          { key: 'bookings', label: { ar: 'الحجوزات', en: 'Bookings' } },
          { key: 'completed', label: { ar: 'المكتملة', en: 'Completed' } },
          { key: 'net', label: { ar: 'صافي مستحقاتك', en: 'Your net' }, render: (r) => <Money amount={r.net} currency={r.currency} /> },
          { key: 'outstanding', label: { ar: 'غير مُسوّى', en: 'Not yet settled' }, render: (r) => <Money amount={r.outstanding} currency={r.currency} /> },
          { key: 'rating', label: { ar: 'التقييم', en: 'Rating' }, render: (r) => r.rating ?? '—' },
        ]} />
      </Card>
    </Page>
  );
}
