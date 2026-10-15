import { z } from 'zod';
import { i18nTextSchema } from '../common.js';

export const DATA_TYPES = ['text', 'textarea', 'i18n_text', 'number', 'integer', 'boolean', 'select', 'multiselect', 'date', 'url', 'time', 'location'] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const validationSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).max(10_000).optional(),
  pattern: z.string().max(200).refine((p) => { try { new RegExp(p); return true; } catch { return false; } }, 'invalid regular expression').optional(),
  maxItems: z.number().int().min(1).optional(),
}).strict().default({});

export const optionSchema = z.object({ value: z.string().regex(/^[a-z0-9_-]{1,50}$/), label: i18nTextSchema });

export interface FieldDef {
  key: string;
  data_type: DataType;
  is_required: boolean;
  validation: z.infer<typeof validationSchema>;
  options: { value: string; label: Record<string, string> }[];
}

/** Zod schema for a single field value, built from the admin-defined definition. */
function valueSchema(f: FieldDef): z.ZodType {
  const v = f.validation;
  switch (f.data_type) {
    case 'text':
    case 'textarea': {
      let s = z.string().trim().min(Math.max(1, v.minLength ?? 1)).max(v.maxLength ?? (f.data_type === 'text' ? 200 : 5000));
      if (v.pattern) s = s.regex(new RegExp(v.pattern));
      return s;
    }
    case 'i18n_text':
      return i18nTextSchema;
    case 'number':
    case 'integer': {
      let n = f.data_type === 'integer' ? z.number().int() : z.number();
      if (v.min !== undefined) n = n.min(v.min);
      if (v.max !== undefined) n = n.max(v.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum(f.options.map((o) => o.value) as [string, ...string[]]);
    case 'multiselect': {
      const arr = z.array(z.enum(f.options.map((o) => o.value) as [string, ...string[]])).min(1).max(v.maxItems ?? f.options.length);
      return arr.refine((a) => new Set(a).size === a.length, 'duplicate values');
    }
    case 'date':
      return z.iso.date();
    case 'url':
      return z.url({ protocol: /^https$/ });
    case 'time':
      return z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time as HH:MM');
    case 'location':
      return z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
  }
}

export interface AttributeIssue { field: string; message: string }

/**
 * Validates submitted attributes against the active fields of a service type.
 * Unknown keys are rejected so data that no field describes is never stored.
 * `previous` holds values of deactivated fields, which are carried over untouched.
 */
export function validateAttributes(
  fields: FieldDef[],
  input: Record<string, unknown>,
  previous: Record<string, unknown> = {},
  inactiveKeys: string[] = [],
): { ok: true; value: Record<string, unknown> } | { ok: false; issues: AttributeIssue[] } {
  const issues: AttributeIssue[] = [];
  const out: Record<string, unknown> = {};
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push({ field: key, message: 'unknown field' });
  }
  for (const f of fields) {
    const raw = input[f.key];
    if (raw === undefined || raw === null || raw === '') {
      if (f.is_required) issues.push({ field: f.key, message: 'required' });
      continue;
    }
    const r = valueSchema(f).safeParse(raw);
    if (r.success) out[f.key] = r.data;
    else issues.push({ field: f.key, message: r.error.issues.map((i) => i.message).join('; ') });
  }
  for (const key of inactiveKeys) {
    if (previous[key] !== undefined) out[key] = previous[key];
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}

/** Checks that a field definition is internally consistent (options for selects, sensible bounds). */
export function checkFieldDefinition(f: { data_type: DataType; options: unknown[]; validation: z.infer<typeof validationSchema> }): string | null {
  const v = f.validation;
  if ((f.data_type === 'select' || f.data_type === 'multiselect') && f.options.length === 0) return 'options are required for select fields';
  if (f.data_type !== 'select' && f.data_type !== 'multiselect' && f.options.length > 0) return 'options are only allowed for select fields';
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) return 'min must be <= max';
  if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) return 'minLength must be <= maxLength';
  const values = (f.options as { value: string }[]).map((o) => o.value);
  if (new Set(values).size !== values.length) return 'duplicate option values';
  return null;
}
