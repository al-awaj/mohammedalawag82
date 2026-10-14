import { Ban, Banknote, Bell, CalendarCheck, CalendarDays, ChartColumn, CircleHelp, ClipboardCheck, CreditCard, FileText, FolderTree, Globe, HandCoins, History, IdCard, Landmark, LayoutDashboard, MessageSquareWarning, Package, PartyPopper, Percent, Scale, Settings, Settings2, ShieldCheck, Star, Store, TicketPercent, Undo2, UserPen, Users } from 'lucide-react';
import type { NavGroup } from '@events/web-kit/ui';

/** Navigation; items are shown only to staff holding the permission (the API enforces it regardless). */
export const NAV: NavGroup[] = [
  { label: { ar: 'عام', en: 'General' }, items: [
    { href: '/', label: { ar: 'لوحة المتابعة', en: 'Dashboard' }, perm: 'reports.view', icon: LayoutDashboard },
  ] },
  { label: { ar: 'أصحاب الخدمات والخدمات', en: 'Providers & services' }, items: [
    { href: '/applications', label: { ar: 'طلبات التسجيل', en: 'Applications' }, perm: 'provider_applications.view', icon: ClipboardCheck },
    { href: '/providers', label: { ar: 'أصحاب الخدمات', en: 'Providers' }, perm: 'providers.view', icon: Store },
    { href: '/provider-changes', label: { ar: 'طلبات تعديل البيانات', en: 'Profile change requests' }, perm: 'providers.view', icon: UserPen },
    { href: '/services', label: { ar: 'الخدمات', en: 'Services' }, perm: 'services.view', icon: Package },
    { href: '/catalog', label: { ar: 'التصنيفات والأنواع', en: 'Categories & types' }, perm: ['categories.manage', 'service_types.manage'], icon: FolderTree },
    { href: '/policies', label: { ar: 'سياسات الإلغاء', en: 'Cancellation policies' }, perm: 'services.manage', icon: ShieldCheck },
  ] },
  { label: { ar: 'الحجوزات', en: 'Bookings' }, items: [
    { href: '/bookings', label: { ar: 'الحجوزات', en: 'Bookings' }, perm: 'bookings.view', icon: CalendarCheck },
    { href: '/events', label: { ar: 'المناسبات', en: 'Events' }, perm: 'bookings.view', icon: PartyPopper },
    { href: '/calendar', label: { ar: 'التقويم', en: 'Calendar' }, perm: 'bookings.view', icon: CalendarDays },
    { href: '/cancellation-requests', label: { ar: 'طلبات الإلغاء', en: 'Cancellation requests' }, perm: 'bookings.cancel', icon: Ban },
    { href: '/disputes', label: { ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' }, perm: 'disputes.view', icon: MessageSquareWarning },
    { href: '/reviews', label: { ar: 'التقييمات', en: 'Reviews' }, perm: 'reviews.moderate', icon: Star },
  ] },
  { label: { ar: 'المالية', en: 'Finance' }, items: [
    { href: '/payments', label: { ar: 'المدفوعات', en: 'Payments' }, perm: 'finance.view', icon: CreditCard },
    { href: '/refunds', label: { ar: 'الاستردادات', en: 'Refunds' }, perm: 'refunds.execute', icon: Undo2 },
    { href: '/earnings', label: { ar: 'مستحقات أصحاب الخدمات', en: 'Provider earnings' }, perm: 'settlements.approve', icon: HandCoins },
    { href: '/settlements', label: { ar: 'التسويات', en: 'Settlements' }, perm: 'settlements.approve', icon: Banknote },
    { href: '/accounts', label: { ar: 'الصناديق والحسابات', en: 'Funds & accounts' }, perm: 'finance.view', icon: Landmark },
    { href: '/commissions', label: { ar: 'العمولات', en: 'Commissions' }, perm: 'commissions.manage', icon: Percent },
    { href: '/payment-settings', label: { ar: 'طرق ومزودو الدفع', en: 'Payment setup' }, perm: 'payment_settings.manage', icon: Settings2 },
    { href: '/promotions', label: { ar: 'العروض والكوبونات', en: 'Promotions' }, perm: 'promotions.manage', icon: TicketPercent },
    { href: '/reconciliation', label: { ar: 'المطابقة', en: 'Reconciliation' }, perm: 'finance.reconcile', icon: Scale },
  ] },
  { label: { ar: 'التقارير', en: 'Reports' }, items: [
    { href: '/reports', label: { ar: 'التقارير', en: 'Reports' }, perm: 'reports.view', icon: ChartColumn },
    { href: '/documents', label: { ar: 'المستندات', en: 'Documents' }, perm: 'documents.print', icon: FileText },
  ] },
  { label: { ar: 'النظام', en: 'System' }, items: [
    { href: '/notifications', label: { ar: 'الإشعارات', en: 'Notifications' }, perm: 'notifications.manage', icon: Bell },
    { href: '/users', label: { ar: 'المستخدمون', en: 'Users' }, perm: 'users.view', icon: Users },
    { href: '/staff', label: { ar: 'الموظفون والأدوار', en: 'Staff & roles' }, perm: ['users.view', 'roles.view'], icon: IdCard },
    { href: '/reference', label: { ar: 'الدول والعملات والشروط', en: 'Countries, currencies, terms' }, perm: ['countries.manage', 'currencies.manage', 'exchange_rates.manage', 'terms.manage'], icon: Globe },
    { href: '/help', label: { ar: 'المساعدة والأسئلة الشائعة', en: 'Help & FAQ' }, perm: 'content.manage', icon: CircleHelp },
    { href: '/settings', label: { ar: 'الإعدادات', en: 'Settings' }, perm: 'settings.view', icon: Settings },
    { href: '/audit', label: { ar: 'سجل التدقيق', en: 'Audit log' }, perm: 'audit.view', icon: History },
  ] },
];
