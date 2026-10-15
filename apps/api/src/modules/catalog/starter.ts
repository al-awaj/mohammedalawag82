import type { Executor } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import type { DataType } from './fields.js';

/**
 * A starter set of event-service categories, types and fields (clauses 16-18), imported by an admin in one action
 * instead of typing them in. It is configuration, not sample content: no providers, services or prices are created,
 * every item stays editable, and items whose slug or code already exists are skipped.
 */
type T = { ar: string; en: string };
interface StarterField { key: string; label: T; dataType: DataType; required?: boolean; options?: [string, string, string][]; searchable?: boolean; validation?: Record<string, number> }
interface StarterType {
  code: string; name: T; bookingMode: 'time_slot' | 'full_day' | 'date_range' | 'quantity_rental'; capacityMode?: 'none' | 'guests' | 'units';
  pricingUnits: string[]; durationMinutes?: number; bufferAfter?: number; requiresApproval?: boolean; requiredDocuments?: string[];
  minImages?: number; fields: StarterField[];
}
interface StarterCategory { slug: string; name: T; icon: string; types: StarterType[] }

const opt = (v: string, ar: string, en: string): [string, string, string] => [v, ar, en];

export const STARTER_CATALOG: StarterCategory[] = [
  { slug: 'venues', name: { ar: 'القاعات والمواقع', en: 'Venues' }, icon: 'building', types: [
    { code: 'wedding_hall', name: { ar: 'قاعة أفراح', en: 'Wedding hall' }, bookingMode: 'full_day', capacityMode: 'guests', pricingUnits: ['fixed', 'per_person'],
      requiredDocuments: ['commercial_license', 'civil_defense_permit'], minImages: 3, fields: [
        { key: 'sections', label: { ar: 'الأقسام', en: 'Sections' }, dataType: 'select', required: true, searchable: true,
          options: [opt('men_women', 'رجال ونساء', 'Men and women'), opt('women', 'نساء فقط', 'Women only'), opt('men', 'رجال فقط', 'Men only'), opt('mixed', 'مختلط', 'Mixed')] },
        { key: 'parking_spaces', label: { ar: 'عدد المواقف', en: 'Parking spaces' }, dataType: 'integer', validation: { min: 0 } },
        { key: 'has_kitchen', label: { ar: 'يوجد مطبخ تجهيز', en: 'Prep kitchen available' }, dataType: 'boolean' },
        { key: 'location_pin', label: { ar: 'موقع القاعة', en: 'Hall location' }, dataType: 'location' },
      ] },
    { code: 'outdoor_venue', name: { ar: 'استراحة أو منتجع', en: 'Outdoor venue / resort' }, bookingMode: 'full_day', capacityMode: 'guests', pricingUnits: ['fixed'],
      requiredDocuments: ['commercial_license'], minImages: 3, fields: [
        { key: 'pool', label: { ar: 'مسبح', en: 'Swimming pool' }, dataType: 'boolean', searchable: true },
        { key: 'check_in', label: { ar: 'وقت الدخول', en: 'Check-in time' }, dataType: 'time' },
        { key: 'check_out', label: { ar: 'وقت الخروج', en: 'Check-out time' }, dataType: 'time' },
      ] },
    { code: 'meeting_room', name: { ar: 'قاعة اجتماعات ومؤتمرات', en: 'Meeting & conference room' }, bookingMode: 'time_slot', capacityMode: 'guests', pricingUnits: ['per_hour', 'fixed'],
      durationMinutes: 120, bufferAfter: 30, requiresApproval: false, fields: [
        { key: 'projector', label: { ar: 'جهاز عرض', en: 'Projector' }, dataType: 'boolean' },
        { key: 'seating', label: { ar: 'نوع الجلوس', en: 'Seating' }, dataType: 'select', options: [opt('theatre', 'مسرحي', 'Theatre'), opt('classroom', 'فصل', 'Classroom'), opt('boardroom', 'طاولة اجتماعات', 'Boardroom')] },
      ] },
  ] },
  { slug: 'photography', name: { ar: 'التصوير', en: 'Photography & video' }, icon: 'camera', types: [
    { code: 'photographer', name: { ar: 'مصور مناسبات', en: 'Event photographer' }, bookingMode: 'time_slot', pricingUnits: ['fixed', 'per_hour'], durationMinutes: 240, bufferAfter: 60, fields: [
      { key: 'delivery_days', label: { ar: 'مدة تسليم الصور (أيام)', en: 'Photo delivery (days)' }, dataType: 'integer', validation: { min: 1, max: 120 } },
      { key: 'edited_photos', label: { ar: 'عدد الصور المعدّلة', en: 'Edited photos' }, dataType: 'integer', validation: { min: 0 } },
      { key: 'team_gender', label: { ar: 'فريق التصوير', en: 'Crew' }, dataType: 'select', searchable: true, options: [opt('female', 'نسائي', 'Female'), opt('male', 'رجالي', 'Male'), opt('both', 'الاثنان', 'Both')] },
    ] },
    { code: 'videographer', name: { ar: 'تصوير فيديو', en: 'Videographer' }, bookingMode: 'time_slot', pricingUnits: ['fixed', 'per_hour'], durationMinutes: 240, bufferAfter: 60, fields: [
      { key: 'drone', label: { ar: 'تصوير جوي (درون)', en: 'Drone footage' }, dataType: 'boolean' },
      { key: 'film_minutes', label: { ar: 'مدة الفيلم النهائي (دقائق)', en: 'Final film length (minutes)' }, dataType: 'integer', validation: { min: 1 } },
    ] },
  ] },
  { slug: 'catering', name: { ar: 'الضيافة والطعام', en: 'Catering & hospitality' }, icon: 'utensils', types: [
    { code: 'catering', name: { ar: 'تموين وبوفيه', en: 'Catering & buffet' }, bookingMode: 'time_slot', capacityMode: 'guests', pricingUnits: ['per_person', 'fixed'], durationMinutes: 240,
      requiredDocuments: ['commercial_license', 'food_safety_certificate'], fields: [
        { key: 'cuisine', label: { ar: 'نوع المطبخ', en: 'Cuisine' }, dataType: 'multiselect', searchable: true,
          options: [opt('local', 'محلي', 'Local'), opt('arabic', 'عربي', 'Arabic'), opt('international', 'عالمي', 'International'), opt('desserts', 'حلويات', 'Desserts')] },
        { key: 'min_guests', label: { ar: 'أقل عدد ضيوف', en: 'Minimum guests' }, dataType: 'integer', validation: { min: 1 } },
      ] },
    { code: 'coffee_service', name: { ar: 'قهوجيين وصبابين', en: 'Coffee & tea service' }, bookingMode: 'time_slot', pricingUnits: ['per_hour', 'fixed'], durationMinutes: 180, fields: [
      { key: 'servers', label: { ar: 'عدد العاملين', en: 'Number of servers' }, dataType: 'integer', validation: { min: 1 } },
    ] },
  ] },
  { slug: 'decoration', name: { ar: 'التنسيق والديكور', en: 'Decoration' }, icon: 'flower', types: [
    { code: 'event_decor', name: { ar: 'تنسيق وديكور المناسبات', en: 'Event decoration' }, bookingMode: 'time_slot', pricingUnits: ['fixed'], durationMinutes: 480, bufferAfter: 120, fields: [
      { key: 'style', label: { ar: 'الطابع', en: 'Style' }, dataType: 'select', searchable: true, options: [opt('classic', 'كلاسيكي', 'Classic'), opt('modern', 'عصري', 'Modern'), opt('traditional', 'تراثي', 'Traditional')] },
      { key: 'setup_hours', label: { ar: 'ساعات التجهيز', en: 'Setup hours' }, dataType: 'integer', validation: { min: 0 } },
    ] },
    { code: 'flowers', name: { ar: 'ورود وتنسيق زهور', en: 'Flowers' }, bookingMode: 'time_slot', pricingUnits: ['fixed', 'per_unit'], durationMinutes: 120, fields: [] },
  ] },
  { slug: 'entertainment', name: { ar: 'الصوت والترفيه', en: 'Sound & entertainment' }, icon: 'music', types: [
    { code: 'dj_service', name: { ar: 'منسق موسيقى (دي جي)', en: 'DJ' }, bookingMode: 'time_slot', pricingUnits: ['per_hour', 'fixed'], durationMinutes: 240, bufferAfter: 60, fields: [
      { key: 'equipment_included', label: { ar: 'يشمل المعدات', en: 'Equipment included' }, dataType: 'boolean' },
    ] },
    { code: 'sound_lighting_rental', name: { ar: 'تأجير صوتيات وإضاءة', en: 'Sound & lighting rental' }, bookingMode: 'quantity_rental', capacityMode: 'units', pricingUnits: ['per_day'], requiresApproval: false, fields: [] },
  ] },
  { slug: 'rentals', name: { ar: 'تأجير المستلزمات', en: 'Equipment rental' }, icon: 'package', types: [
    { code: 'furniture_rental', name: { ar: 'تأجير كراسي وطاولات', en: 'Chairs & tables rental' }, bookingMode: 'quantity_rental', capacityMode: 'units', pricingUnits: ['per_day'], requiresApproval: false, fields: [
      { key: 'delivery_included', label: { ar: 'يشمل التوصيل', en: 'Delivery included' }, dataType: 'boolean' },
    ] },
    { code: 'tent_rental', name: { ar: 'تأجير خيام ومظلات', en: 'Tents & canopies' }, bookingMode: 'date_range', pricingUnits: ['per_day', 'fixed'], fields: [
      { key: 'area_sqm', label: { ar: 'المساحة (م²)', en: 'Area (m²)' }, dataType: 'number', validation: { min: 1 } },
    ] },
  ] },
  { slug: 'beauty', name: { ar: 'التجميل', en: 'Beauty' }, icon: 'sparkles', types: [
    { code: 'makeup_artist', name: { ar: 'خبيرة مكياج', en: 'Makeup artist' }, bookingMode: 'time_slot', pricingUnits: ['fixed', 'per_person'], durationMinutes: 120, bufferAfter: 30, fields: [
      { key: 'home_service', label: { ar: 'خدمة منزلية', en: 'Home service' }, dataType: 'boolean', searchable: true },
    ] },
  ] },
  { slug: 'planning', name: { ar: 'تنظيم المناسبات', en: 'Event planning' }, icon: 'clipboard', types: [
    { code: 'event_planner', name: { ar: 'منظم مناسبات', en: 'Event planner' }, bookingMode: 'date_range', pricingUnits: ['fixed'], fields: [
      { key: 'services_included', label: { ar: 'يشمل', en: 'Includes' }, dataType: 'multiselect',
        options: [opt('vendors', 'التنسيق مع الموردين', 'Vendor coordination'), opt('guests', 'إدارة الضيوف', 'Guest management'), opt('on_site', 'إشراف يوم المناسبة', 'On-site supervision')] },
    ] },
  ] },
  { slug: 'transport', name: { ar: 'النقل والسيارات', en: 'Transport' }, icon: 'car', types: [
    { code: 'wedding_car', name: { ar: 'سيارة زفاف', en: 'Wedding car' }, bookingMode: 'time_slot', pricingUnits: ['per_hour', 'fixed'], durationMinutes: 180, bufferAfter: 60,
      requiredDocuments: ['vehicle_registration'], fields: [
        { key: 'with_driver', label: { ar: 'مع سائق', en: 'With driver' }, dataType: 'boolean' },
      ] },
  ] },
];

