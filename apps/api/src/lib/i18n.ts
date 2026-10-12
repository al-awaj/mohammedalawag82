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
