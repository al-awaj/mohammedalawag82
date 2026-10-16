/**
 * Statement files to reconciliation lines (clause 39): a CSV export with the columns named by the admin, or an
 * ISO 20022 CAMT.053 bank statement. Parsing only reads the file; nothing is stored until a run is created.
 */
export interface StatementLine { externalRef: string; kind: 'payment' | 'refund'; amount: string; currency: string; status?: 'succeeded' | 'failed' }
export interface Skipped { row: number; reason: string }

export interface CsvMapping {
  reference: string; amount: string; currency?: string | undefined; kind?: string | undefined; status?: string | undefined;
  defaultCurrency?: string | undefined; decimalComma?: boolean | undefined;
}

/** RFC 4180 CSV (quoted fields, doubled quotes); the delimiter is guessed from the header (comma, semicolon or tab). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** "1,234.50", "1.234,50" (with decimalComma), "-75" → absolute decimal string with up to 4 decimals and its sign. */
export function normaliseAmount(raw: string, decimalComma = false): { amount: string; negative: boolean } | null {
  let s = raw.trim().replace(/\s| /g, '').replace(/[^\d.,()+-]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); } else if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/^\+/, '');
  s = decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d{1,16}(\.\d{1,4})?$/.test(s)) return null;
  return { amount: s, negative };
}

const KIND_WORDS: Record<string, 'payment' | 'refund'> = {
  payment: 'payment', charge: 'payment', sale: 'payment', credit: 'payment', crdt: 'payment', 'دفع': 'payment', 'دفعة': 'payment',
  refund: 'refund', debit: 'refund', dbit: 'refund', reversal: 'refund', 'استرداد': 'refund',
};
const STATUS_WORDS: Record<string, 'succeeded' | 'failed'> = {
  succeeded: 'succeeded', success: 'succeeded', paid: 'succeeded', captured: 'succeeded', settled: 'succeeded', book: 'succeeded', completed: 'succeeded',
  failed: 'failed', declined: 'failed', rejected: 'failed', cancelled: 'failed', canceled: 'failed', rjct: 'failed',
};

export function linesFromCsv(text: string, m: CsvMapping): { lines: StatementLine[]; skipped: Skipped[]; columns: string[] } {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim());
  const col = (name: string | undefined) => (name ? header.findIndex((h) => h.toLowerCase() === name.trim().toLowerCase()) : -1);
  const ref = col(m.reference), amt = col(m.amount), cur = col(m.currency), kind = col(m.kind), status = col(m.status);
  const missing = [[m.reference, ref], [m.amount, amt], ...(m.currency ? [[m.currency, cur]] : []), ...(m.kind ? [[m.kind, kind]] : []), ...(m.status ? [[m.status, status]] : [])]
    .filter(([, i]) => i === -1).map(([n]) => n);
  if (missing.length) return { lines: [], skipped: [{ row: 1, reason: `columns not found: ${missing.join(', ')}` }], columns: header };
  const lines: StatementLine[] = [];
  const skipped: Skipped[] = [];
  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const externalRef = (r[ref] ?? '').trim();
    const a = normaliseAmount(r[amt] ?? '', m.decimalComma);
    const currency = (cur >= 0 ? r[cur] ?? '' : m.defaultCurrency ?? '').trim().toUpperCase();
    if (!externalRef) return skipped.push({ row: rowNo, reason: 'empty reference' });
    if (!a) return skipped.push({ row: rowNo, reason: `amount not understood: ${r[amt] ?? ''}` });
    if (!/^[A-Z]{3}$/.test(currency)) return skipped.push({ row: rowNo, reason: `currency not understood: ${currency}` });
    let k: 'payment' | 'refund' | undefined = a.negative ? 'refund' : 'payment';
    if (kind >= 0) k = KIND_WORDS[(r[kind] ?? '').trim().toLowerCase()];
    if (!k) return skipped.push({ row: rowNo, reason: `type not understood: ${r[kind] ?? ''}` });
    const st = status >= 0 ? STATUS_WORDS[(r[status] ?? '').trim().toLowerCase()] : undefined;
    if (status >= 0 && !st) return skipped.push({ row: rowNo, reason: `status not understood: ${r[status] ?? ''}` });
    lines.push({ externalRef: externalRef.slice(0, 200), kind: k, amount: a.amount, currency, ...(st ? { status: st } : {}) });
  });
  return { lines, skipped, columns: header };
}

const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml)?.[1]?.trim();

/**
 * CAMT.053 entries (Ntry): credits are incoming payments, debits refunds. The reference is the end-to-end id, else the
 * bank's reference, else the remittance text, which is where gateways and payers usually put the payment number.
 */
export function linesFromCamt053(xml: string): { lines: StatementLine[]; skipped: Skipped[] } {
  if (!/<(?:\w+:)?BkToCstmrStmt\b/.test(xml)) return { lines: [], skipped: [{ row: 0, reason: 'not a CAMT.053 statement (BkToCstmrStmt missing)' }] };
  const entries = [...xml.matchAll(/<(?:\w+:)?Ntry\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Ntry>/g)].map((m) => m[1]!);
  const lines: StatementLine[] = [];
  const skipped: Skipped[] = [];
  entries.forEach((e, i) => {
    const amt = /<(?:\w+:)?Amt\b[^>]*Ccy="([A-Z]{3})"[^>]*>([^<]+)</.exec(e);
    const side = tag(e, 'CdtDbtInd');
    const ref = tag(e, 'EndToEndId') ?? tag(e, 'AcctSvcrRef') ?? tag(e, 'Ustrd') ?? tag(e, 'NtryRef');
    const stsBlock = tag(e, 'Sts');
    const sts = stsBlock ? tag(stsBlock, 'Cd') ?? stsBlock : undefined;
    const a = amt ? normaliseAmount(amt[2]!) : null;
    if (!a || !amt) return skipped.push({ row: i + 1, reason: 'amount missing' });
    if (!ref || ref === 'NOTPROVIDED') return skipped.push({ row: i + 1, reason: 'reference missing' });
    if (side !== 'CRDT' && side !== 'DBIT') return skipped.push({ row: i + 1, reason: 'credit/debit indicator missing' });
    const status = sts ? STATUS_WORDS[sts.toLowerCase()] : undefined;
    if (sts && /^(pdng|info)$/i.test(sts)) return skipped.push({ row: i + 1, reason: `entry not booked (${sts})` });
    lines.push({ externalRef: ref.slice(0, 200), kind: side === 'CRDT' ? 'payment' : 'refund', amount: a.amount, currency: amt[1]!, ...(status ? { status } : {}) });
  });
  return { lines, skipped };
}
