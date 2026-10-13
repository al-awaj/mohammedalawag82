'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { ApiError, enumLabel, formatDate, formatDateTime, formatMoney, localized } from '@events/shared';
import { useApp, useT } from '../client';

export function Button({ children, variant = 'primary', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  return <button type="button" className={`btn btn-${variant}`} {...rest}>{children}</button>;
}

export function Loading() {
  const t = useT();
  return <div className="muted pad" role="status">{t('appLoading')}</div>;
}

export function Empty({ children }: { children?: ReactNode }) {
  const t = useT();
  return <div className="empty">{children ?? t('empty')}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const details = e?.details && Array.isArray(e.details) ? (e.details as { path?: string; message?: string }[]) : [];
  return (
    <div className="alert alert-error" role="alert">
      <strong>{e?.status === 403 ? t('forbidden') : e?.message ?? (error instanceof Error && error.message ? error.message : t('error'))}</strong>
      {e?.code && <code className="code">{e.code}</code>}
      {details.length > 0 && <ul>{details.map((d, i) => <li key={i}>{d.path} {d.message}</li>)}</ul>}
      {onRetry && <Button variant="ghost" onClick={onRetry}>{t('retry')}</Button>}
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'success' | 'warning'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

const TONE: Record<string, string> = {
  confirmed: 'ok', completed: 'ok', succeeded: 'ok', paid: 'ok', published: 'ok', approved: 'ok', active: 'ok', matched: 'ok', settled: 'ok', due: 'ok', sent: 'ok', ready_for_settlement: 'ok',
  failed: 'bad', rejected: 'bad', expired: 'bad', cancelled: 'bad', suspended: 'bad', disabled: 'bad', hidden: 'bad', no_show: 'bad',
  cancelled_by_customer: 'bad', cancelled_by_provider: 'bad', cancelled_by_admin: 'bad', amount_mismatch: 'bad', currency_mismatch: 'bad',
  missing_in_platform: 'bad', missing_in_statement: 'bad', status_mismatch: 'bad', settlement_failed: 'bad', on_hold_dispute: 'warn',
};
export function Badge({ group, value }: { group: string; value: string | null | undefined }) {
  const { lang } = useApp();
  return <span className={`badge badge-${TONE[value ?? ''] ?? 'neutral'}`}>{enumLabel(group, value, lang)}</span>;
}

export function Money({ amount, currency }: { amount: string | null | undefined; currency: string | null | undefined }) {
  return <span className="num" dir="ltr">{formatMoney(amount, currency)}</span>;
}

export function DateTime({ value, dateOnly }: { value: string | null | undefined; dateOnly?: boolean }) {
  const { lang } = useApp();
  return <span>{dateOnly ? formatDate(value, lang) : formatDateTime(value, lang)}</span>;
}

export function Text({ value }: { value: unknown }) {
  const { lang } = useApp();
  return <>{localized(value, lang)}</>;
}

export function Page({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="page">
      <header className="page-head">
        <h1>{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || actions) && <div className="card-head"><h2>{title}</h2>{actions && <div className="row gap">{actions}</div>}</div>}
      {children}
    </div>
  );
}

export function Detail({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="detail">
      {items.map(([k, v], i) => (
        <div key={i} className="detail-row"><dt>{k}</dt><dd>{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose}>
      <div className="modal-head"><h2>{title}</h2><button type="button" className="icon-btn" aria-label="close" onClick={onClose}>×</button></div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={t.id === value ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

/** Link to a proxied GET (CSV export, printable documents) opened in a new tab. */
export function ApiLink({ path, children }: { path: string; children: ReactNode }) {
  return <a className="btn btn-secondary" href={`/bff${path}`} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json" dir="ltr">{JSON.stringify(value, null, 2)}</pre>;
}
