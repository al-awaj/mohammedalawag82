'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { Card, DateTime, Detail, ErrorBox, Loading, Page } from '@events/web-kit/ui';

type Status = {
  checkedAt: string; version: string | null; uptimeSec: number;
  database: { ok: boolean; latencyMs: number; version: string; size: string };
  migrations: { latest: string; appliedAt: string } | null;
  worker: { ok: boolean; lastBeatAt: string | null; ageSec: number | null };
  outbox: { ok: boolean; pending: number; failed: number; oldest: string | null };
  backups: { ok: boolean; configured: boolean; last: { file: string; at: string; bytes: number } | null };
  storage: { driver: string }; pdf: { available: boolean }; errorAlerts: { configured: boolean };
};

const Flag = ({ ok, label }: { ok: boolean; label: string }) => <span className={`badge badge-${ok ? 'ok' : 'bad'}`} data-testid={`status-${label}`}>{ok ? '✓' : '!'} {label}</span>;

/** Health of the platform's moving parts, refreshed every 30 seconds (clause 75). */
export default function System() {
  const tr = useTr();
  const { data: s, error, isLoading } = useGet<Status>('/v1/admin/system/status', undefined, { refetchInterval: 30_000 });
  if (isLoading) return <Loading />;
  if (error || !s) return <ErrorBox error={error} />;
  const mins = (sec: number | null) => (sec === null ? '—' : sec < 120 ? `${sec} ${tr({ ar: 'ثانية', en: 's' })}` : `${Math.round(sec / 60)} ${tr({ ar: 'دقيقة', en: 'min' })}`);
  return (
    <Page title={tr({ ar: 'حالة النظام', en: 'System status' })}>
      <div className="row gap wrap" style={{ marginBottom: 12 }}>
        <Flag ok={s.database.ok} label={tr({ ar: 'قاعدة البيانات', en: 'Database' })} />
        <Flag ok={s.worker.ok} label={tr({ ar: 'المهام الخلفية', en: 'Worker' })} />
        <Flag ok={s.outbox.ok} label={tr({ ar: 'الإشعارات', en: 'Notifications' })} />
        <Flag ok={s.backups.ok} label={tr({ ar: 'النسخ الاحتياطي', en: 'Backups' })} />
        <Flag ok={s.pdf.available} label="PDF" />
      </div>
      <Card>
        <Detail items={[
          [tr({ ar: 'آخر فحص', en: 'Checked' }), <DateTime key="c" value={s.checkedAt} />],
          [tr({ ar: 'الإصدار', en: 'Version' }), s.version ?? '—'],
          [tr({ ar: 'مدة التشغيل', en: 'Uptime' }), mins(s.uptimeSec)],
          [tr({ ar: 'قاعدة البيانات', en: 'Database' }), `${s.database.version} · ${s.database.size} · ${s.database.latencyMs} ms`],
          [tr({ ar: 'آخر تحديث للمخطط', en: 'Latest migration' }), s.migrations ? `${s.migrations.latest}` : '—'],
          [tr({ ar: 'آخر نبضة للمهام الخلفية', en: 'Worker heartbeat' }), s.worker.lastBeatAt ? `${mins(s.worker.ageSec)} ${tr({ ar: 'مضت', en: 'ago' })}` : tr({ ar: 'لم تعمل بعد — شغّل العامل (npm run worker)', en: 'never — start the worker (npm run worker)' })],
          [tr({ ar: 'إشعارات بانتظار الإرسال', en: 'Pending notifications' }), String(s.outbox.pending)],
          [tr({ ar: 'إشعارات فشلت (24 ساعة)', en: 'Failed notifications (24h)' }), String(s.outbox.failed)],
          [tr({ ar: 'آخر نسخة احتياطية', en: 'Last backup' }), !s.backups.configured ? tr({ ar: 'مجلد النسخ (BACKUP_DIR) غير مضبوط', en: 'BACKUP_DIR is not set' })
            : s.backups.last ? <span key="b"><DateTime value={s.backups.last.at} /> · {s.backups.last.file} · {(s.backups.last.bytes / 1_048_576).toFixed(1)} MB</span> : tr({ ar: 'لا توجد نسخ', en: 'none' })],
          [tr({ ar: 'تخزين الملفات', en: 'File storage' }), s.storage.driver],
          [tr({ ar: 'طباعة PDF', en: 'PDF printing' }), s.pdf.available ? tr({ ar: 'متاحة', en: 'available' }) : tr({ ar: 'غير متاحة (ثبّت Chromium أو Edge)', en: 'not available (install Chromium or Edge)' })],
          [tr({ ar: 'تنبيهات الأخطاء', en: 'Error alerts' }), s.errorAlerts.configured ? tr({ ar: 'مفعّلة', en: 'on' }) : tr({ ar: 'غير مفعّلة (ERROR_WEBHOOK_URL)', en: 'off (ERROR_WEBHOOK_URL)' })],
        ]} />
      </Card>
    </Page>
  );
}
