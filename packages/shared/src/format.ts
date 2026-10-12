/**
 * Display formatting shared by every interface. Amounts arrive from the API as exact decimal strings
 * (scale 4) and are never converted to floating point: rounding and grouping are done on the digits.
 */
export type Lang = 'ar' | 'en';

const locale = (lang: Lang) => (lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB');

/** Rounds a decimal string half-up to `minor` fraction digits, exactly. */
export function roundDecimal(value: string, minor: number): string {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return value;
  const [, sign, int, frac = ''] = m;
  const digits = BigInt(int! + frac.padEnd(minor + 1, '0').slice(0, minor + 1));
  const units = digits / 10n + (digits % 10n >= 5n ? 1n : 0n);
  const neg = sign === '-' && units !== 0n;
  const s = units.toString().padStart(minor + 1, '0');
  const i = s.slice(0, s.length - minor);
  const f = minor ? s.slice(s.length - minor) : '';
  return `${neg ? '-' : ''}${i}${f ? `.${f}` : ''}`;
}

/** Groups thousands of a plain decimal string ("1234567.50" → "1,234,567.50"). */
export function groupDigits(value: string): string {
  const [int = '', frac] = value.split('.');
  const neg = int.startsWith('-');
  const body = (neg ? int.slice(1) : int).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${body}${frac !== undefined ? `.${frac}` : ''}`;
}

const MINOR: Record<string, number> = { KWD: 3, BHD: 3, OMR: 3, JOD: 3, IQD: 3, TND: 3, LYD: 3, JPY: 0, YER: 2 };

/** "15000.0000", "SAR" → "15,000.00 SAR" (currency code kept explicit: amounts are never mixed). */
export function formatMoney(amount: string | null | undefined, currency: string | null | undefined, minorUnits?: number): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const cur = (currency ?? '').trim();
  const minor = minorUnits ?? MINOR[cur] ?? 2;
  return `${groupDigits(roundDecimal(String(amount), minor))}${cur ? ` ${cur}` : ''}`;
}

export function formatDateTime(value: string | Date | null | undefined, lang: Lang, timeZone?: string): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(d);
}

export function formatDate(value: string | Date | null | undefined, lang: Lang, timeZone?: string): string {
  if (!value) return '—';
  // Plain calendar dates ("2027-05-01") are shown as-is in UTC so they never shift a day.
  const plain = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = value instanceof Date ? value : new Date(plain ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeZone: plain ? 'UTC' : timeZone }).format(d);
}

/** Text from an i18n object ({ar, en}) in the requested language, falling back to the other one. */
export function localized(v: unknown, lang: Lang): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return String(o[lang] ?? o.ar ?? o.en ?? Object.values(o)[0] ?? '');
  }
  return String(v);
}

export const dirOf = (lang: Lang) => (lang === 'ar' ? 'rtl' : 'ltr');

export function formatTime(value: string | Date | null | undefined, lang: Lang, timeZone?: string): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale(lang), { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(d);
}
