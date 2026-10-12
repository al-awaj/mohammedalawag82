# المرحلة 1 — تصميم قاعدة البيانات

PostgreSQL 16. الامتدادات: `pgcrypto` (UUID)، `citext` (البريد)، `btree_gist` (منع التعارض الزمني).

## اصطلاحات عامة

- المفاتيح الأساسية `uuid` (`gen_random_uuid()`)، وأرقام مرجعية قابلة للقراءة للطلبات/الحجوزات (`ORD-2026-000123`).
- الأموال: `numeric(20,4)` + `currency_code char(3)` في **كل** صف مالي. لا `float` إطلاقًا.
- أسعار الصرف: `numeric(24,10)`.
- النصوص المترجمة: `jsonb` بالشكل `{"ar": "...", "en": "..."}` مع قيد يتحقق من وجود لغة افتراضية.
- الوقت: `timestamptz`؛ الفترات `tstzrange` بحدود `[)`.
- كل جدول تشغيلي: `created_at`, `updated_at`؛ الجداول الحساسة append-only بلا `updated_at`.
- الحالات: `text` + `CHECK (status IN (...))` (أسهل في الترحيل من enum).

الحالة: ✅ مُنفّذ في ترحيل · 🧩 مُصمم وسيُنفذ في مرحلته.

---

## A. المرجعيات والهوية (المرحلة 2) ✅

| الجدول | أعمدة أساسية | قيود/ملاحظات |
|---|---|---|
| `languages` | code PK, name jsonb, direction (rtl/ltr), is_active | ar, en مبدئيًا |
| `currencies` | code char(3) PK, name jsonb, symbol, minor_units, is_active | ISO 4217 |
| `countries` | id, code char(2) UNIQUE, name jsonb, base_currency → currencies, timezone, default_language → languages, date_format, is_active, tax_settings jsonb, invoice_settings jsonb | لا تُحذف؛ تُعطّل |
| `country_currencies` | country_id, currency_code, is_active | PK مركب؛ العملة الأساسية مسموحة دائمًا |
| `exchange_rates` | id, base_currency, quote_currency, rate, effective_at, source, entered_by, created_at | **append-only** بمشغل؛ CHECK rate>0؛ base≠quote |
| `users` | id, kind (customer/provider/staff), full_name, phone UNIQUE, email citext UNIQUE, country_id, preferred_language, status (active/locked/disabled), phone_verified_at, email_verified_at, failed_login_count, locked_until, last_login_at | الهاتف بصيغة E.164 |
| `user_credentials` | user_id PK, password_hash, password_changed_at | منفصل عن users لتقليل التعرض |
| `refresh_tokens` | id, user_id, token_hash UNIQUE, family_id, expires_at, revoked_at, replaced_by, user_agent, ip | إعادة استخدام رمز مُبطل ⇒ إبطال العائلة كاملة |
| `verification_codes` | id, user_id, purpose (verify_phone/verify_email/reset_password), channel, target, code_hash, expires_at, attempts, consumed_at | أقصى 5 محاولات |
| `terms_versions` | id, kind (customer_terms/privacy/provider_terms), country_id NULL, version, content jsonb, published_at | لا تعديل بعد النشر |
| `terms_acceptances` | id, user_id, terms_version_id, accepted_at, ip, context (registration/booking) | سجل تاريخي (البند 66) |
| `customer_profiles` | user_id PK, notes | يُوسّع لاحقًا |
| `providers` | id, user_id UNIQUE, application_id, business_name, activity_type, country_id, city, address, location (lat/lng), description, status (active/suspended), show_identity, payout_details jsonb (مشفر في الإنتاج), interim_settlement_eligible bool | لا ينشر خدمات إلا وهو active |
| `provider_applications` | id, user_id, status, business_name, activity_type, country_id, city, phone, email, address, latitude, longitude, description, payout_details, terms_version_id, submitted_at, decided_at, decided_by, decision_reason | الحالات الثمانية من البند 14 |
| `provider_application_events` | id, application_id, from_status, to_status, actor_id, reason, created_at | append-only |
| `provider_application_documents` | id, application_id, doc_type, file_key, original_name, mime_type, size_bytes, sha256, uploaded_by | التحقق من النوع بالبصمة السحرية |
| `permissions` | code PK, module, description jsonb | كتالوج ثابت من الكود |
| `roles` | id, code UNIQUE, name jsonb, is_system, description | الأدوار النظامية لا تُحذف |
| `role_permissions` | role_id, permission_code | PK مركب |
| `user_roles` | id, user_id, role_id, country_id NULL, granted_by, granted_at | NULL = نطاق عالمي؛ UNIQUE(user, role, country) بـ NULLS NOT DISTINCT |
| `staff_profiles` | user_id PK, job_title, created_by | |
| `settings` | key, scope_type (global/country), scope_id, value jsonb, updated_by, updated_at | UNIQUE(key, scope_type, scope_id) NULLS NOT DISTINCT |
| `setting_history` | id, key, scope_type, scope_id, old_value, new_value, changed_by, changed_at, reason | append-only |
| `audit_log` | id bigserial, actor_id, actor_kind, action, entity_type, entity_id, before jsonb, after jsonb, reason, ip, request_id, created_at | **append-only** بمشغل يمنع UPDATE/DELETE/TRUNCATE |
| `message_outbox` | id, channel, recipient_user_id, target, template_key, payload, language, status (pending/sent/failed), attempts, last_error, provider_ref, created_at, sent_at | يُستخدم لاحقًا كسجل الإشعارات (البند 54) |

## B. محرك الخدمات (المرحلة 3) ✅

