/**
 * CSV export (clause 63). UTF-8 with BOM so spreadsheet apps read Arabic correctly. Cells that would be
 * read as formulas are neutralised (CSV injection); plain numbers, including negatives, stay numbers.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
