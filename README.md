# منصة حجز خدمات المناسبات — Events Booking Platform

منصة متعددة الدول لحجز وشراء وإدارة خدمات الأعراس والحفلات وجميع المناسبات: تطبيق عملاء (Android/iOS)، موقع عملاء، لوحة إدارة مركزية، ولوحة ويب لأصحاب الخدمات — فوق واجهة خلفية واحدة.

> **الحالة الحالية: المراحل 1 إلى 10 من 12.** راجع [`docs/00-roadmap.md`](docs/00-roadmap.md) لما نُفّذ وما لم يُنفّذ بعد. لا تُعد المنصة جاهزة للإنتاج.

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
npm run worker                               # المهام المجدولة: إنهاء الحجوزات غير المدفوعة، تحرير المواعيد، تنبيهات الانتهاء
```

خطوات التهيئة الأولى من لوحة الإدارة (أو API):
1. إنشاء دولة وتفعيلها: `POST /v1/admin/countries`.
2. نشر الشروط وسياسة الخصوصية للدولة: `POST /v1/admin/terms` (`customer_terms`, `provider_terms`, `privacy_policy`). **التسجيل يُرفض حتى تُنشر.**
3. إنشاء الموظفين وإسناد أدوارهم: `POST /v1/admin/staff`.
4. إنشاء التصنيفات وإتاحتها للدولة، ثم أنواع الخدمات وحقولها: `POST /v1/admin/categories`, `POST /v1/admin/service-types`.
5. بعد قبول صاحب خدمة، منحه الأنواع المسموح بها: `PUT /v1/admin/providers/:id/service-types`.
6. المالية لكل دولة: إنشاء الصناديق (`POST /v1/admin/accounts`)، تكامل الدفع مع وضع سره في متغير بيئة (`POST /v1/admin/payment-integrations` ثم الاختبار والتفعيل)، طرق الدفع (`POST /v1/admin/payment-methods`)، وقواعد العمولة المعتمدة (`POST /v1/admin/commission-rules`).

## تشغيل الواجهات

| الواجهة | المسار | المنفذ | التشغيل |
|---|---|---|---|
| لوحة الإدارة | `apps/admin` | 3001 | `npm run dev:admin` |
| لوحة أصحاب الخدمات | `apps/provider` | 3002 | `npm run dev:provider` |
| موقع العملاء | `apps/web` | 3003 | `npm run dev:web` |
| تطبيق العملاء (iOS/Android) | `apps/mobile` | Expo | `cd apps/mobile && EXPO_PUBLIC_API_URL=http://<عنوان-الخادم>:3000 npx expo start` |

- واجهات الويب تحتاج `API_URL` (عنوان الـ API من جهة الخادم، انظر `.env.example` لكل تطبيق). المتصفح لا يتصل بالـ API مباشرة ولا يرى الرموز: كل الطلبات تمر عبر `/bff` في نفس النطاق.
- عند وضع الواجهات خلف موزع حمل، اضبط `TRUST_PROXY` في الـ API ليقبل عنوان IP الحقيقي للعميل.
- التطبيق يتصل بالـ API مباشرة؛ أضف أصل نسخة الويب من التطبيق إلى `CORS_ORIGINS` فقط إن استخدمتها.

## الاختبارات

```bash
cd apps/api && npm test        # يستخدم قاعدة events_test (تُمسح وتُرحّل في كل تشغيل)
npm run typecheck
```

`TEST_DATABASE_URL` يغيّر قاعدة الاختبار (يجب أن يحتوي اسمها على `test` كحماية).

اختبارات المتصفح (تُشغّل الـ API وكل الواجهات على قاعدة `events_e2e` مستقلة تُعاد تهيئتها في كل تشغيل):

```bash
cd e2e
npm run build:apps     # بناء واجهات Next.js ونسخة الويب من التطبيق
npm test               # Playwright
```