| الجدول | أعمدة أساسية |
|---|---|
| `service_categories` | id, parent_id, name jsonb, description jsonb, icon, image_key, sort_order, is_active |
| `service_category_countries` | category_id, country_id |
| `service_types` | id, category_id, code, name jsonb, description jsonb, icon, booking_mode (time_slot/full_day/date_range/quantity_rental), default_requires_approval, default_duration_minutes, buffer_before/after_minutes, capacity_mode, required_images, required_documents jsonb, pricing_options jsonb, is_active, version |
| `service_type_fields` | id, service_type_id, key, label jsonb, data_type (text/number/bool/select/multiselect/date/media/geo), is_required, validation jsonb, options jsonb, is_searchable, is_reportable, sort_order |
| `services` | id, provider_id, service_type_id, country_id, city, title jsonb, description jsonb, location, base_price, currency_code, pricing_unit, capacity, **requires_provider_approval** (D5), cancellation_policy_id, deposit_type/value, balance_due_days_before, attributes jsonb, status (draft/pending_review/published/unpublished/suspended), published_at |
| `services.attributes` | قيم الحقول الديناميكية كـ JSONB مفهرس GIN بدل جدول EAV، وتُتحقق في الخادم بقواعد `service_type_fields` (مفاتيح غير معروفة مرفوضة) |
| `service_status_events` | سجل حالات الخدمة append-only |
| `provider_service_types` | الأنواع المسموح لكل صاحب خدمة بتقديمها |
| `cancellation_policies` | سياسة منصة (provider_id NULL) أو خاصة بصاحب الخدمة: شرائح استرداد حسب الساعات قبل الموعد، استرداد العربون، الإلغاء الذاتي، المراجعة اليدوية |
| `service_media` | id, service_id, kind (image/video), file_key, sort_order, is_past_work |
| `packages` | id, service_id, name jsonb, description jsonb, price, currency_code, duration_minutes, inclusions jsonb, add_ons jsonb, terms jsonb, available_weekdays int[], max_bookings_per_slot, deposit_type (fixed/percent/none), deposit_value, balance_due_rule jsonb, valid_from, valid_to, status |
| `rental_items` | id, service_id, sku, attributes jsonb (size, color…), quantity_total, condition, daily_price, security_deposit, late_fee_rule jsonb |

## C. التوافر (المرحلة 4) ✅

| الجدول | ملاحظات |
|---|---|
| `availability_rules` | ساعات العمل الأسبوعية لكل خدمة/مورد، بتوقيت الدولة |
| `calendar_blocks` | id, service_id, rental_item_id, kind (hold/booking/external/closed), period، blocked_period (مع أوقات التجهيز)، units، exclusive، status (active/released)، expires_at (للحجز المؤقت)، booking_ref، reason، internal_notes، من أنشأ/حرر ولماذا |
|  | **منع التعارض**: قفل صف الخدمة (`FOR UPDATE`) وحساب أقصى استخدام متزامن على `blocked_period` ≤ السعة، ثم `EXCLUDE USING gist (service_id WITH =, blocked_period WITH &&) WHERE (status = 'active' AND exclusive)` كحماية على مستوى القاعدة للخدمات الحصرية. |
| `services.max_concurrent_bookings`, `services.slot_step_minutes` | السعة المتزامنة وشبكة المواعيد |

## D. الطلبات والحجوزات (المرحلة 5) 🧩

| الجدول | ملاحظات |
|---|---|
| `events` | id, customer_id, name, event_type, country_id, city, location, starts_at, ends_at, expected_guests, budget_amount, budget_currency, notes, status |
| `carts`, `cart_items` | عنصر لكل (خدمة، باقة، فترة، كمية، إضافات)؛ إعادة تحقق السعر/التوافر قبل الإتمام |
| `orders` | id, number, customer_id, event_id, country_id, currency_code, totals (snapshot), status, idempotency_key UNIQUE |
| `bookings` | id, number, order_id, service_id, package_id, provider_id, period, quantity, **price_snapshot**, add_ons_snapshot, deposit_type/value/amount snapshot, cancellation_policy_snapshot, terms_version_id, requires_approval_snapshot, status, hold_expires_at, approval_deadline, payment_model, discount_amount, discount_bearer |
| `booking_status_events` | append-only |

حالات الحجز: `held` ← `pending_provider_approval` ← `awaiting_payment` ← `confirmed` ← `in_progress` ← `completed`، وفروع: `rejected`, `expired`, `cancelled_by_customer`, `cancelled_by_provider`, `cancelled_by_admin`, `no_show`.

## E. المالية (المراحل 6–7) 🧩 — انظر `05-financial-design.md`

`payment_providers`, `payment_integrations`, `payment_method_rules`, `payments`, `payment_proofs`, `provider_webhook_events (UNIQUE(provider, external_event_id))`, `ledger_accounts`, `journal_entries`, `journal_lines`, `commission_rules`, `booking_commissions`, `provider_earnings`, `settlements`, `settlement_items`, `refunds`, `reconciliation_runs`, `reconciliation_items`.

## F. النزاعات والإشعارات والعروض والتقييمات (المرحلة 8) 🧩

`disputes`, `dispute_events`, `dispute_evidence` (حماية من الحذف)، `notification_templates (key, channel, language, body)`, `reminder_rules`, `promotions (cost_bearer إلزامي)`, `promotion_redemptions`, `reviews (booking_id UNIQUE — تقييم واحد لكل حجز مكتمل)`.

## G. المستندات (المرحلة 9) 🧩

`documents (kind: invoice/receipt/deposit_receipt/refund_note/settlement_note/dispute_record, number UNIQUE per country+kind+year, entity refs, language, file_key, totals snapshot)`.
