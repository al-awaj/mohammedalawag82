import type { Lang } from './format';

type Dict = Record<string, { ar: string; en: string }>;

/** Labels for the API's enumerations, so every interface names a status the same way. */
export const ENUMS: Record<string, Dict> = {
  booking: {
    pending_provider_approval: { ar: 'بانتظار موافقة صاحب الخدمة', en: 'Awaiting provider approval' },
    awaiting_payment: { ar: 'بانتظار الدفع', en: 'Awaiting payment' },
    confirmed: { ar: 'مؤكد', en: 'Confirmed' },
    in_progress: { ar: 'قيد التنفيذ', en: 'In progress' },
    completed: { ar: 'مكتمل', en: 'Completed' },
    no_show: { ar: 'لم يحضر', en: 'No-show' },
    rejected: { ar: 'مرفوض', en: 'Rejected' },
    expired: { ar: 'منتهي', en: 'Expired' },
    cancelled_by_customer: { ar: 'ألغاه العميل', en: 'Cancelled by customer' },
    cancelled_by_provider: { ar: 'ألغاه صاحب الخدمة', en: 'Cancelled by provider' },
    cancelled_by_admin: { ar: 'ألغته الإدارة', en: 'Cancelled by admin' },
  },
  payment: {
    pending: { ar: 'قيد الانتظار', en: 'Pending' },
    awaiting_verification: { ar: 'بانتظار التحقق', en: 'Awaiting verification' },
    succeeded: { ar: 'ناجحة', en: 'Succeeded' },
    failed: { ar: 'فاشلة', en: 'Failed' },
    cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  },
  paymentMethod: {
    card: { ar: 'بطاقة', en: 'Card' }, wallet: { ar: 'محفظة إلكترونية', en: 'Wallet' },
    bank_transfer: { ar: 'تحويل بنكي', en: 'Bank transfer' }, cash: { ar: 'نقدًا', en: 'Cash' },
    original_gateway: { ar: 'نفس وسيلة الدفع', en: 'Original method' },
  },
  paymentModel: {
    platform: { ar: 'عبر المنصة', en: 'Through the platform' },
    direct: { ar: 'مباشرة لصاحب الخدمة', en: 'Directly to the provider' },
  },
  refund: {
    requested: { ar: 'مطلوب', en: 'Requested' }, approved: { ar: 'معتمد', en: 'Approved' },
    processing: { ar: 'قيد التنفيذ', en: 'Processing' }, completed: { ar: 'مكتمل', en: 'Completed' },
    rejected: { ar: 'مرفوض', en: 'Rejected' }, failed: { ar: 'فشل', en: 'Failed' },
  },
  settlement: {
    pending_approval: { ar: 'بانتظار الاعتماد', en: 'Pending approval' }, approved: { ar: 'معتمدة', en: 'Approved' },
    paid: { ar: 'مدفوعة', en: 'Paid' }, failed: { ar: 'فشلت', en: 'Failed' }, cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  },
  earning: {
    not_due: { ar: 'غير مستحق بعد', en: 'Not due yet' }, under_review: { ar: 'قيد المراجعة', en: 'Under review' },
    due: { ar: 'مستحق', en: 'Due' }, on_hold_dispute: { ar: 'معلق بسبب نزاع', en: 'On hold (dispute)' },
    ready_for_settlement: { ar: 'جاهز للتسوية', en: 'Ready for settlement' }, settled: { ar: 'مُسوّى', en: 'Settled' },
    settlement_failed: { ar: 'فشلت التسوية', en: 'Settlement failed' }, re_reviewed: { ar: 'أعيدت مراجعته', en: 'Re-reviewed' },
  },
  dispute: {
    new: { ar: 'جديد', en: 'New' }, under_review: { ar: 'قيد المراجعة', en: 'Under review' },
    awaiting_info: { ar: 'بانتظار معلومات', en: 'Awaiting information' }, awaiting_response: { ar: 'بانتظار رد الطرف الآخر', en: 'Awaiting response' },
    deciding: { ar: 'قيد القرار', en: 'Deciding' }, resolution_approved: { ar: 'تم اعتماد الحل', en: 'Resolution approved' },
    rejected: { ar: 'مرفوض', en: 'Rejected' }, settled: { ar: 'تمت التسوية', en: 'Settled' }, closed: { ar: 'مغلق', en: 'Closed' },
  },
  disputeType: {
    service_not_delivered: { ar: 'لم تُقدَّم الخدمة', en: 'Service not delivered' }, service_quality: { ar: 'جودة الخدمة', en: 'Service quality' },
    billing: { ar: 'الفوترة', en: 'Billing' }, refund: { ar: 'استرداد', en: 'Refund' },
    damage: { ar: 'أضرار', en: 'Damage' }, behaviour: { ar: 'السلوك', en: 'Behaviour' }, other: { ar: 'أخرى', en: 'Other' },
  },
  service: {
    draft: { ar: 'مسودة', en: 'Draft' }, pending_review: { ar: 'بانتظار المراجعة', en: 'Pending review' },
    published: { ar: 'منشورة', en: 'Published' }, rejected: { ar: 'مرفوضة', en: 'Rejected' },
    unpublished: { ar: 'غير منشورة', en: 'Unpublished' }, suspended: { ar: 'موقوفة', en: 'Suspended' },
  },
  application: {
    draft: { ar: 'مسودة', en: 'Draft' }, submitted: { ar: 'مُرسل', en: 'Submitted' }, under_review: { ar: 'قيد المراجعة', en: 'Under review' },
    needs_info: { ar: 'مطلوب معلومات', en: 'Information requested' }, approved: { ar: 'مقبول', en: 'Approved' },
    rejected: { ar: 'مرفوض', en: 'Rejected' }, suspended: { ar: 'موقوف', en: 'Suspended' }, cancelled: { ar: 'ملغى', en: 'Cancelled' },
  },
  provider: {
    active: { ar: 'نشط', en: 'Active' }, suspended: { ar: 'موقوف', en: 'Suspended' },
  },
  document: {
    invoice: { ar: 'فاتورة', en: 'Invoice' }, payment_receipt: { ar: 'إيصال دفع', en: 'Payment receipt' },
    deposit_receipt: { ar: 'إيصال عربون', en: 'Deposit receipt' }, refund_note: { ar: 'إشعار استرداد', en: 'Refund note' },
    settlement_note: { ar: 'إشعار تسوية', en: 'Settlement note' },
  },
  reconciliation: {
    matched: { ar: 'مطابق', en: 'Matched' }, amount_mismatch: { ar: 'فرق في المبلغ', en: 'Amount mismatch' },
    currency_mismatch: { ar: 'فرق في العملة', en: 'Currency mismatch' }, missing_in_platform: { ar: 'غير موجود في المنصة', en: 'Missing in platform' },
    missing_in_statement: { ar: 'غير موجود في الكشف', en: 'Missing in statement' }, status_mismatch: { ar: 'فرق في الحالة', en: 'Status mismatch' },
  },
  review: {
    published: { ar: 'منشور', en: 'Published' }, pending_moderation: { ar: 'بانتظار المراجعة', en: 'Pending moderation' }, hidden: { ar: 'مخفي', en: 'Hidden' },
  },
  notification: {
    pending: { ar: 'بانتظار الإرسال', en: 'Pending' }, sent: { ar: 'أُرسل', en: 'Sent' }, failed: { ar: 'فشل', en: 'Failed' },
  },
  user: {
    active: { ar: 'نشط', en: 'Active' }, disabled: { ar: 'معطل', en: 'Disabled' },
  },
  eventType: {
    wedding: { ar: 'زفاف', en: 'Wedding' }, engagement: { ar: 'خطوبة', en: 'Engagement' }, birthday: { ar: 'عيد ميلاد', en: 'Birthday' },
    graduation: { ar: 'تخرج', en: 'Graduation' }, success: { ar: 'حفل نجاح', en: 'Success celebration' }, family: { ar: 'مناسبة عائلية', en: 'Family occasion' },
    conference: { ar: 'مؤتمر', en: 'Conference' }, official: { ar: 'مناسبة رسمية', en: 'Official occasion' }, religious: { ar: 'مناسبة دينية', en: 'Religious occasion' },
    social: { ar: 'مناسبة اجتماعية', en: 'Social occasion' }, other: { ar: 'أخرى', en: 'Other' },
  },
  event: {
    planning: { ar: 'قيد التخطيط', en: 'Planning' }, confirmed: { ar: 'مؤكدة', en: 'Confirmed' }, completed: { ar: 'منتهية', en: 'Completed' }, cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  },
};

export const EVENT_TYPES = Object.keys(ENUMS.eventType!);
export const EVENT_STATUSES = Object.keys(ENUMS.event!);

/** Label for an enumeration value; unknown values are shown as received rather than hidden. */
export function enumLabel(group: string, value: string | null | undefined, lang: Lang): string {
  if (!value) return '—';
  return ENUMS[group]?.[value]?.[lang] ?? value;
}

/** Creates a translator over a dictionary; `{name}` placeholders are replaced from `vars`. */
export function makeT<D extends Dict>(dict: D) {
  return (lang: Lang, key: keyof D & string, vars?: Record<string, string | number>) => {
    let s = dict[key]?.[lang] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}
