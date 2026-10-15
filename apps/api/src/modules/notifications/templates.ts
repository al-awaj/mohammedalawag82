/**
 * Default notification texts (Arabic and English), seeded once and then managed from the admin panel.
 * Placeholders are {{name}}; only fields present in the message payload are filled.
 */
export const DEFAULT_TEMPLATES: Record<string, { ar: string; en: string; subjectAr?: string; subjectEn?: string }> = {
  'auth.verify_phone': { ar: 'رمز التحقق: {{code}} (صالح {{expiresInMinutes}} دقائق)', en: 'Your verification code: {{code}} (valid {{expiresInMinutes}} minutes)' },
  'auth.verify_email': { ar: 'رمز التحقق: {{code}}', en: 'Your verification code: {{code}}', subjectAr: 'تأكيد البريد', subjectEn: 'Confirm your email' },
  'auth.reset_password': { ar: 'رمز استعادة كلمة المرور: {{code}}', en: 'Password reset code: {{code}}', subjectAr: 'استعادة كلمة المرور', subjectEn: 'Password reset' },
  'account.welcome': { ar: 'أهلًا {{name}}، تم إنشاء حسابك. أكّد رقم جوالك لتبدأ الحجز.', en: 'Welcome {{name}}, your account is ready. Confirm your phone to start booking.', subjectAr: 'مرحبًا بك', subjectEn: 'Welcome' },
  'account.welcome_provider': { ar: 'أهلًا {{name}}، تم إنشاء حسابك. أكمل طلب التسجيل ووثائقه ليُراجع.', en: 'Welcome {{name}}, your account is ready. Complete your application and documents for review.', subjectAr: 'مرحبًا بك', subjectEn: 'Welcome' },
  'provider_application.needs_info': { ar: 'طلب تسجيلك يحتاج استكمالًا: {{reason}}', en: 'Your application needs more information: {{reason}}' },
  'provider_application.approved': { ar: 'تم قبول طلب تسجيلك كصاحب خدمة', en: 'Your provider application was approved' },
  'provider_application.rejected': { ar: 'تم رفض طلب تسجيلك: {{reason}}', en: 'Your application was rejected: {{reason}}' },
  'provider_application.suspended': { ar: 'تم إيقاف حسابك: {{reason}}', en: 'Your account was suspended: {{reason}}' },
  'provider.profile_change_decided': { ar: 'طلب تعديل بياناتك التجارية: {{status}} {{reason}}', en: 'Your business details change request: {{status}} {{reason}}' },
  'booking.reschedule_requested': { ar: 'طلب العميل تغيير موعد الحجز {{number}} إلى {{newStart}}. وافق أو ارفض من لوحتك قبل انتهاء المهلة.', en: 'The customer asked to move booking {{number}} to {{newStart}}. Approve or reject it in your panel before the deadline.' },
  'booking.rescheduled': { ar: 'تمت الموافقة على تغيير موعد حجزك {{number}} إلى {{newStart}}.', en: 'Your booking {{number}} was moved to {{newStart}}.' },
  'booking.reschedule_rejected': { ar: 'رُفض طلب تغيير موعد حجزك {{number}}: {{reason}}. يبقى الموعد الأصلي كما هو.', en: 'Your request to move booking {{number}} was declined: {{reason}}. The original date stands.' },
  'booking.reschedule_expired': { ar: 'انتهت مهلة طلب تغيير موعد حجزك {{number}} دون رد، ويبقى الموعد الأصلي.', en: 'Your request to move booking {{number}} expired without an answer; the original date stands.' },
  'booking.reschedule_withdrawn': { ar: 'سحب العميل طلب تغيير موعد الحجز {{number}}.', en: 'The customer withdrew the request to move booking {{number}}.' },
  'service.publish': { ar: 'تم نشر خدمتك', en: 'Your service was published' },
  'service.reject': { ar: 'خدمتك تحتاج تعديلًا قبل النشر: {{reason}}', en: 'Your service needs changes before publishing: {{reason}}' },
  'service.unpublish': { ar: 'تم إلغاء نشر خدمتك: {{reason}}', en: 'Your service was unpublished: {{reason}}' },
  'service.suspend': { ar: 'تم إيقاف خدمتك: {{reason}}', en: 'Your service was suspended: {{reason}}' },
  'service.reinstate': { ar: 'تمت إعادة خدمتك (غير منشورة)', en: 'Your service was reinstated (unpublished)' },
  'order.created': { ar: 'تم إنشاء طلبك {{number}}', en: 'Your order {{number}} was created' },
  'booking.created': { ar: 'حجز جديد {{number}}', en: 'New booking {{number}}' },
  'booking.approval_requested': { ar: 'حجز جديد {{number}} بانتظار موافقتك', en: 'New booking {{number}} awaits your approval' },
  'booking.accepted': { ar: 'وافق صاحب الخدمة على حجزك {{number}}، يرجى إكمال الدفع', en: 'Booking {{number}} was accepted, please complete the payment' },
  'booking.rejected': { ar: 'اعتذر صاحب الخدمة عن الحجز {{number}}: {{reason}}', en: 'Booking {{number}} was declined: {{reason}}' },
  'booking.confirmed': { ar: 'تم تأكيد الحجز {{number}}', en: 'Booking {{number}} is confirmed' },
  'booking.cancelled': { ar: 'تم إلغاء الحجز {{number}}', en: 'Booking {{number}} was cancelled' },
  'booking.expired': { ar: 'انتهت مهلة الحجز {{number}}', en: 'Booking {{number}} expired' },
  'booking.hold_expiring': { ar: 'سينتهي الحجز المؤقت {{number}} قريبًا، أكمل الدفع للتأكيد', en: 'Your hold on {{number}} expires soon; pay to confirm' },
  'booking.completed': { ar: 'اكتملت خدمة الحجز {{number}}، يسعدنا تقييمك', en: 'Booking {{number}} is complete; we would love your review' },
  'booking.no_show': { ar: 'سُجل عدم حضور للحجز {{number}}', en: 'A no-show was recorded for booking {{number}}' },
  'booking.cancellation_approved': { ar: 'تمت الموافقة على إلغاء الحجز {{number}}', en: 'Cancellation of booking {{number}} was approved' },
  'booking.cancellation_rejected': { ar: 'لم تتم الموافقة على إلغاء الحجز {{number}}: {{reason}}', en: 'Cancellation of booking {{number}} was not approved: {{reason}}' },
  'booking.balance_reminder': { ar: 'تذكير: المتبقي على الحجز {{number}} هو {{remaining}} {{currency}} ويستحق في {{dueDate}}', en: 'Reminder: {{remaining}} {{currency}} remains on booking {{number}}, due {{dueDate}}' },
  'booking.instalment_reminder': { ar: 'تذكير: القسط رقم {{instalment}} على الحجز {{number}} يستحق في {{dueDate}}، والمطلوب لإتمامه {{remaining}} {{currency}}', en: 'Reminder: instalment {{instalment}} on booking {{number}} is due {{dueDate}}; {{remaining}} {{currency}} completes it' },
  'booking.payment_overdue': { ar: 'تأخر سداد المتبقي على الحجز {{number}}: {{remaining}} {{currency}}', en: 'The remaining {{remaining}} {{currency}} on booking {{number}} is overdue' },
  'booking.event_reminder': { ar: 'تذكير: موعد الحجز {{number}} يقترب ({{startDate}})', en: 'Reminder: booking {{number}} is coming up ({{startDate}})' },
  'event.budget_exceeded': { ar: 'تجاوزت تكلفة مناسبتك "{{name}}" الميزانية', en: 'Your event "{{name}}" is over budget' },
  'payment.succeeded': { ar: 'تم استلام دفعتك {{number}} بمبلغ {{amount}}', en: 'Payment {{number}} of {{amount}} received' },
  'payment.failed': { ar: 'لم تكتمل الدفعة {{number}}: {{reason}}', en: 'Payment {{number}} did not go through: {{reason}}' },
  'refund.requested': { ar: 'استلمنا طلب استرداد {{amount}} ({{number}}) وسيُراجع', en: 'We received a refund request of {{amount}} ({{number}}); it will be reviewed' },
  'refund.failed': { ar: 'تعذر تنفيذ الاسترداد {{number}}: {{reason}}. سنعيد المحاولة.', en: 'Refund {{number}} could not be paid: {{reason}}. We will try again.' },
  'refund.approved': { ar: 'تم اعتماد استرداد {{amount}} ({{number}})', en: 'Refund {{number}} of {{amount}} was approved' },
  'refund.rejected': { ar: 'لم يُعتمد طلب الاسترداد {{number}}: {{reason}}', en: 'Refund {{number}} was not approved: {{reason}}' },
  'refund.completed': { ar: 'تم تنفيذ استرداد {{amount}} ({{number}})', en: 'Refund {{number}} of {{amount}} was paid' },
  'settlement.paid': { ar: 'تم تحويل التسوية {{number}} بمبلغ {{amount}}', en: 'Settlement {{number}} of {{amount}} was paid' },
  'settlement.failed': { ar: 'تعذر تحويل التسوية {{number}}: {{reason}}. ستُعاد المستحقات للتسوية التالية.', en: 'Settlement {{number}} could not be paid: {{reason}}. The earnings return to the next settlement.' },
  'earning.updated': { ar: 'تم تحديث مستحقاتك للحجز {{number}}: {{amount}} {{currency}}', en: 'Your earnings for booking {{number}} were updated: {{amount}} {{currency}}' },
  'dispute.opened': { ar: 'تم فتح النزاع {{number}}', en: 'Dispute {{number}} was opened' },
  'dispute.updated': { ar: 'تحديث على النزاع {{number}}: {{note}}', en: 'Update on dispute {{number}}: {{note}}' },
  'dispute.info_requested': { ar: 'مطلوب منك معلومات إضافية في النزاع {{number}}: {{note}}', en: 'More information is needed for dispute {{number}}: {{note}}' },
  'dispute.decided': { ar: 'صدر قرار في النزاع {{number}}: {{note}}', en: 'A decision was made on dispute {{number}}: {{note}}' },
  'dispute.closed': { ar: 'تم إغلاق النزاع {{number}}', en: 'Dispute {{number}} was closed' },
};

/** Payload fields never kept in the stored copy of a message (clause 54: no needless exposure). */
export const SECRET_PAYLOAD_KEYS = ['code'];

export function render(text: string, payload: Record<string, unknown>, mask = false): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = payload[key];
    if (v === undefined || v === null) return '';
    if (mask && SECRET_PAYLOAD_KEYS.includes(key)) return '••••••';
    if (v instanceof Date) return v.toISOString();
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
