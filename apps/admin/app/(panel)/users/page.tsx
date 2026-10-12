'use client';
import { useCan, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DateTime, ListView, Page, reasonField } from '@events/web-kit/ui';

type Row = { id: string; kind: string; fullName: string; phone: string | null; email: string | null; countryCode: string | null; status: string; phoneVerifiedAt: string | null; lastLoginAt: string | null; createdAt: string };
const KINDS = [{ value: 'customer', label: { ar: 'عميل', en: 'Customer' } }, { value: 'provider', label: { ar: 'صاحب خدمة', en: 'Provider' } }, { value: 'staff', label: { ar: 'موظف', en: 'Staff' } }];

export default function Users() {
  const tr = useTr();
  const can = useCan();
  return (
    <Page title={tr({ ar: 'المستخدمون', en: 'Users' })}>
      <ListView<Row>
        path="/v1/admin/users"
        select={(d) => (d as { items: Row[] } | undefined)?.items ?? []}
        filters={[{ name: 'kind', label: tr({ ar: 'النوع', en: 'Kind' }), type: 'select', options: KINDS }, { name: 'q', label: tr({ ar: 'بحث', en: 'Search' }) }]}
        columns={[
          { key: 'fullName', label: { ar: 'الاسم', en: 'Name' } },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' }, render: (u) => tr(KINDS.find((k) => k.value === u.kind)?.label ?? { ar: u.kind, en: u.kind }) },
          { key: 'phone', label: { ar: 'الجوال', en: 'Phone' }, render: (u) => <span dir="ltr">{u.phone ?? '—'}</span> },
          { key: 'email', label: { ar: 'البريد', en: 'Email' } },
          { key: 'countryCode', label: { ar: 'الدولة', en: 'Country' } },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (u) => <Badge group="user" value={u.status} /> },
          { key: 'lastLoginAt', label: { ar: 'آخر دخول', en: 'Last sign-in' }, render: (u) => <DateTime value={u.lastLoginAt} /> },
          { key: 'actions', label: '', render: (u) => can('users.manage') ? (
            <ActionButton variant={u.status === 'active' ? 'danger' : 'secondary'} label={u.status === 'active' ? tr({ ar: 'تعطيل', en: 'Disable' }) : tr({ ar: 'تفعيل', en: 'Enable' })}
              note={tr({ ar: 'التعطيل يُنهي جلسات المستخدم.', en: 'Disabling ends the user’s sessions.' })}
              fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/users/${u.id}/status`, { status: u.status === 'active' ? 'disabled' : 'active', ...v })} />
          ) : null },
        ]}
      />
    </Page>
  );
}
