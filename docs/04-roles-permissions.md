# المرحلة 1 — الأدوار والصلاحيات

المصدر الوحيد للحقيقة: `apps/api/src/auth/permissions.ts`. يُزامَن إلى قاعدة البيانات بالأمر `npm run seed:reference`.

## مبادئ

1. **التحقق في الخادم دائمًا** (البند 60): كل مسار إداري يمر بحارس `requirePermission` قبل التحقق من المدخلات، ثم فحص دقيق بنطاق الدولة `assertCan(user, perm, countryId)` داخل المعالج.
2. **نطاق الدولة**: يُسند الدور إما عالميًا (`country_id = NULL`) أو لدولة محددة. القوائم تُرشّح تلقائيًا بالدول المسموحة، والوصول لسجل من دولة أخرى يعيد 404 (لا يكشف وجوده).
3. **أقل صلاحية لازمة**: الأدوار النظامية مقسمة وظيفيًا؛ الأدوار المخصصة تُنشأ من اللوحة.
4. **منع التصعيد**: لا يستطيع موظف منح دور (أو إنشاء دور) يحتوي صلاحية لا يملكها هو نفسه في النطاق نفسه؛ ولا يستطيع تعديل أدواره أو حالته بنفسه.
5. **العميل وصاحب الخدمة** ليسا أدوارًا إدارية: صلاحياتهما مبنية على الملكية (بياناته، طلبه، خدماته، حجوزاته) وتُفحص في الخادم.
6. **عمليات تتطلب نطاقًا عالميًا**: إنشاء دولة، إدارة العملات وأسعار الصرف، إنشاء الموظفين، قراءة سجل التدقيق.
7. **البيانات الحساسة**: بيانات استلام المستحقات لأصحاب الخدمات لا تظهر إلا لمن يملك `providers.view_sensitive`.

## كتالوج الصلاحيات

| الصلاحية | الوحدة | الوصف |
|---|---|---|
| `users.view` | users | عرض المستخدمين — View users |
| `users.manage` | users | إدارة الموظفين والمستخدمين — Manage staff and users |
| `roles.view` | users | عرض الأدوار والصلاحيات — View roles and permissions |
| `roles.manage` | users | إدارة الأدوار والصلاحيات — Manage roles and permissions |
| `customers.view` | users | عرض بيانات العملاء — View customer data |
| `providers.view` | providers | عرض أصحاب الخدمات — View service providers |
| `providers.view_sensitive` | providers | عرض البيانات المالية لأصحاب الخدمات — View provider financial details |
| `providers.manage` | providers | إيقاف وإعادة تفعيل أصحاب الخدمات — Suspend and reactivate providers |
| `provider_applications.view` | providers | عرض طلبات التسجيل — View provider applications |
| `provider_applications.review` | providers | مراجعة طلبات التسجيل وطلب الاستكمال — Review applications and request info |
| `provider_applications.approve` | providers | قبول طلبات التسجيل — Approve applications |
| `provider_applications.reject` | providers | رفض طلبات التسجيل — Reject applications |
| `countries.manage` | reference | إدارة الدول — Manage countries |
| `currencies.manage` | reference | إدارة العملات — Manage currencies |
| `exchange_rates.manage` | reference | إدخال أسعار الصرف — Enter exchange rates |
| `terms.manage` | reference | نشر الشروط والسياسات — Publish terms and policies |
| `settings.view` | settings | عرض الإعدادات — View settings |
| `settings.manage` | settings | تعديل الإعدادات — Change settings |
| `audit.view` | audit | عرض سجل التدقيق — View audit log |
| `categories.manage` | catalog | إدارة التصنيفات — Manage categories |
| `service_types.manage` | catalog | إدارة أنواع الخدمات — Manage service types |
| `services.view` | catalog | عرض الخدمات — View services |
| `services.manage` | catalog | إنشاء وتعديل الخدمات — Create and edit services |
| `services.publish` | catalog | نشر الخدمات — Publish services |
| `services.unpublish` | catalog | إلغاء نشر الخدمات — Unpublish services |
| `bookings.view` | bookings | عرض الحجوزات — View bookings |
| `bookings.accept` | bookings | قبول ورفض الحجوزات — Accept or reject bookings |
| `bookings.cancel` | bookings | إلغاء الحجوزات — Cancel bookings |
| `bookings.manage` | bookings | إدارة الحجوزات والتقويم — Manage bookings and calendar |
| `finance.view` | finance | الاطلاع على البيانات المالية — View financial data |
| `payments.review` | finance | مراجعة المدفوعات وإثباتاتها — Review payments and proofs |
| `payments.approve` | finance | اعتماد المدفوعات — Approve payments |
| `payment_settings.manage` | finance | إدارة طرق ومزودي الدفع — Manage payment methods and providers |
| `commissions.manage` | finance | إدارة قواعد العمولة — Manage commission rules |
| `refunds.execute` | finance | تنفيذ الاستردادات — Execute refunds |
| `settlements.approve` | finance | اعتماد التسويات — Approve settlements |
| `accounts.manage` | finance | إدارة الصناديق والحسابات — Manage funds and accounts |
| `disputes.view` | disputes | عرض النزاعات — View disputes |
| `disputes.review` | disputes | مراجعة النزاعات — Review disputes |
| `disputes.decide` | disputes | إصدار قرارات النزاعات — Decide disputes |
| `notifications.manage` | engagement | إدارة قوالب الإشعارات — Manage notification templates |
| `promotions.manage` | engagement | إدارة العروض والكوبونات — Manage promotions and coupons |
| `reviews.moderate` | engagement | مراجعة التقييمات — Moderate reviews |
| `reports.view` | reports | عرض التقارير — View reports |
| `reports.export` | reports | تصدير التقارير — Export reports |
| `documents.print` | reports | طباعة المستندات — Print documents |
| `finance.reconcile` | finance | مطابقة الحسابات مع كشوف المزودين والبنوك — Reconcile with provider and bank statements |

