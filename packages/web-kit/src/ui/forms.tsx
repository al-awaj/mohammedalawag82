'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { ApiClient } from '@events/shared';
import { useAction, useApp, useT } from '../client';
import { Button, ErrorBox, Modal, Notice } from './basics';

type L = string | { ar: string; en: string };
export interface Option { value: string; label: L }
export interface FieldSpec {
  name: string;
  label: L;
  type?: 'text' | 'textarea' | 'number' | 'decimal' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'datetime' | 'i18n' | 'json' | 'password' | 'email' | 'tel' | 'file';
  required?: boolean;
  options?: Option[];
  placeholder?: string;
  help?: L;
  defaultValue?: unknown;
  /** Read-only display of a fixed value that is still submitted. */
  readOnly?: boolean;
}

export type Values = Record<string, unknown>;

function useLabel() {
  const { lang } = useApp();
  return (l: L | undefined) => (l === undefined ? '' : typeof l === 'string' ? l : l[lang]);
}

function initial(fields: FieldSpec[]): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.defaultValue !== undefined) {
      v[f.name] = f.type === 'json' ? JSON.stringify(f.defaultValue, null, 2)
        : f.type === 'i18n' ? { ar: '', en: '', ...(f.defaultValue as object) }
        : f.type === 'datetime' && typeof f.defaultValue === 'string' ? toLocalInput(f.defaultValue)
        : f.defaultValue;
    } else v[f.name] = f.type === 'checkbox' ? false : f.type === 'i18n' ? { ar: '', en: '' } : f.type === 'multiselect' ? [] : '';
  }
  return v;
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Converts form state to the API's types; empty optional fields are left out. */
export function collect(fields: FieldSpec[], raw: Record<string, unknown>): { values: Values; errors: Record<string, string> } {
  const values: Values = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = raw[f.name];
    const empty = v === '' || v === undefined || v === null || (Array.isArray(v) && !v.length && f.required)
      || (f.type === 'i18n' && !(v as Record<string, string>).ar?.trim() && !(v as Record<string, string>).en?.trim())
      || (f.type === 'file' && !(v instanceof File));
    if (empty) { if (f.required) errors[f.name] = 'required'; continue; }
    switch (f.type) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) errors[f.name] = 'number'; else values[f.name] = n;
        break;
      }
      case 'decimal': {
        const s = String(v).trim();
        if (!/^-?\d+(\.\d+)?$/.test(s)) errors[f.name] = 'number'; else values[f.name] = s;
        break;
      }
      case 'json':
        try { values[f.name] = JSON.parse(String(v)); } catch { errors[f.name] = 'json'; }
        break;
      case 'i18n': {
        const o = v as Record<string, string>;
        values[f.name] = Object.fromEntries(Object.entries(o).filter(([, x]) => x.trim()).map(([k, x]) => [k, x.trim()]));
        break;
      }
      case 'datetime': values[f.name] = new Date(String(v)).toISOString(); break;
      case 'text': case 'textarea': case undefined: values[f.name] = String(v).trim(); break;
      default: values[f.name] = v;
    }
  }
  return { values, errors };
}

export function FieldInput({ field, value, onChange, error }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const label = useLabel();
  const t = useT();
  const id = `f-${field.name}`;
  const common = { id, name: field.name, required: field.required, readOnly: field.readOnly, placeholder: field.placeholder, 'aria-invalid': !!error };
  let input: ReactNode;
  switch (field.type) {
    case 'textarea':
      input = <textarea {...common} rows={4} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'json':
      input = <textarea {...common} dir="ltr" className="mono" rows={8} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'select':
      input = (
        <select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} disabled={field.readOnly}>
          <option value="">—</option>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{label(o.label)}</option>)}
        </select>
      );
      break;
    case 'multiselect': {
      const arr = (value as string[]) ?? [];
      input = (
        <div className="checks" id={id}>
          {field.options?.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />
              {label(o.label)}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'checkbox':
      return (
        <label className="check field">
          <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={field.readOnly} />
          {label(field.label)}
        </label>
      );
    case 'i18n': {
      const o = (value as Record<string, string>) ?? { ar: '', en: '' };
      input = (
        <div className="i18n">
          <input {...common} dir="rtl" lang="ar" placeholder="العربية" value={o.ar ?? ''} onChange={(e) => onChange({ ...o, ar: e.target.value })} />
          <input name={`${field.name}.en`} dir="ltr" lang="en" placeholder="English" value={o.en ?? ''} onChange={(e) => onChange({ ...o, en: e.target.value })} />
        </div>
      );
      break;
    }
    case 'file':
      input = <input {...common} type="file" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />;
      break;
    default: {
      const type = field.type === 'decimal' ? 'text' : field.type === 'datetime' ? 'datetime-local' : field.type ?? 'text';
      const ltr = ['decimal', 'number', 'email', 'tel', 'password', 'date', 'datetime'].includes(field.type ?? '');
      input = <input {...common} type={type} inputMode={field.type === 'decimal' ? 'decimal' : undefined} dir={ltr ? 'ltr' : undefined} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    }
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label(field.label)}{field.required && <span className="req"> *</span>}</label>
      {input}
      {field.help && <small className="muted">{label(field.help)}</small>}
      {error && <small className="field-error">{error === 'required' ? t('required') : error}</small>}
    </div>
  );
}

export function Form({ fields, onSubmit, submitLabel, busy, children }: {
  fields: FieldSpec[]; onSubmit: (v: Values) => void; submitLabel?: ReactNode; busy?: boolean; children?: ReactNode;
}) {
  const t = useT();
  const [state, setState] = useState(() => initial(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { values, errors } = collect(fields, state);
    setErrors(errors);
    if (!Object.keys(errors).length) onSubmit(values);
  };
  return (
    <form className="form" method="post" onSubmit={submit} noValidate>
      {fields.map((f) => <FieldInput key={f.name} field={f} value={state[f.name]} error={errors[f.name]} onChange={(v) => setState((s) => ({ ...s, [f.name]: v }))} />)}
      {children}
      <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{submitLabel ?? t('save')}</button></div>
    </form>
  );
}

/**
 * A button that opens a dialog (form or confirmation), calls the API and refreshes the screen. Errors
 * from the API are shown as returned (already translated by the server).
 */
export function ActionButton({ label, title, fields = [], run, variant = 'secondary', note, onDone, disabled }: {
  label: ReactNode; title?: ReactNode; fields?: FieldSpec[]; run: (api: ApiClient, v: Values) => Promise<unknown>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; note?: ReactNode; onDone?: (result: unknown) => void; disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const m = useAction((api, v: Values) => run(api, v));
  return (
    <>
      <Button variant={variant} onClick={() => { m.reset(); setOpen(true); }} disabled={disabled}>{label}</Button>
      {open && (
        <Modal title={title ?? label} onClose={() => setOpen(false)}>
          {note && <Notice kind="warning">{note}</Notice>}
          <ErrorBox error={m.error} />
          <Form fields={fields} busy={m.isPending} submitLabel={t('confirm')}
            onSubmit={(v) => m.mutate(v, { onSuccess: (r) => { setOpen(false); onDone?.(r); } })} />
          <p className="muted small">{t('irreversibleHint')}</p>
        </Modal>
      )}
    </>
  );
}

export const reasonField = (required = true): FieldSpec => ({ name: 'reason', label: { ar: 'السبب', en: 'Reason' }, type: 'textarea', required });
