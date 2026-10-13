'use client';
import { useState } from 'react';
import { useGet, useTr } from '@events/web-kit/client';
import { Button, DataTable, DateTime, ErrorBox, Filters, Json, Loading, Modal, Page } from '@events/web-kit/ui';

type Entry = { id: string; actorName: string | null; actorKind: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; reason: string | null; ip: string | null; createdAt: string };

export default function Audit() {
  const tr = useTr();
  const [f, setF] = useState<Record<string, string>>({});
  const [before, setBefore] = useState<string | undefined>();
  const [open, setOpen] = useState<Entry | null>(null);
  const { data, error, isLoading } = useGet<{ items: Entry[]; nextBefore: string | null }>('/v1/admin/audit-log', { ...f, before, limit: 100 });
  return (
    <Page title={tr({ ar: 'سجل التدقيق', en: 'Audit log' })}>
      <Filters value={f} onChange={(v) => { setF(v); setBefore(undefined); }} specs={[
        { name: 'action', label: tr({ ar: 'الإجراء', en: 'Action' }) }, { name: 'entityType', label: tr({ ar: 'نوع الكيان', en: 'Entity type' }) },
        { name: 'entityId', label: tr({ ar: 'معرّف الكيان', en: 'Entity id' }) }, { name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' }, { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' },
      ]} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : <>
        <DataTable rows={data?.items ?? []} columns={[
          { key: 'createdAt', label: { ar: 'الوقت', en: 'Time' }, render: (e) => <DateTime value={e.createdAt} /> },
          { key: 'actorName', label: { ar: 'المنفذ', en: 'Actor' }, render: (e) => `${e.actorName ?? '—'} (${e.actorKind})` },
          { key: 'action', label: { ar: 'الإجراء', en: 'Action' }, render: (e) => <code>{e.action}</code> },
          { key: 'entityType', label: { ar: 'الكيان', en: 'Entity' }, render: (e) => `${e.entityType} ${e.entityId?.slice(0, 8) ?? ''}` },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
          { key: 'ip', label: 'IP' },
          { key: 'details', label: '', render: (e) => <Button variant="ghost" onClick={() => setOpen(e)}>{tr({ ar: 'التفاصيل', en: 'Details' })}</Button> },
        ]} />
        {data?.nextBefore && <div className="pager"><Button variant="ghost" onClick={() => setBefore(data.nextBefore ?? undefined)}>{tr({ ar: 'الأقدم', en: 'Older' })}</Button></div>}
      </>}
      {open && <Modal title={open.action} onClose={() => setOpen(null)}><h3>before</h3><Json value={open.before} /><h3>after</h3><Json value={open.after} /></Modal>}
    </Page>
  );
}
