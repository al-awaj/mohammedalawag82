import { describe, expect, it } from 'vitest';
import { checkFieldDefinition, validateAttributes, type FieldDef } from '../src/modules/catalog/fields.js';

const f = (key: string, data_type: FieldDef['data_type'], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, data_type, is_required: false, validation: {}, options: [], ...extra });

const opts = (...v: string[]) => v.map((value) => ({ value, label: { en: value } }));

describe('dynamic attribute validation', () => {
  const fields = [
    f('style', 'select', { is_required: true, options: opts('modern', 'classic') }),
    f('seats', 'integer', { is_required: true, validation: { min: 10, max: 5000 } }),
    f('amenities', 'multiselect', { options: opts('parking', 'valet') }),
    f('kitchen', 'boolean'),
    f('website', 'url'),
    f('since', 'date'),
    f('motto', 'text', { validation: { maxLength: 20, pattern: '^[A-Za-z ]+$' } }),
    f('note', 'i18n_text'),
  ];

  it('accepts valid values and drops empty optional ones', () => {
    const all = { style: 'modern', seats: 300, amenities: ['parking'], kitchen: true, website: 'https://hall.example', since: '2020-05-01', motto: 'Best hall', note: { ar: 'ملاحظة' } };
    expect(validateAttributes(fields, all)).toEqual({ ok: true, value: all });
    const ok = validateAttributes(fields, { style: 'modern', seats: 300, website: '' });
    expect(ok).toEqual({ ok: true, value: { style: 'modern', seats: 300 } });
  });

  it('reports each invalid field', () => {
    const r = validateAttributes(fields, { style: 'baroque', seats: 5.5, amenities: ['parking', 'parking'], kitchen: 'yes', website: 'http://insecure.example', since: '01/05/2020', motto: 'Way too long motto text here!' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.field).sort()).toEqual(['amenities', 'kitchen', 'motto', 'seats', 'since', 'style', 'website']);
  });

  it('enforces required fields and rejects unknown keys', () => {
    const r = validateAttributes(fields, { color: 'red' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual(expect.arrayContaining([{ field: 'color', message: 'unknown field' }, { field: 'style', message: 'required' }, { field: 'seats', message: 'required' }]));
  });

  it('carries over values of deactivated fields', () => {
    const r = validateAttributes([fields[0]!], { style: 'classic' }, { style: 'modern', legacy_code: 'X1' }, ['legacy_code']);
    expect(r).toEqual({ ok: true, value: { style: 'classic', legacy_code: 'X1' } });
  });

  it('validates field definitions', () => {
    expect(checkFieldDefinition({ data_type: 'select', options: [], validation: {} })).toMatch(/options/);
    expect(checkFieldDefinition({ data_type: 'text', options: opts('a'), validation: {} })).toMatch(/only allowed/);
    expect(checkFieldDefinition({ data_type: 'number', options: [], validation: { min: 5, max: 1 } })).toMatch(/min/);
    expect(checkFieldDefinition({ data_type: 'select', options: opts('a', 'a'), validation: {} })).toMatch(/duplicate/);
    expect(checkFieldDefinition({ data_type: 'select', options: opts('a', 'b'), validation: {} })).toBeNull();
  });
});
