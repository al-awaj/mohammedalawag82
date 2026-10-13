'use client';
import { useState } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DataTable, DateTime, ErrorBox, Loading, Notice, Page, reasonField, Tabs, Text, type FieldSpec } from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';

type Staff = { id: string; fullName: string; email: string; phone: string | null; status: string; jobTitle: string | null; lastLoginAt: string | null; roles: { roleId: string; roleCode: string; countryId: string | null }[] };
type Role = { id: string; code: string; name: Record<string, string>; description: Record<string, string> | null; isSystem: boolean; permissions: string[]; assignedUsers: number };
type Perm = { code: string; module: string; description: Record<string, string> };

export default function StaffPage() {
  const tr = useTr();
  const can = useCan();
  const [tab, setTab] = useState<'staff' | 'roles'>(can('users.view') ? 'staff' : 'roles');
  return (
    <Page title={tr({ ar: 'الموظفون والأدوار', en: 'Staff & roles' })}>
      <Tabs value={tab} onChange={setTab} tabs={[
        ...(can('users.view') ? [{ id: 'staff' as const, label: tr({ ar: 'الموظفون', en: 'Staff' }) }] : []),
        ...(can('roles.view') ? [{ id: 'roles' as const, label: tr({ ar: 'الأدوار والصلاحيات', en: 'Roles & permissions' }) }] : []),
      ]} />
      {tab === 'staff' ? <StaffList /> : <Roles />}
    </Page>
  );
}

/** Role assignments as "roleCode" (all countries) or "roleCode@COUNTRYCODE", one per line. */
function rolesField(roles: Role[], countries: ReturnType<typeof useCountries>, current?: Staff['roles']): FieldSpec {
  return {
    name: 'roles', label: { ar: 'الأدوار (سطر لكل دور: الرمز أو الرمز@رمز_الدولة)', en: 'Roles (one per line: code or code@COUNTRY)' }, type: 'textarea',
    defaultValue: current?.map((r) => (r.countryId ? `${r.roleCode}@${countries.code(r.countryId)}` : r.roleCode)).join('\n'),
    help: { ar: `المتاح: ${roles.map((r) => r.code).join('، ')}`, en: `Available: ${roles.map((r) => r.code).join(', ')}` },
  };
}
function parseRoles(text: unknown, roles: Role[], countries: ReturnType<typeof useCountries>) {
  return String(text ?? '').split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [code, cc] = l.split('@');
    const role = roles.find((r) => r.code === code?.trim());
    if (!role) throw new Error(`unknown role: ${code}`);
    const country = cc ? countries.list.find((c) => c.code === cc.trim().toUpperCase()) : null;
    if (cc && !country) throw new Error(`unknown country: ${cc}`);
    return { roleId: role.id, countryId: country?.id ?? null };
  });
}

