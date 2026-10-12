/**
 * Printable HTML for documents and statements (clause 65): bilingual, right-to-left for Arabic and
 * left-to-right for English, rendered only from the frozen document data (or the statement payload).
 */
type Lang = 'ar' | 'en';

const L: Record<string, { ar: string; en: string }> = {
  invoice: { ar: 'فاتورة حجز', en: 'Booking invoice' },
  payment_receipt: { ar: 'إيصال دفع', en: 'Payment receipt' },
  deposit_receipt: { ar: 'إيصال عربون', en: 'Deposit receipt' },
  refund_note: { ar: 'إشعار استرداد', en: 'Refund note' },
  settlement_note: { ar: 'إشعار تسوية', en: 'Settlement note' },
  booking_statement: { ar: 'كشف حجز', en: 'Booking statement' },
  balance_notice: { ar: 'إشعار رصيد متبقٍ', en: 'Balance notice' },
  payment_history: { ar: 'سجل المدفوعات', en: 'Payment history' },
  dispute_record: { ar: 'سجل نزاع', en: 'Dispute record' },
  number: { ar: 'الرقم', en: 'Number' },
  issuedAt: { ar: 'تاريخ الإصدار', en: 'Issued at' },
  generatedAt: { ar: 'تاريخ الإنشاء', en: 'Generated at' },
  customer: { ar: 'العميل', en: 'Customer' },
  provider: { ar: 'صاحب الخدمة', en: 'Provider' },
  booking: { ar: 'الحجز', en: 'Booking' },
  service: { ar: 'الخدمة', en: 'Service' },
  date: { ar: 'الموعد', en: 'Date' },
  description: { ar: 'البيان', en: 'Description' },
  unitPrice: { ar: 'سعر الوحدة', en: 'Unit price' },
  quantity: { ar: 'الكمية', en: 'Quantity' },
  subtotal: { ar: 'المجموع قبل الخصم', en: 'Subtotal' },
  discount: { ar: 'الخصم', en: 'Discount' },
  total: { ar: 'الإجمالي', en: 'Total' },
  paid: { ar: 'المدفوع', en: 'Paid' },
  remaining: { ar: 'المتبقي', en: 'Remaining' },
  amount: { ar: 'المبلغ', en: 'Amount' },
  method: { ar: 'طريقة الدفع', en: 'Method' },
  reference: { ar: 'المرجع', en: 'Reference' },
  reason: { ar: 'السبب', en: 'Reason' },
  taxIncluded: { ar: 'يشمل الإجمالي', en: 'Total includes' },
  balanceDueAt: { ar: 'موعد استحقاق المتبقي', en: 'Balance due' },
  status: { ar: 'الحالة', en: 'Status' },
  applied: { ar: 'المخصص للحجز', en: 'Applied' },
  commission: { ar: 'العمولة', en: 'Commission' },
  notDocument: { ar: 'كشف للاطلاع وليس مستندًا مرقمًا', en: 'Statement for information; not a numbered document' },
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const t = (k: string, lang: Lang) => L[k]?.[lang] ?? k;
/** Localised text from an i18n object ({ar, en}) with fallback to the other language. */
const loc = (v: unknown, lang: Lang): string => {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return String(o[lang] ?? o.ar ?? o.en ?? '');
  }
  return v instanceof Date ? v.toISOString() : String(v ?? '');
};
const dt = (v: unknown, lang: Lang) => {
  if (!v) return '';
  const d = new Date(String(v instanceof Date ? v.toISOString() : v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(lang === 'ar' ? 'ar' : 'en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
};
const row = (label: string, value: string) => (value ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>` : '');

export function renderHtml(doc: { kind: string; number?: string | null; issuedAt?: unknown; data: Record<string, any> }, lang: Lang): string {
  const d = doc.data;
  const cur = d.currency ? ` ${d.currency}` : '';
  const money = (v: unknown) => (v === null || v === undefined ? '' : `${v}${cur}`);
  const parts: string[] = [];
  parts.push('<table class="meta">');
  if (doc.number) parts.push(row(t('number', lang), doc.number));
  parts.push(row(t(doc.number ? 'issuedAt' : 'generatedAt', lang), dt(doc.issuedAt ?? d.generatedAt, lang)));
  if (d.bookingNumber) parts.push(row(t('booking', lang), d.bookingNumber));
  if (d.service) parts.push(row(t('service', lang), loc(d.service, lang)));
  if (d.startAt) parts.push(row(t('date', lang), dt(d.startAt, lang)));
  if (d.customer?.name) parts.push(row(t('customer', lang), d.customer.name));
  if (d.provider?.name) parts.push(row(t('provider', lang), d.provider.name));
  if (d.method) parts.push(row(t('method', lang), d.method));
  if (d.reference) parts.push(row(t('reference', lang), d.reference));
  if (d.reason) parts.push(row(t('reason', lang), d.reason));
  if (d.status) parts.push(row(t('status', lang), d.status));
  parts.push('</table>');

  if (Array.isArray(d.lines)) {
    parts.push(`<table class="lines"><thead><tr><th>${t('description', lang)}</th><th>${t('unitPrice', lang)}</th><th>${t('quantity', lang)}</th></tr></thead><tbody>`);
    for (const l of d.lines) parts.push(`<tr><td>${esc(loc(l.description, lang))}</td><td>${esc(money(l.unitPrice))}</td><td>${esc(l.quantity)}</td></tr>`);
    parts.push('</tbody></table>');
  }
  if (Array.isArray(d.bookings)) {
    parts.push(`<table class="lines"><thead><tr><th>${t('booking', lang)}</th><th>${t('provider', lang)}</th><th>${t('applied', lang)}</th><th>${t('remaining', lang)}</th></tr></thead><tbody>`);
    for (const b of d.bookings) parts.push(`<tr><td>${esc(b.bookingNumber)}</td><td>${esc(b.provider)}</td><td>${esc(money(b.applied))}</td><td>${esc(money(b.remainingAfter))}</td></tr>`);
    parts.push('</tbody></table>');
  }
  if (Array.isArray(d.items)) {
    parts.push(`<table class="lines"><thead><tr><th>${t('booking', lang)}</th><th>${t('commission', lang)}</th><th>${t('amount', lang)}</th></tr></thead><tbody>`);
    for (const i of d.items) parts.push(`<tr><td>${esc(i.bookingNumber)}</td><td>${esc(money(i.commission))}</td><td>${esc(money(i.amount))}</td></tr>`);
    parts.push('</tbody></table>');
  }
  if (Array.isArray(d.payments)) {
    parts.push(`<table class="lines"><thead><tr><th>${t('number', lang)}</th><th>${t('method', lang)}</th><th>${t('status', lang)}</th><th>${t('paid', lang)}</th></tr></thead><tbody>`);
    for (const p of d.payments) parts.push(`<tr><td>${esc(p.number)}</td><td>${esc(p.method)}</td><td>${esc(p.status)}</td><td>${esc(p.verifiedAmount ?? '')} ${esc(p.currency ?? d.currency ?? '')}</td></tr>`);
    parts.push('</tbody></table>');
  }

  parts.push('<table class="totals">');
  parts.push(row(t('subtotal', lang), d.lines ? money(d.subtotal) : ''));
  if (d.discount && d.discount !== '0.0000') parts.push(row(t('discount', lang), money(d.discount)));
  parts.push(row(t(doc.kind === 'invoice' || d.lines ? 'total' : 'amount', lang), money(d.total ?? d.amount)));
  if (d.tax) parts.push(row(`${t('taxIncluded', lang)} ${loc(d.tax.label, lang)} ${d.tax.rate}%`, money(d.tax.includedAmount)));
  parts.push(row(t('paid', lang), money(d.paid ?? d.paidAtIssue)));
  parts.push(row(t('remaining', lang), money(d.remaining ?? d.remainingAtIssue)));
  parts.push(row(t('balanceDueAt', lang), d.balanceDueAt ? dt(d.balanceDueAt, lang) : ''));
  parts.push('</table>');

  const issuer = d.issuer && typeof d.issuer === 'object' ? Object.values(d.issuer).map((v) => loc(v, lang)).filter(Boolean) : [];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(t(doc.kind, lang))} ${esc(doc.number ?? '')}</title>
<style>body{font-family:system-ui,'Noto Naskh Arabic',sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ccc;padding:6px;text-align:start}
.meta th,.totals th{width:35%;background:#f5f5f5}.note{color:#555;font-size:12px}@media print{body{margin:0}}</style></head>
<body><header><div>${esc(loc(d.platformName, lang))}</div>${issuer.map((x) => `<div class="note">${esc(x)}</div>`).join('')}
<h1>${esc(t(doc.kind, lang))}</h1>${doc.number ? '' : `<div class="note">${t('notDocument', lang)}</div>`}</header>
${parts.join('\n')}</body></html>`;
}
