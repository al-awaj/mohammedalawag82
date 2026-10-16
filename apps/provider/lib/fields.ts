import type { FieldSpec } from '@events/web-kit/ui';

/** A service type's own fields (defined by the administration) rendered as form inputs. */
export interface TypeField {
  key: string; label: Record<string, string>; helpText: Record<string, string> | null; dataType: string; isRequired: boolean;
  options: { value: string; label: Record<string, string> }[];
}
const KIND: Record<string, FieldSpec['type']> = {
  text: 'text', textarea: 'textarea', url: 'text', i18n_text: 'i18n', number: 'number', integer: 'number', boolean: 'checkbox',
  select: 'select', multiselect: 'multiselect', date: 'date', time: 'time', location: 'geo',
};
const bi = (o: Record<string, string> | null | undefined) => (o ? { ar: o.ar ?? o.en ?? '', en: o.en ?? o.ar ?? '' } : undefined);

export function attributeFields(fields: TypeField[], values: Record<string, unknown> = {}): FieldSpec[] {
  return fields.map((f) => ({
    name: `attr.${f.key}`, label: bi(f.label)!, help: bi(f.helpText), type: KIND[f.dataType] ?? 'text', required: f.isRequired,
    options: f.options.map((o) => ({ value: o.value, label: bi(o.label)! })), defaultValue: values[f.key],
  }));
}

/** Splits form values into the service body and its `attributes` object. */
export function splitAttributes(v: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('attr.')) attributes[k.slice(5)] = x; else body[k] = x;
  }
  return { ...body, attributes };
}
