import type { NavGroup } from '@events/web-kit/ui';

/** Navigation; items are shown only to staff holding the permission (the API enforces it regardless). */
export const NAV: NavGroup[] = [
  { label: { ar: 'عام', en: 'General' }, items: [
    { href: '/', label: { ar: 'لوحة المتابعة', en: 'Dashboard' }, perm: 'reports.view' },
  ] },
  { label: { ar: 'أصحاب الخدمات والخدمات', en: 'Providers & services' }, items: [
    { href: '/applications', label: { ar: 'طلبات التسجيل', en: 'Applications' }, perm: 'provider_applications.view' },
    { href: '/providers', label: { ar: 'أصحاب الخدمات', en: 'Providers' }, perm: 'providers.view' },
    { href: '/provider-changes', label: { ar: 'طلبات تعديل البيانات', en: 'Profile change requests' }, perm: 'providers.view' },
    { href: '/services', label: { ar: 'الخدمات', en: 'Services' }, perm: 'services.view' },
    { href: '/catalog', label: { ar: 'التصنيفات والأنواع', en: 'Categories & types' }, perm: ['categories.manage', 'service_types.manage'] },
    { href: '/policies', label: { ar: 'سياسات الإلغاء', en: 'Cancellation policies' }, perm: 'services.manage' },
  ] },
  { label: { ar: 'الحجوزات', en: 'Bookings' }, items: [
    { href: '/bookings', label: { ar: 'الحجوزات', en: 'Bookings' }, perm: 'bookings.view' },
    { href: '/events', label: { ar: 'المناسبات', en: 'Events' }, perm: 'bookings.view' },
    { href: '/calendar', label: { ar: 'التقويم', en: 'Calendar' }, perm: 'bookings.view' },
    { href: '/cancellation-requests', label: { ar: 'طلبات الإلغاء', en: 'Cancellation requests' }, perm: 'bookings.cancel' },
    { href: '/disputes', label: { ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' }, perm: 'disputes.view' },
    { href: '/reviews', label: { ar: 'التقييمات', en: 'Reviews' }, perm: 'reviews.moderate' },
  ] },
  { label: { ar: 'المالية', en: 'Finance' }, items: [
    { href: '/payments', label: { ar: 'المدفوعات', en: 'Payments' }, perm: 'finance.view' },
    { href: '/refunds', label: { ar: 'الاستردادات', en: 'Refunds' }, perm: 'refunds.execute' },
    { href: '/earnings', label: { ar: 'مستحقات أصحاب الخدمات', en: 'Provider earnings' }, perm: 'settlements.approve' },
    { href: '/settlements', label: { ar: 'التسويات', en: 'Settlements' }, perm: 'settlements.approve' },
    { href: '/accounts', label: { ar: 'الصناديق والحسابات', en: 'Funds & accounts' }, perm: 'finance.view' },
    { href: '/commissions', label: { ar: 'العمولات', en: 'Commissions' }, perm: 'commissions.manage' },
    { href: '/payment-settings', label: { ar: 'طرق ومزودو الدفع', en: 'Payment setup' }, perm: 'payment_settings.manage' },
    { href: '/promotions', label: { ar: 'العروض والكوبونات', en: 'Promotions' }, perm: 'promotions.manage' },
    { href: '/reconciliation', label: { ar: 'المطابقة', en: 'Reconciliation' }, perm: 'finance.reconcile' },
  ] },
  { label: { ar: 'التقارير', en: 'Reports' }, items: [
    { href: '/reports', label: { ar: 'التقارير', en: 'Reports' }, perm: 'reports.view' },
    { href: '/documents', label: { ar: 'المستندات', en: 'Documents' }, perm: 'documents.print' },
  ] },
  { label: { ar: 'النظام', en: 'System' }, items: [
    { href: '/notifications', label: { ar: 'الإشعارات', en: 'Notifications' }, perm: 'notifications.manage' },
    { href: '/users', label: { ar: 'المستخدمون', en: 'Users' }, perm: 'users.view' },
    { href: '/staff', label: { ar: 'الموظفون والأدوار', en: 'Staff & roles' }, perm: ['users.view', 'roles.view'] },
    { href: '/reference', label: { ar: 'الدول والعملات والشروط', en: 'Countries, currencies, terms' }, perm: ['countries.manage', 'currencies.manage', 'exchange_rates.manage', 'terms.manage'] },
    { href: '/help', label: { ar: 'المساعدة والأسئلة الشائعة', en: 'Help & FAQ' }, perm: 'content.manage' },
    { href: '/settings', label: { ar: 'الإعدادات', en: 'Settings' }, perm: 'settings.view' },
    { href: '/audit', label: { ar: 'سجل التدقيق', en: 'Audit log' }, perm: 'audit.view' },
  ] },
];