## الأدوار النظامية

| الدور | الاسم | الصلاحيات |
|---|---|---|
| `system_admin` | مسؤول النظام | جميع الصلاحيات (صلاحياته مقفلة) |
| `manager` | مدير | الكل عدا `roles.manage`, `settings.manage`, `payment_settings.manage` |
| `support_agent` | موظف دعم | `customers.view`, `providers.view`, `bookings.view`, `disputes.view`, `disputes.review`, `services.view` |
| `bookings_agent` | موظف حجوزات | `customers.view`, `providers.view`, `services.view`, `bookings.view`, `bookings.accept`, `bookings.cancel`, `bookings.manage` |
| `finance_officer` | موظف مالي | `finance.view`, `providers.view`, `providers.view_sensitive`, `bookings.view`, `payments.review`, `payments.approve`, `refunds.execute`, `settlements.approve`, `accounts.manage`, `exchange_rates.manage`, `reports.view`, `reports.export`, `documents.print`, `finance.reconcile` |
| `payment_reviewer` | موظف مراجعة مدفوعات | `finance.view`, `bookings.view`, `payments.review` |
| `services_supervisor` | مشرف خدمات | `providers.view`, `providers.manage`, `provider_applications.view`, `provider_applications.review`, `provider_applications.approve`, `provider_applications.reject`, `categories.manage`, `service_types.manage`, `services.view`, `services.manage`, `services.publish`, `services.unpublish`, `reviews.moderate` |

## العملاء وأصحاب الخدمات (ملكية)

| الفاعل | المسموح |
|---|---|
| زائر | الاطلاع على الدول والعملات واللغات والشروط المنشورة، التسجيل، الدخول، استعادة كلمة المرور |
| عميل | ملفه الشخصي، التحقق، تغيير كلمة المرور؛ (لاحقًا) مناسباته وسلته وحجوزاته ومدفوعاته ونزاعاته |
| صاحب خدمة | طلب تسجيله ووثائقه حتى القبول، ثم ملف نشاطه؛ (لاحقًا) خدماته وتقويمه وحجوزاته ومستحقاته فقط — لا يرى بيانات أصحاب خدمات آخرين |