function StaffList() {
  const tr = useTr();
  const can = useCan();
  const countries = useCountries();
  const roles = useGet<Role[]>(can('roles.view') ? '/v1/admin/roles' : null).data ?? [];
  const { data, error, isLoading } = useGet<Staff[]>('/v1/admin/staff');
  if (isLoading) return <Loading />;
  return (
    <>
      {can('users.manage') && (
        <div className="page-actions" style={{ marginBottom: 12 }}>
          <ActionButton variant="primary" label={tr({ ar: 'موظف جديد', en: 'New staff member' })} fields={[
            { name: 'fullName', label: { ar: 'الاسم', en: 'Name' }, required: true },
            { name: 'email', label: { ar: 'البريد', en: 'Email' }, type: 'email', required: true },
            { name: 'phone', label: { ar: 'الجوال', en: 'Phone' }, type: 'tel' },
            { name: 'password', label: { ar: 'كلمة مرور مؤقتة', en: 'Temporary password' }, type: 'password', required: true },
            { name: 'jobTitle', label: { ar: 'المسمى', en: 'Job title' } },
            { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', options: countries.options },
            ...(roles.length ? [rolesField(roles, countries)] : []),
          ]} run={(api, v) => api.post('/v1/admin/staff', { ...v, roles: parseRoles(v.roles, roles, countries) })} />
        </div>
      )}
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'fullName', label: { ar: 'الاسم', en: 'Name' } },
        { key: 'email', label: { ar: 'البريد', en: 'Email' } },
        { key: 'jobTitle', label: { ar: 'المسمى', en: 'Title' } },
        { key: 'roles', label: { ar: 'الأدوار', en: 'Roles' }, render: (s) => s.roles.map((r) => (r.countryId ? `${r.roleCode}@${countries.code(r.countryId)}` : r.roleCode)).join('، ') },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (s) => <Badge group="user" value={s.status} /> },
        { key: 'lastLoginAt', label: { ar: 'آخر دخول', en: 'Last sign-in' }, render: (s) => <DateTime value={s.lastLoginAt} /> },
        { key: 'actions', label: '', render: (s) => can('roles.manage') && roles.length ? (
          <ActionButton label={tr({ ar: 'الأدوار', en: 'Roles' })}
            note={tr({ ar: 'لا يمكنك منح صلاحيات لا تملكها.', en: 'You cannot grant permissions you do not hold.' })}
            fields={[rolesField(roles, countries, s.roles), reasonField()]}
            run={(api, v) => api.put(`/v1/admin/staff/${s.id}/roles`, { roles: parseRoles(v.roles, roles, countries), reason: v.reason })} />
        ) : null },
      ]} />
    </>
  );
}

function Roles() {
  const tr = useTr();
  const can = useCan();
  const perms = useGet<Perm[]>('/v1/admin/permissions').data ?? [];
  const { data, error, isLoading } = useGet<Role[]>('/v1/admin/roles');
  const permOptions = perms.map((p) => ({ value: p.code, label: { ar: `${p.description.ar} (${p.code})`, en: `${p.description.en} (${p.code})` } }));
  const fields = (r?: Role): FieldSpec[] => [
    ...(r ? [] : [{ name: 'code', label: { ar: 'الرمز', en: 'Code' }, required: true } as FieldSpec]),
    { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true, defaultValue: r?.name },
    { name: 'permissions', label: { ar: 'الصلاحيات', en: 'Permissions' }, type: 'multiselect', options: permOptions, defaultValue: r?.permissions ?? [] },
  ];
  if (isLoading) return <Loading />;
  return (
    <>
      <Notice>{tr({ ar: 'الأدوار النظامية لا تُعدل. التحقق من الصلاحيات يتم في الخادم لكل طلب.', en: 'System roles cannot be edited. Permissions are checked by the server on every request.' })}</Notice>
      {can('roles.manage') && <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'دور جديد', en: 'New role' })} fields={fields()} run={(api, v) => api.post('/v1/admin/roles', { ...v, permissions: v.permissions ?? [] })} />
      </div>}
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'name', label: { ar: 'الدور', en: 'Role' }, render: (r) => <Text value={r.name} /> },
        { key: 'code', label: { ar: 'الرمز', en: 'Code' } },
        { key: 'permissions', label: { ar: 'الصلاحيات', en: 'Permissions' }, render: (r) => <span className="small">{r.permissions.length}</span> },
        { key: 'assignedUsers', label: { ar: 'المستخدمون', en: 'Users' } },
        { key: 'isSystem', label: { ar: 'نظامي', en: 'System' } },
        { key: 'actions', label: '', render: (r) => can('roles.manage') && !r.isSystem ? (
          <div className="row gap">
            <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={fields(r)} run={(api, v) => api.patch(`/v1/admin/roles/${r.id}`, { ...v, permissions: v.permissions ?? [] })} />
            {r.assignedUsers === 0 && <ActionButton variant="danger" label={tr({ ar: 'حذف', en: 'Delete' })} run={(api) => api.del(`/v1/admin/roles/${r.id}`)} />}
          </div>
        ) : null },
      ]} />
    </>
  );
}