/** Imports what is missing of the starter catalog for the chosen countries; returns what was created and skipped. */
export async function importStarterCatalog(c: Executor, countryIds: string[], actor: ActorContext, reason: string) {
  const created = { categories: [] as string[], types: [] as string[] };
  const skipped = { categories: [] as string[], types: [] as string[] };
  let order = Number((await c.query<{ n: string }>('SELECT coalesce(max(sort_order), 0) AS n FROM service_categories')).rows[0]!.n);
  for (const cat of STARTER_CATALOG) {
    let catId = (await c.query<{ id: string }>('SELECT id FROM service_categories WHERE slug = $1', [cat.slug])).rows[0]?.id;
    if (catId) skipped.categories.push(cat.slug);
    else {
      catId = (await c.query<{ id: string }>(
        'INSERT INTO service_categories (slug, name, icon, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
        [cat.slug, JSON.stringify(cat.name), cat.icon, ++order])).rows[0]!.id;
      for (const country of countryIds) await c.query('INSERT INTO service_category_countries (category_id, country_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [catId, country]);
      created.categories.push(cat.slug);
    }
    for (const t of cat.types) {
      if ((await c.query('SELECT 1 FROM service_types WHERE code = $1', [t.code])).rowCount) { skipped.types.push(t.code); continue; }
      const typeId = (await c.query<{ id: string }>(
        `INSERT INTO service_types (category_id, code, name, booking_mode, capacity_mode, default_requires_approval, default_duration_minutes,
           buffer_after_minutes, pricing_units, min_images, required_documents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [catId, t.code, JSON.stringify(t.name), t.bookingMode, t.capacityMode ?? 'none', t.requiresApproval ?? true, t.durationMinutes ?? null,
          t.bufferAfter ?? 0, t.pricingUnits, t.minImages ?? 1, t.requiredDocuments ?? []])).rows[0]!.id;
      let sort = 0;
      for (const f of t.fields) {
        await c.query(
          `INSERT INTO service_type_fields (service_type_id, key, label, data_type, is_required, validation, options, is_searchable, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [typeId, f.key, JSON.stringify(f.label), f.dataType, f.required ?? false, JSON.stringify(f.validation ?? {}),
            JSON.stringify((f.options ?? []).map(([value, ar, en]) => ({ value, label: { ar, en } }))), f.searchable ?? false, sort++]);
      }
      created.types.push(t.code);
    }
  }
  await audit(c, actor, { action: 'catalog.starter_imported', entityType: 'service_catalog', entityId: null, after: { countryIds, created, skipped }, reason });
  return { created, skipped };
}
