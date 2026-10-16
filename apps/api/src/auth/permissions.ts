/**
 * Permission catalog — the single source of truth. `seed-reference` syncs it into the
 * `permissions` table; routes reference these codes. See docs/04-roles-permissions.md.
 */
export const PERMISSIONS = {
  // Identity & staff
  'users.view': { module: 'users', ar: 'عرض المستخدمين', en: 'View users' },
  'users.manage': { module: 'users', ar: 'إدارة الموظفين والمستخدمين', en: 'Manage staff and users' },
  'roles.view': { module: 'users', ar: 'عرض الأدوار والصلاحيات', en: 'View roles and permissions' },
  'roles.manage': { module: 'users', ar: 'إدارة الأدوار والصلاحيات', en: 'Manage roles and permissions' },
  'customers.view': { module: 'users', ar: 'عرض بيانات العملاء', en: 'View customer data' },
  // Providers
  'providers.view': { module: 'providers', ar: 'عرض أصحاب الخدمات', en: 'View service providers' },
  'providers.view_sensitive': { module: 'providers', ar: 'عرض البيانات المالية لأصحاب الخدمات', en: 'View provider financial details' },
  'providers.manage': { module: 'providers', ar: 'إيقاف وإعادة تفعيل أصحاب الخدمات', en: 'Suspend and reactivate providers' },
  'provider_applications.view': { module: 'providers', ar: 'عرض طلبات التسجيل', en: 'View provider applications' },
  'provider_applications.review': { module: 'providers', ar: 'مراجعة طلبات التسجيل وطلب الاستكمال', en: 'Review applications and request info' },
  'provider_applications.approve': { module: 'providers', ar: 'قبول طلبات التسجيل', en: 'Approve applications' },
  'provider_applications.reject': { module: 'providers', ar: 'رفض طلبات التسجيل', en: 'Reject applications' },
  // Geography & money reference
  'countries.manage': { module: 'reference', ar: 'إدارة الدول', en: 'Manage countries' },
  'currencies.manage': { module: 'reference', ar: 'إدارة العملات', en: 'Manage currencies' },
  'exchange_rates.manage': { module: 'reference', ar: 'إدخال أسعار الصرف', en: 'Enter exchange rates' },
  'terms.manage': { module: 'reference', ar: 'نشر الشروط والسياسات', en: 'Publish terms and policies' },
  'content.manage': { module: 'reference', ar: 'إدارة صفحات المساعدة والأسئلة الشائعة', en: 'Manage help and FAQ content' },
  // Settings & audit
  'settings.view': { module: 'settings', ar: 'عرض الإعدادات', en: 'View settings' },
  'settings.manage': { module: 'settings', ar: 'تعديل الإعدادات', en: 'Change settings' },
  'audit.view': { module: 'audit', ar: 'عرض سجل التدقيق', en: 'View audit log' },
  // Catalog (phase 3)
  'categories.manage': { module: 'catalog', ar: 'إدارة التصنيفات', en: 'Manage categories' },
  'service_types.manage': { module: 'catalog', ar: 'إدارة أنواع الخدمات', en: 'Manage service types' },
  'services.view': { module: 'catalog', ar: 'عرض الخدمات', en: 'View services' },
  'services.manage': { module: 'catalog', ar: 'إنشاء وتعديل الخدمات', en: 'Create and edit services' },
  'services.publish': { module: 'catalog', ar: 'نشر الخدمات', en: 'Publish services' },
  'services.unpublish': { module: 'catalog', ar: 'إلغاء نشر الخدمات', en: 'Unpublish services' },
  // Bookings (phase 4-5)
  'bookings.view': { module: 'bookings', ar: 'عرض الحجوزات', en: 'View bookings' },
  'bookings.accept': { module: 'bookings', ar: 'قبول ورفض الحجوزات', en: 'Accept or reject bookings' },
  'bookings.cancel': { module: 'bookings', ar: 'إلغاء الحجوزات', en: 'Cancel bookings' },
  'bookings.manage': { module: 'bookings', ar: 'إدارة الحجوزات والتقويم', en: 'Manage bookings and calendar' },
  // Finance (phase 6-7)
  'finance.view': { module: 'finance', ar: 'الاطلاع على البيانات المالية', en: 'View financial data' },
  'payments.review': { module: 'finance', ar: 'مراجعة المدفوعات وإثباتاتها', en: 'Review payments and proofs' },
  'payments.approve': { module: 'finance', ar: 'اعتماد المدفوعات', en: 'Approve payments' },
  'payment_settings.manage': { module: 'finance', ar: 'إدارة طرق ومزودي الدفع', en: 'Manage payment methods and providers' },
  'commissions.manage': { module: 'finance', ar: 'إدارة قواعد العمولة', en: 'Manage commission rules' },
  'refunds.execute': { module: 'finance', ar: 'تنفيذ الاستردادات', en: 'Execute refunds' },
  'settlements.approve': { module: 'finance', ar: 'اعتماد التسويات', en: 'Approve settlements' },
  'accounts.manage': { module: 'finance', ar: 'إدارة الصناديق والحسابات', en: 'Manage funds and accounts' },
  // Disputes (phase 8)
  'disputes.view': { module: 'disputes', ar: 'عرض النزاعات', en: 'View disputes' },
  'disputes.review': { module: 'disputes', ar: 'مراجعة النزاعات', en: 'Review disputes' },
  'disputes.decide': { module: 'disputes', ar: 'إصدار قرارات النزاعات', en: 'Decide disputes' },
  // Engagement (phase 8)
  'notifications.manage': { module: 'engagement', ar: 'إدارة قوالب الإشعارات', en: 'Manage notification templates' },
  'promotions.manage': { module: 'engagement', ar: 'إدارة العروض والكوبونات', en: 'Manage promotions and coupons' },
  'reviews.moderate': { module: 'engagement', ar: 'مراجعة التقييمات', en: 'Moderate reviews' },
  // Reports (phase 9)
  'reports.view': { module: 'reports', ar: 'عرض التقارير', en: 'View reports' },
  'reports.export': { module: 'reports', ar: 'تصدير التقارير', en: 'Export reports' },
  'documents.print': { module: 'reports', ar: 'طباعة المستندات', en: 'Print documents' },
  'finance.reconcile': { module: 'finance', ar: 'مطابقة الحسابات مع كشوف المزودين والبنوك', en: 'Reconcile with provider and bank statements' },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const SYSTEM_ROLES: { code: string; ar: string; en: string; permissions: Permission[] }[] = [
  { code: 'system_admin', ar: 'مسؤول النظام', en: 'System administrator', permissions: ALL_PERMISSIONS },
  {
    code: 'manager', ar: 'مدير', en: 'Manager',
    permissions: ALL_PERMISSIONS.filter((p) => !['roles.manage', 'settings.manage', 'payment_settings.manage'].includes(p)),
  },
  {
    code: 'support_agent', ar: 'موظف دعم', en: 'Support agent',
    permissions: ['customers.view', 'providers.view', 'bookings.view', 'disputes.view', 'disputes.review', 'services.view'],
  },
  {
    code: 'bookings_agent', ar: 'موظف حجوزات', en: 'Bookings agent',
    permissions: ['customers.view', 'providers.view', 'services.view', 'bookings.view', 'bookings.accept', 'bookings.cancel', 'bookings.manage'],
  },
  {
    code: 'finance_officer', ar: 'موظف مالي', en: 'Finance officer',
    permissions: ['finance.view', 'providers.view', 'providers.view_sensitive', 'bookings.view', 'payments.review',
      'payments.approve', 'refunds.execute', 'settlements.approve', 'accounts.manage', 'exchange_rates.manage',
      'reports.view', 'reports.export', 'documents.print', 'finance.reconcile'],
  },
  {
    code: 'payment_reviewer', ar: 'موظف مراجعة مدفوعات', en: 'Payment reviewer',
    permissions: ['finance.view', 'bookings.view', 'payments.review'],
  },
  {
    code: 'services_supervisor', ar: 'مشرف خدمات', en: 'Services supervisor',
    permissions: ['providers.view', 'providers.manage', 'provider_applications.view', 'provider_applications.review',
      'provider_applications.approve', 'provider_applications.reject', 'categories.manage', 'service_types.manage',
      'services.view', 'services.manage', 'services.publish', 'services.unpublish', 'reviews.moderate'],
  },
];
