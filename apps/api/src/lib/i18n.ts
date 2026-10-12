export const SUPPORTED_LANGUAGES = ['ar', 'en'] as const;
export type Lang = (typeof SUPPORTED_LANGUAGES)[number];

export type I18nText = Partial<Record<string, string>>;

const messages: Record<string, Record<Lang, string>> = {
  VALIDATION_FAILED: { ar: 'البيانات المدخلة غير صحيحة', en: 'The submitted data is invalid' },
  NOT_FOUND: { ar: 'العنصر المطلوب غير موجود', en: 'The requested resource was not found' },
  INTERNAL_ERROR: { ar: 'حدث خطأ غير متوقع', en: 'An unexpected error occurred' },
  RATE_LIMITED: { ar: 'عدد الطلبات كبير، حاول لاحقًا', en: 'Too many requests, try again later' },
  AUTH_REQUIRED: { ar: 'يجب تسجيل الدخول', en: 'Authentication is required' },
  AUTH_INVALID_TOKEN: { ar: 'رمز الدخول غير صالح أو منتهي', en: 'The access token is invalid or expired' },
  AUTH_INVALID_CREDENTIALS: { ar: 'بيانات الدخول غير صحيحة', en: 'Invalid credentials' },
  AUTH_ACCOUNT_LOCKED: { ar: 'الحساب مقفل مؤقتًا بسبب محاولات فاشلة', en: 'Account temporarily locked after failed attempts' },
  AUTH_ACCOUNT_DISABLED: { ar: 'الحساب معطل', en: 'The account is disabled' },
  AUTH_INVALID_REFRESH: { ar: 'جلسة غير صالحة، يرجى تسجيل الدخول مجددًا', en: 'Invalid session, please sign in again' },
  FORBIDDEN: { ar: 'لا تملك صلاحية تنفيذ هذه العملية', en: 'You are not allowed to perform this action' },
  TERMS_NOT_ACCEPTED: { ar: 'يجب الموافقة على الشروط وسياسة الخصوصية', en: 'You must accept the terms and privacy policy' },
  TERMS_NOT_PUBLISHED: { ar: 'لا توجد شروط منشورة لهذه الدولة', en: 'No published terms exist for this country' },
  PHONE_TAKEN: { ar: 'رقم الهاتف مستخدم مسبقًا', en: 'The phone number is already registered' },
  EMAIL_TAKEN: { ar: 'البريد الإلكتروني مستخدم مسبقًا', en: 'The email is already registered' },
  COUNTRY_NOT_AVAILABLE: { ar: 'الدولة غير متاحة', en: 'The country is not available' },
  PHONE_COUNTRY_MISMATCH: { ar: 'رقم الهاتف لا يطابق مفتاح الدولة', en: 'The phone number does not match the country prefix' },
  LANGUAGE_NOT_SUPPORTED: { ar: 'اللغة غير مدعومة', en: 'The language is not supported' },
  CODE_INVALID: { ar: 'رمز التحقق غير صحيح أو منتهي', en: 'The verification code is invalid or expired' },
  CODE_TOO_MANY_ATTEMPTS: { ar: 'تجاوزت عدد المحاولات، اطلب رمزًا جديدًا', en: 'Too many attempts, request a new code' },
  CONTACT_MISSING: { ar: 'لا توجد وسيلة تواصل لهذا النوع من التحقق', en: 'No contact exists for this verification type' },
  PHONE_NOT_VERIFIED: { ar: 'يجب التحقق من رقم الهاتف أولًا', en: 'Verify your phone number first' },
  INVALID_REFERENCE: { ar: 'أحد المعرفات المرسلة غير موجود', en: 'A referenced record does not exist' },
  PROVIDER_NOT_ACTIVE: { ar: 'حساب صاحب الخدمة غير مفعل أو موقوف', en: 'The provider account is not active' },
  SERVICE_TYPE_NOT_ALLOWED: { ar: 'غير مصرح لك بتقديم هذا النوع من الخدمات', en: 'You are not allowed to offer this service type' },
  SERVICE_TYPE_INACTIVE: { ar: 'نوع الخدمة غير مفعل', en: 'The service type is inactive' },
  ATTRIBUTES_INVALID: { ar: 'بيانات الخدمة الخاصة بنوعها غير صحيحة', en: 'The service-type specific fields are invalid' },
  CURRENCY_NOT_ALLOWED: { ar: 'العملة غير مسموحة في دولة الخدمة', en: 'The currency is not allowed in the service country' },
  PRICING_UNIT_NOT_ALLOWED: { ar: 'طريقة التسعير غير مسموحة لهذا النوع', en: 'The pricing unit is not allowed for this type' },
  CAPACITY_REQUIRED: { ar: 'يجب تحديد السعة لهذا النوع من الخدمات', en: 'Capacity is required for this service type' },
  CAPACITY_NOT_APPLICABLE: { ar: 'السعة لا تنطبق على هذا النوع', en: 'Capacity does not apply to this service type' },
  MEDIA_LIMIT_REACHED: { ar: 'تم الوصول للحد الأقصى من الصور', en: 'Maximum number of images reached' },
  VIDEO_NOT_ALLOWED: { ar: 'الفيديو غير مسموح لهذا النوع', en: 'Videos are not allowed for this type' },
  MIN_IMAGES_REQUIRED: { ar: 'يجب رفع الحد الأدنى من الصور', en: 'The minimum number of images is required' },
  PACKAGE_REQUIRED: { ar: 'يجب إضافة باقة مفعلة واحدة على الأقل', en: 'At least one active package is required' },
  PACKAGES_NOT_ALLOWED: { ar: 'هذا النوع لا يدعم الباقات', en: 'This type does not support packages' },
  RENTAL_ITEMS_NOT_ALLOWED: { ar: 'هذا النوع لا يدعم المنتجات المؤجرة', en: 'This type does not support rentable items' },
  DEPOSIT_REQUIRED: { ar: 'هذا النوع يتطلب عربونًا لا يقل عن الحد الأدنى', en: 'This type requires a deposit of at least the minimum' },
  FIELD_DEFINITION_INVALID: { ar: 'تعريف الحقل غير صحيح', en: 'Invalid field definition' },
  FIELD_TYPE_LOCKED: { ar: 'لا يمكن تغيير نوع حقل مستخدم', en: 'The data type of a used field cannot change' },
  CATEGORY_CYCLE: { ar: 'لا يمكن جعل التصنيف تابعًا لنفسه أو لأحد فروعه', en: 'A category cannot be nested under itself' },
  CATEGORY_NOT_AVAILABLE: { ar: 'التصنيف غير متاح في هذه الدولة', en: 'The category is not available in this country' },
  POLICY_NOT_USABLE: { ar: 'سياسة الإلغاء غير متاحة', en: 'The cancellation policy cannot be used' },
  CURRENCY_REQUIRED_FOR_PRICE_FILTER: { ar: 'يجب تحديد العملة عند التصفية بالسعر', en: 'A currency is required when filtering by price' },
  SLOT_UNAVAILABLE: { ar: 'الموعد غير متاح', en: 'The requested time is not available' },
  PERIOD_INVALID: { ar: 'الفترة الزمنية غير صحيحة', en: 'The time period is invalid' },
  PERIOD_IN_PAST: { ar: 'لا يمكن الحجز في وقت مضى', en: 'The period is in the past' },
  OUTSIDE_SCHEDULE: { ar: 'الموعد خارج أوقات العمل', en: 'The period is outside working hours' },
  RENTAL_ITEM_REQUIRED: { ar: 'يجب تحديد المنتج المؤجر', en: 'A rental item must be specified' },
  RULES_OVERLAP: { ar: 'أوقات العمل متداخلة في اليوم نفسه', en: 'Working hours overlap on the same day' },
  SERVICE_NOT_BOOKABLE: { ar: 'الخدمة غير متاحة للحجز حاليًا', en: 'The service cannot be booked right now' },
  BLOCK_NOT_RELEASABLE: { ar: 'لا يمكن تحرير هذا الموعد من هنا', en: 'This entry cannot be released here' },
  PACKAGE_NOT_AVAILABLE: { ar: 'الباقة غير متاحة في هذا التاريخ', en: 'The package is not available on this date' },
  ADD_ON_INVALID: { ar: 'إضافة غير موجودة في الباقة', en: 'An add-on does not belong to the package' },
  GUESTS_REQUIRED: { ar: 'يجب تحديد عدد الضيوف', en: 'The number of guests is required' },
  CAPACITY_EXCEEDED: { ar: 'العدد يتجاوز سعة الخدمة', en: 'The number exceeds the service capacity' },
  PACKAGE_FULL: { ar: 'تم الوصول للحد الأقصى لحجوزات هذه الباقة في هذا الموعد', en: 'This package is fully booked for that time' },
  CART_EMPTY: { ar: 'السلة فارغة', en: 'The cart is empty' },
  MIXED_CURRENCIES: { ar: 'لا يمكن إتمام خدمات بعملات أو دول مختلفة في طلب واحد', en: 'Items in different currencies or countries must be checked out separately' },
  PRICE_CHANGED: { ar: 'تغير السعر منذ إضافة الخدمة للسلة، يرجى المراجعة', en: 'The price changed since the item was added; please review' },
  EVENT_NOT_FOUND: { ar: 'المناسبة غير موجودة', en: 'Event not found' },
  IDEMPOTENCY_KEY_REQUIRED: { ar: 'مفتاح منع التكرار مطلوب', en: 'An Idempotency-Key header is required' },
  CANCELLATION_REQUIRES_REFUND_FLOW: { ar: 'إلغاء الحجز المدفوع يتم عبر إجراءات الإلغاء والاسترداد', en: 'Paid bookings are cancelled through the cancellation and refund process' },
  PAYMENT_METHOD_NOT_AVAILABLE: { ar: 'طريقة الدفع غير متاحة لهذه الحجوزات', en: 'This payment method is not available for these bookings' },
  PAYMENT_IN_PROGRESS: { ar: 'توجد عملية دفع قيد التنفيذ لهذا الحجز', en: 'A payment for this booking is already in progress' },
  NOTHING_TO_PAY: { ar: 'لا يوجد مبلغ مستحق للدفع الآن', en: 'Nothing is due for payment right now' },
  PROOF_REQUIRED: { ar: 'يجب إرفاق إثبات الدفع', en: 'A proof of payment is required' },
  INTEGRATION_NOT_CONFIGURED: { ar: 'تكامل الدفع غير مهيأ', en: 'The payment integration is not configured' },
  WEBHOOK_SIGNATURE_INVALID: { ar: 'توقيع الإشعار غير صالح', en: 'Invalid notification signature' },
  ACCOUNT_KIND_NOT_ALLOWED: { ar: 'لا يمكن إنشاء هذا النوع من الحسابات يدويًا', en: 'This account kind cannot be created manually' },
  ACCOUNT_HAS_BALANCE: { ar: 'لا يمكن تعطيل حساب عليه رصيد أو مرتبط بطريقة دفع مفعلة', en: 'An account with a balance or an active payment method cannot be disabled' },
  REFUND_EXCEEDS_REFUNDABLE: { ar: 'مبلغ الاسترداد يتجاوز المبلغ القابل للاسترداد', en: 'The refund exceeds the refundable amount' },
  FOUR_EYES_REQUIRED: { ar: 'يجب أن يعتمد العملية موظف آخر غير من أنشأها', en: 'A different staff member must approve this' },
  CANCELLATION_NOT_ALLOWED: { ar: 'لا يمكن إلغاء هذا الحجز وفق السياسة أو الحالة الحالية', en: 'This booking cannot be cancelled under its policy or current status' },
  CANCELLATION_ALREADY_REQUESTED: { ar: 'يوجد طلب إلغاء قيد المراجعة لهذا الحجز', en: 'A cancellation request for this booking is already under review' },
  NOTHING_TO_SETTLE: { ar: 'لا توجد مستحقات جاهزة للتسوية', en: 'There is nothing ready to settle' },
  INTERIM_NOT_ALLOWED: { ar: 'صاحب الخدمة غير مؤهل للتسوية المرحلية أو المبلغ يتجاوز الحد المسموح', en: 'The provider is not eligible for interim settlement or the amount exceeds the allowed limit' },
  DISPUTE_ALREADY_OPEN: { ar: 'يوجد نزاع مفتوح منك على هذا الحجز', en: 'You already have an open dispute on this booking' },
  NOTHING_TO_HOLD: { ar: 'لا توجد مستحقات معترف بها لهذا الحجز يمكن تعليقها', en: 'There is no recognised earning on this booking to hold' },
  COUPON_INVALID: { ar: 'الكوبون غير صالح أو منتهٍ أو لا ينطبق على هذه الخدمات', en: 'The coupon is invalid, expired or not applicable' },
  COUPON_LIMIT_REACHED: { ar: 'تم استنفاد عدد مرات استخدام الكوبون', en: 'The coupon usage limit has been reached' },
  REVIEW_NOT_ALLOWED: { ar: 'لا يمكن تقييم هذا الحجز', en: 'This booking cannot be reviewed' },
  FX_RATE_MISSING: { ar: 'لا يوجد سعر صرف معتمد للتحويل في التاريخ المطلوب', en: 'No approved exchange rate for the requested conversion date' },
  RECONCILIATION_ITEM_RESOLVED: { ar: 'تمت معالجة هذا البند مسبقًا', en: 'This item has already been resolved' },
  ALREADY_VERIFIED: { ar: 'تم التحقق مسبقًا', en: 'Already verified' },
  INVALID_STATUS_TRANSITION: { ar: 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية', en: 'This action is not allowed in the current status' },
  REASON_REQUIRED: { ar: 'يجب ذكر السبب', en: 'A reason is required' },
  APPLICATION_OPEN_EXISTS: { ar: 'لديك طلب تسجيل قائم بالفعل', en: 'You already have an open application' },
  APPLICATION_INCOMPLETE: { ar: 'الطلب ناقص: يجب إرفاق الوثائق المطلوبة', en: 'Application incomplete: required documents are missing' },
  FILE_TYPE_NOT_ALLOWED: { ar: 'نوع الملف غير مسموح', en: 'File type not allowed' },
  FILE_TOO_LARGE: { ar: 'حجم الملف أكبر من المسموح', en: 'File is too large' },
  CURRENCY_NOT_FOUND: { ar: 'العملة غير موجودة أو غير مفعلة', en: 'Currency not found or inactive' },
  CURRENCY_IN_USE: { ar: 'العملة مستخدمة كعملة أساسية لدولة مفعلة', en: 'Currency is the base currency of an active country' },
  CODE_TAKEN: { ar: 'الرمز مستخدم مسبقًا', en: 'The code is already in use' },
  SYSTEM_ROLE_LOCKED: { ar: 'لا يمكن حذف دور نظامي', en: 'System roles cannot be deleted' },
  ROLE_IN_USE: { ar: 'الدور مسند لمستخدمين', en: 'The role is assigned to users' },
  UNKNOWN_PERMISSION: { ar: 'صلاحية غير معروفة', en: 'Unknown permission' },
  CANNOT_MODIFY_SELF: { ar: 'لا يمكنك تعديل صلاحياتك أو حالتك بنفسك', en: 'You cannot change your own roles or status' },
  UNKNOWN_SETTING: { ar: 'إعداد غير معروف', en: 'Unknown setting' },
  INVALID_SETTING_VALUE: { ar: 'قيمة الإعداد غير صالحة', en: 'Invalid setting value' },
  SCOPE_NOT_ALLOWED: { ar: 'هذا الإعداد لا يقبل هذا النطاق', en: 'This setting does not support this scope' },
};

export function pickLang(header: string | undefined, fallback: Lang = 'ar'): Lang {
  if (!header) return fallback;
  for (const part of header.split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if ((SUPPORTED_LANGUAGES as readonly string[]).includes(code)) return code as Lang;
  }
  return fallback;
}

export function t(code: string, lang: Lang): string {
  return messages[code]?.[lang] ?? messages[code]?.en ?? code;
}

/** Picks a translated value, falling back to the other supported language. */
export function localize(text: I18nText | null | undefined, lang: Lang): string | null {
  if (!text) return null;
  return text[lang] ?? text.en ?? text.ar ?? Object.values(text)[0] ?? null;
}
