'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { Query } from '@events/shared';
import { useApp, useGet, useT } from '../client';
import { Button, Empty, ErrorBox, Loading } from './basics';
import type { Option } from './forms';

type L = string | { ar: string; en: string };
export interface Column<T> { key: string; label: L; render?: (row: T) => ReactNode; className?: string }

export function DataTable<T extends object>({ columns, rows, rowHref, rowKey = 'id' }: {
  columns: Column<T>[]; rows: T[]; rowHref?: (row: T) => string | null; rowKey?: string;
}) {
  const { lang } = useApp();
  const label = (l: L) => (typeof l === 'string' ? l : l[lang]);
  if (!rows.length) return <Empty />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.className}>{label(c.label)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const href = rowHref?.(r);
            return (
              <tr key={String((r as Record<string, unknown>)[rowKey] ?? i)}>
                {columns.map((c, ci) => {
                  const content = c.render ? c.render(r) : formatCell((r as Record<string, unknown>)[c.key]);
                  return <td key={c.key} className={c.className}>{href && ci === 0 ? <Link href={href}>{content}</Link> : content}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export interface FilterSpec { name: string; label: L; type?: 'text' | 'select' | 'date' | 'checkbox'; options?: Option[] }

export function Filters({ specs, value, onChange }: { specs: FilterSpec[]; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const { lang } = useApp();
  const t = useT();
  const label = (l: L) => (typeof l === 'string' ? l : l[lang]);
  const [draft, setDraft] = useState(value);
  return (
    <form className="filters" onSubmit={(e) => { e.preventDefault(); onChange(draft); }}>
      {specs.map((s) => (
        <label key={s.name} className="filter">
          <span>{label(s.label)}</span>
          {s.type === 'select' ? (
            <select name={s.name} value={draft[s.name] ?? ''} onChange={(e) => setDraft({ ...draft, [s.name]: e.target.value })}>
              <option value="">{t('all')}</option>
              {s.options?.map((o) => <option key={o.value} value={o.value}>{label(o.label)}</option>)}
            </select>
          ) : s.type === 'checkbox' ? (
            <input type="checkbox" name={s.name} checked={draft[s.name] === 'true'} onChange={(e) => setDraft({ ...draft, [s.name]: e.target.checked ? 'true' : '' })} />
          ) : (
            <input name={s.name} type={s.type === 'date' ? 'date' : 'search'} value={draft[s.name] ?? ''} onChange={(e) => setDraft({ ...draft, [s.name]: e.target.value })} />
          )}
        </label>
      ))}
      <Button variant="secondary" type="submit">{t('filter')}</Button>
    </form>
  );
}

/**
 * Paginated list over a GET endpoint that accepts limit/offset. The API does not return totals, so
 * "next" is offered when a full page came back.
 */
export function ListView<T extends object>({ path, columns, filters = [], rowHref, query, limit = 50, paged = true, select, initialFilters }: {
  path: string; columns: Column<T>[]; filters?: FilterSpec[]; rowHref?: (row: T) => string | null; query?: Query; limit?: number; paged?: boolean;
  select?: (data: unknown) => T[]; initialFilters?: Record<string, string>;
}) {
  const t = useT();
  const [f, setF] = useState<Record<string, string>>(initialFilters ?? {});
  const [offset, setOffset] = useState(0);
  const q = { ...query, ...f, ...(paged ? { limit, offset } : {}) };
  const { data, error, isLoading, refetch } = useGet<unknown>(path, q);
  const rows = (select ? select(data) : (data as T[] | undefined)) ?? [];
  return (
    <div>
      {filters.length > 0 && <Filters specs={filters} value={f} onChange={(v) => { setF(v); setOffset(0); }} />}
      <ErrorBox error={error} onRetry={() => refetch()} />
      {isLoading ? <Loading /> : <DataTable columns={columns} rows={rows} rowHref={rowHref} />}
      {paged && (offset > 0 || rows.length === limit) && (
        <div className="pager">
          <Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>{t('previous')}</Button>
          <span>{t('page', { n: offset / limit + 1 })}</span>
          <Button variant="ghost" disabled={rows.length < limit} onClick={() => setOffset(offset + limit)}>{t('next')}</Button>
        </div>
      )}
    </div>
  );
}
