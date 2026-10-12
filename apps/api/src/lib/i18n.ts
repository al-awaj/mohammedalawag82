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
