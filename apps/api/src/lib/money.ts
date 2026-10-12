/**
 * Exact money arithmetic on decimal strings, using BigInt scaled to 4 decimal places
 * (the precision of numeric(20,4) columns). Never uses floating point.
 */
const SCALE = 4;
const ONE = 10n ** BigInt(SCALE);

export type Units = bigint;

export function toUnits(value: string | number): Units {
  const s = String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`invalid decimal: ${s}`);
  const frac = (m[3] ?? '').padEnd(SCALE, '0');
  if (frac.length > SCALE && /[1-9]/.test(frac.slice(SCALE))) throw new Error(`more than ${SCALE} decimals: ${s}`);
  const v = BigInt(m[2]!) * ONE + BigInt(frac.slice(0, SCALE) || '0');
  return m[1] ? -v : v;
}

export function fromUnits(v: Units): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = `${abs / ONE}.${(abs % ONE).toString().padStart(SCALE, '0')}`;
  return neg ? `-${s}` : s;
}

/** Divides with round-half-up (away from zero for the half). */
function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/** v * num / den, rounded half-up at 4 decimals. */
export function mulDiv(v: Units, num: bigint | number, den: bigint | number = 1n): Units {
  return divRound(v * BigInt(num), BigInt(den));
}

/** v * percent / 100 where percent is a decimal string (e.g. "25" or "12.5"). */
export function percentOf(v: Units, percent: string): Units {
  return divRound(v * toUnits(percent), 100n * ONE);
}

/** Rounds to the currency's minor units (e.g. 2 for SAR, 3 for KWD). */
export function roundToMinor(v: Units, minorUnits: number): Units {
  const step = 10n ** BigInt(SCALE - minorUnits);
  return divRound(v, step) * step;
}

export const sum = (values: Units[]): Units => values.reduce((a, b) => a + b, 0n);
export const min = (a: Units, b: Units): Units => (a < b ? a : b);