اختبار الحمل على حجم إنتاجي (قاعدة `events_perf_test` مستقلة؛ ~20 ألف خدمة و~100 ألف حجز):

```bash
cd apps/api && npm run test:perf     # النتائج في perf/results.json
```

النتائج الكاملة ومصفوفة تتبع الاختبارات الإلزامية في [`docs/11-test-report.md`](docs/11-test-report.md).

## النشر في الإنتاج

```bash
cd deploy && cp .env.example .env    # النطاقات، الأسرار، التخزين، الهوية
docker compose build && docker compose up -d
docker compose run --rm create-admin --name "…" --email … --password '…'
./smoke-test.sh                      # تجربة الحزمة كاملة محليًا قبل النشر
```

التفاصيل في [`docs/12-deployment.md`](docs/12-deployment.md)، والتشغيل والطوارئ في [`docs/13-operations.md`](docs/13-operations.md)، والأدلة والتسليم في `docs/14..16`.

## النسخ الاحتياطي والاستعادة

```bash
cd apps/api
npm run backup -- ./backups 14                       # قاعدة البيانات + الملفات + manifest ببصمات SHA-256
npm run restore -- ./backups/<النسخة> postgres://…/قاعدة_جديدة_فارغة ./storage-restored
```

الاستعادة تتحقق من البصمات أولًا، ولا تعمل إلا على قاعدة ومجلد فارغين، ثم تثبت تطابق الصفوف ومجاميع الدفتر وتوازنه وفحوص الاتساق قبل أن تُعلن النجاح. توجّه التطبيق إلى النسخة المستعادة فقط بعد ذلك.

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
| الكتالوج العام | `GET /categories`, `GET /services` (بحث), `GET /services/:id`, `GET /media/:id` |
| لوحة صاحب الخدمة | `/provider/service-types`, `/provider/services[/:id]`, `POST /provider/services/:id/{submit,unpublish,packages,rental-items,media}`, `PATCH /provider/{packages,rental-items,media}/:id`, `/provider/cancellation-policies` |
| الإدارة: الكتالوج | `/admin/categories`, `/admin/service-types[/:id/fields]`, `/admin/providers/:id/service-types`, `/admin/services[/:id/actions]`, `/admin/cancellation-policies` |
| التوافر والتقويم | `GET /services/:id/availability`, `GET/PUT /provider/services/:id/availability-rules`, `POST /provider/services/:id/blocks`, `DELETE /provider/blocks/:id`, `GET /provider/calendar`, `GET /admin/calendar`, `POST /admin/services/:id/blocks`, `DELETE /admin/blocks/:id` |
| المناسبات والسلة والحجوزات | `/events[/:id]`, `POST /quote`, `GET /cart`, `POST /cart/items`, `DELETE /cart/items/:id`, `POST /checkout` (رأس `Idempotency-Key` إلزامي), `GET /orders/:id`, `GET /bookings[/:id]`, `POST /bookings/:id/cancel` |
| حجوزات صاحب الخدمة | `GET /provider/bookings[/:id]`, `POST /provider/bookings/:id/{accept,reject,start,complete,no-show}` |
| الإدارة: الحجوزات | `GET /admin/bookings[/:id]`, `GET /admin/orders/:id`, `POST /admin/bookings/:id/cancel` |
| المدفوعات (العميل) | `GET /orders/:id/payment-options`, `POST /orders/:id/payments` (رأس `Idempotency-Key`), `GET /orders/:id/payments`, `GET /payments/:id`, `POST /payments/:id/{proofs,cancel}` |
| إشعارات مزودي الدفع | `POST /webhooks/payments/:integrationId` (توقيع إلزامي) |
| المستحقات (صاحب الخدمة) | `GET /provider/earnings` |
| الإدارة: المالية | `/admin/payment-integrations[/:id/test]`, `/admin/payment-methods`, `/admin/accounts[/:id/statement]`, `/admin/ledger/trial-balance`, `/admin/payments[/:id/review]`, `/admin/payment-events`, `/admin/commission-rules`, `/admin/earnings[/:id/approve-review]` |
| الإلغاء والاسترداد | `GET /bookings/:id/cancellation-preview`, `POST /bookings/:id/cancel`, `GET /bookings/:id/refunds`, `POST /provider/bookings/:id/{cancel,no-show}`, `GET/POST /admin/cancellation-requests[/:id/decide]`, `/admin/refunds[/:id/{approve,reject,execute,fail}]`, `POST /admin/bookings/:id/refunds`, `GET /admin/bookings/:id/refundable` |
| التسويات | `GET /admin/settlements/preview`, `/admin/settlements[/:id/{approve,mark-paid,mark-failed,cancel}]`, `PATCH /admin/providers/:id/interim-settlement`, `GET /provider/settlements` |
| النزاعات والشكاوى | `POST/GET /disputes`, `GET /disputes/:id`, `POST /disputes/:id/{statements,evidence}`, `/admin/disputes[/:id/{actions,hold,decide,settle}]`, `POST /admin/disputes/:id/evidence/:eid/share` |
| الإشعارات | `GET /me/notifications`, `POST /me/notifications/{:id/read,read-all}`, `/admin/notification-templates`, `/admin/messaging-channels`, `/admin/notifications[/:id/retry]`, `/admin/reminder-rules` |
| العروض والتقييمات | `POST /cart/coupon`, `couponCode` في `POST /checkout`, `/admin/promotions`, `/provider/promotions`, `POST /bookings/:id/review`, `GET /services/:id/reviews`, `/provider/reviews[/:id/report]`, `/admin/reviews[/:id/moderate]` |
| التقارير | `GET /admin/reports`, `GET /admin/reports/:report` (`overview`, `revenue`, `commissions`, `payments-by-method`, `payments-by-currency`, `refunds`, `provider-earnings`, `settlements`, `fund-balances`, `fx-differences`, `bookings-payments`, `discounts`, `disputes`, `trial-balance`, `consolidated`؛ مع `country`, `currency`, `from`, `to`, `providerId`, `serviceTypeId`, `displayCurrency`+`rateDate`, `format=csv`), `GET /provider/reports/summary` |
| المستندات والكشوف | `GET /documents[/:id]` (`format=html&lang=ar|en` للطباعة), `GET /bookings/:id/{statement,balance-notice}`, `GET /me/payment-history`, `GET /disputes/:id/record`, `GET /admin/documents` |
| المطابقة | `POST/GET /admin/reconciliation/runs[/:id]`, `POST /admin/reconciliation/items/:id/resolve`, `GET /admin/reconciliation/checks` |
| الإدارة: الإعدادات والتدقيق | `GET /admin/settings`, `PUT /admin/settings/:key`, `GET /admin/settings/:key/history`, `GET /admin/audit-log` |

صيغة الأخطاء موحدة ومترجمة حسب `Accept-Language`:
```json
{ "error": { "code": "AUTH_INVALID_CREDENTIALS", "message": "بيانات الدخول غير صحيحة", "details": null } }
```

## ملاحظات تشغيلية

- الرسائل (رموز التحقق وإشعارات قرارات التسجيل) تُكتب في جدول `message_outbox` بحالة `pending` ضمن نفس المعاملة؛ تُرسل عبر عامل الإرسال (`npm run worker`) إلى قناة مهيأة لكل دولة؛ بدون قناة مهيأة تُسجل فاشلة ولا يُدّعى إرسالها. في التطوير يمكن قراءة الرمز من الجدول مباشرة.
- إنشاء الامتدادات (`pgcrypto`, `citext`, `btree_gist`) في الترحيل الأول يتطلب صلاحية كافية لمستخدم القاعدة أو إنشاؤها مسبقًا من مسؤول القاعدة.
- الترحيلات المطبقة غير قابلة للتعديل (يُتحقق من checksum)؛ أي تغيير يكون بملف ترحيل جديد.
