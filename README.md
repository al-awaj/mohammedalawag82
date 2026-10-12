# منصة حجز خدمات المناسبات — Events Booking Platform

منصة متعددة الدول لحجز وشراء وإدارة خدمات الأعراس والحفلات وجميع المناسبات: تطبيق عملاء (Android/iOS)، موقع عملاء، لوحة إدارة مركزية، ولوحة ويب لأصحاب الخدمات — فوق واجهة خلفية واحدة.

> **الحالة الحالية: المرحلتان 1 و2 من 12.** راجع [`docs/00-roadmap.md`](docs/00-roadmap.md) لما نُفّذ وما لم يُنفّذ بعد. لا تُعد المنصة جاهزة للإنتاج.

## الوثائق

| الملف | المحتوى |
|---|---|
| [`docs/00-roadmap.md`](docs/00-roadmap.md) | المراحل وحالتها وما هو خارج النطاق حاليًا |
| [`docs/01-requirements-analysis.md`](docs/01-requirements-analysis.md) | القرارات المعتمدة، الوحدات، مصفوفة التتبع، الافتراضات المفتوحة |
| [`docs/02-architecture.md`](docs/02-architecture.md) | المعمارية والتقنيات ومبادئها الملزمة |
| [`docs/03-database-design.md`](docs/03-database-design.md) | تصميم قاعدة البيانات لكل الكيانات |
| [`docs/04-roles-permissions.md`](docs/04-roles-permissions.md) | كتالوج الصلاحيات والأدوار النظامية |
| [`docs/05-financial-design.md`](docs/05-financial-design.md) | القيد المزدوج، شجرة الحسابات المقترحة، العمولات، المستحقات |

## التشغيل المحلي (الواجهة الخلفية)

المتطلبات: Node.js 22+، PostgreSQL 16 (أو `docker compose up -d`).

```bash
npm install
cp apps/api/.env.example apps/api/.env      # عدّل JWT_SECRET و DATABASE_URL
cd apps/api
npm run migrate                              # ترحيل قاعدة البيانات
npm run seed:reference                       # اللغات، العملات المرجعية، الصلاحيات، الأدوار النظامية
npm run create-admin -- --name "Admin" --email admin@example.com --password 'StrongPass123'
npm run dev                                  # http://localhost:3000 — توثيق API على /docs
```

خطوات التهيئة الأولى من لوحة الإدارة (أو API):
1. إنشاء دولة وتفعيلها: `POST /v1/admin/countries`.
2. نشر الشروط وسياسة الخصوصية للدولة: `POST /v1/admin/terms` (`customer_terms`, `provider_terms`, `privacy_policy`). **التسجيل يُرفض حتى تُنشر.**
3. إنشاء الموظفين وإسناد أدوارهم: `POST /v1/admin/staff`.

## الاختبارات

```bash
cd apps/api && npm test        # يستخدم قاعدة events_test (تُمسح وتُرحّل في كل تشغيل)
npm run typecheck
```

`TEST_DATABASE_URL` يغيّر قاعدة الاختبار (يجب أن يحتوي اسمها على `test` كحماية).

## نظرة على API (v1)

| المجال | المسارات |
|---|---|
| المصادقة | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/verification/{request,confirm}`, `/auth/password/{forgot,reset}` |
| الحساب | `GET/PATCH /me`, `POST /me/password` |
| مرجعي عام | `GET /languages`, `/currencies`, `/countries`, `/exchange-rates/latest`, `/terms/current` |
| تسجيل أصحاب الخدمات | `POST /provider-applications`, `GET /provider-applications/mine`, `PATCH /provider-applications/:id`, `POST /provider-applications/:id/{documents,submit,cancel}`, `GET /provider/me` |
| الإدارة: أصحاب الخدمات | `GET /admin/provider-applications[/:id]`, `POST /admin/provider-applications/:id/actions` (`start_review`, `request_info`, `approve`, `reject`, `suspend`, `reactivate`), `GET /admin/providers` |
| الإدارة: مرجعي | `/admin/currencies`, `/admin/countries`, `/admin/exchange-rates`, `/admin/terms` |
| الإدارة: الوصول | `/admin/permissions`, `/admin/roles`, `/admin/users`, `/admin/users/:id/status`, `/admin/staff`, `/admin/staff/:id/roles` |
| الإدارة: الإعدادات والتدقيق | `GET /admin/settings`, `PUT /admin/settings/:key`, `GET /admin/settings/:key/history`, `GET /admin/audit-log` |

صيغة الأخطاء موحدة ومترجمة حسب `Accept-Language`:
```json
{ "error": { "code": "AUTH_INVALID_CREDENTIALS", "message": "بيانات الدخول غير صحيحة", "details": null } }
```

## ملاحظات تشغيلية

- الرسائل (رموز التحقق وإشعارات قرارات التسجيل) تُكتب في جدول `message_outbox` بحالة `pending` ضمن نفس المعاملة؛ **لا تُرسل فعليًا** حتى ربط مزودي SMS/البريد/WhatsApp وعامل الإرسال في المرحلة 8. في التطوير يمكن قراءة الرمز من الجدول مباشرة.
- إنشاء الامتدادات (`pgcrypto`, `citext`, `btree_gist`) في الترحيل الأول يتطلب صلاحية كافية لمستخدم القاعدة أو إنشاؤها مسبقًا من مسؤول القاعدة.
- الترحيلات المطبقة غير قابلة للتعديل (يُتحقق من checksum)؛ أي تغيير يكون بملف ترحيل جديد.
