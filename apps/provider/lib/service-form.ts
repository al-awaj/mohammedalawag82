import type { FieldSpec, Option } from '@events/web-kit/ui';

export interface ServiceType {
  id: string; code: string; name: Record<string, string>; bookingMode: string; capacityMode: string; defaultRequiresApproval: boolean;
  defaultDurationMinutes: number | null; pricingUnits: string[]; allowsPackages: boolean; minImages: number; maxImages: number; allowsVideo: boolean;
  depositRequired: boolean; minDepositPercent: string | null; fields: import('./fields').TypeField[];
}
export interface Service {
  id: string; serviceTypeId: string; title: Record<string, string>; description: Record<string, string>; terms: Record<string, string> | null; city: string; address: string | null;
  basePrice: string; currency: string; pricingUnit: string; durationMinutes: number | null; capacity: number | null; requiresProviderApproval: boolean;
  depositType: string; depositValue: string; balanceDueDaysBefore: number; attributes: Record<string, unknown>; maxConcurrentBookings: number; slotStepMinutes: number | null;
  status: string; statusReason: string | null; typeName: Record<string, string>; bookingMode: string; capacityMode: string;
  cancellationPolicy: { id: string } | null; packages: Package[]; rentalItems: RentalItem[];
  media: { id: string; kind: string; mimeType: string; caption: Record<string, string> | null; isPastWork: boolean; packageId: string | null; sortOrder: number; url: string }[];
  rating: { average: string | null; count: number };
}
export interface Package {
  id: string; name: Record<string, string>; description: Record<string, string> | null; price: string; currency: string; pricingUnit: string;
  durationMinutes: number | null; inclusions: Record<string, string>[]; addOns: { code: string; name: Record<string, string>; price: string }[]; status: string;
  terms: Record<string, string> | null; availableWeekdays: number[]; maxBookingsPerSlot: number; depositType: string | null; depositValue: string | null;
  balanceDueDaysBefore: number; validFrom: string | null; validTo: string | null; sortOrder: number;
}
export interface RentalItem {
  id: string; sku: string; name: Record<string, string>; attributes: Record<string, string | number>; quantityTotal: number; condition: string;
  pricePerDay: string; pricePerPeriod: string | null; periodDays: number | null; currency: string; securityDeposit: string | null;
  lateFeePerDay: string | null; damageTerms: Record<string, string> | null; status: string;
}

const UNIT_LABEL: Record<string, { ar: string; en: string }> = {
  fixed: { ar: 'سعر ثابت', en: 'Fixed price' }, per_hour: { ar: 'بالساعة', en: 'Per hour' }, per_day: { ar: 'باليوم', en: 'Per day' },
  per_person: { ar: 'للشخص', en: 'Per person' }, per_unit: { ar: 'للوحدة', en: 'Per unit' },
};

export function serviceFields(type: ServiceType, s: Partial<Service> | undefined, currencies: Option[], policies: Option[]): FieldSpec[] {
  return [
    { name: 'title', label: { ar: 'اسم الخدمة', en: 'Service name' }, type: 'i18n', required: true, defaultValue: s?.title },
    { name: 'description', label: { ar: 'الوصف', en: 'Description' }, type: 'i18n', required: true, defaultValue: s?.description },
    { name: 'terms', label: { ar: 'شروط الخدمة', en: 'Service terms' }, type: 'i18n', defaultValue: s?.terms ?? undefined },
    { name: 'city', label: { ar: 'المدينة', en: 'City' }, required: true, defaultValue: s?.city },
    { name: 'address', label: { ar: 'العنوان', en: 'Address' }, defaultValue: s?.address ?? undefined },
    { name: 'basePrice', label: { ar: 'السعر', en: 'Price' }, type: 'decimal', required: true, defaultValue: s?.basePrice },
    { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, type: 'select', required: true, options: currencies, defaultValue: s?.currency },
    { name: 'pricingUnit', label: { ar: 'طريقة التسعير', en: 'Pricing unit' }, type: 'select', required: true, defaultValue: s?.pricingUnit ?? type.pricingUnits[0],
      options: type.pricingUnits.map((u) => ({ value: u, label: UNIT_LABEL[u] ?? { ar: u, en: u } })) },
    ...(type.bookingMode === 'time_slot' ? [
      { name: 'durationMinutes', label: { ar: 'مدة الخدمة بالدقائق', en: 'Duration (minutes)' }, type: 'number', defaultValue: s?.durationMinutes ?? type.defaultDurationMinutes ?? undefined } as FieldSpec,
      { name: 'slotStepMinutes', label: { ar: 'الفاصل بين المواعيد (دقائق)', en: 'Slot step (minutes)' }, type: 'number', defaultValue: s?.slotStepMinutes ?? undefined } as FieldSpec,
    ] : []),
    ...(type.capacityMode !== 'none' ? [{ name: 'capacity', label: type.capacityMode === 'guests' ? { ar: 'السعة (عدد الضيوف)', en: 'Capacity (guests)' } : { ar: 'عدد الوحدات', en: 'Units' }, type: 'number', defaultValue: s?.capacity ?? undefined } as FieldSpec] : []),
    { name: 'maxConcurrentBookings', label: { ar: 'عدد الحجوزات المتزامنة المسموح', en: 'Concurrent bookings allowed' }, type: 'number', defaultValue: s?.maxConcurrentBookings ?? 1 },
    { name: 'requiresProviderApproval', label: { ar: 'يتطلب الحجز موافقتي قبل الدفع', en: 'Bookings need my approval before payment' }, type: 'checkbox', defaultValue: s?.requiresProviderApproval ?? type.defaultRequiresApproval },
    { name: 'depositType', label: { ar: 'العربون', en: 'Deposit' }, type: 'select', defaultValue: s?.depositType ?? (type.depositRequired ? 'percent' : 'none'), options: [
      { value: 'none', label: { ar: 'بدون عربون (الدفع كاملًا)', en: 'No deposit (pay in full)' } }, { value: 'percent', label: { ar: 'نسبة من الإجمالي', en: 'Percentage' } }, { value: 'fixed', label: { ar: 'مبلغ ثابت', en: 'Fixed amount' } }] },
    { name: 'depositValue', label: { ar: 'قيمة العربون', en: 'Deposit value' }, type: 'decimal', defaultValue: s?.depositValue,
      help: type.minDepositPercent ? { ar: `الحد الأدنى ${type.minDepositPercent}%`, en: `Minimum ${type.minDepositPercent}%` } : undefined },
    { name: 'balanceDueDaysBefore', label: { ar: 'استحقاق المتبقي قبل الموعد بـ (أيام)', en: 'Balance due (days before)' }, type: 'number', defaultValue: s?.balanceDueDaysBefore ?? 7 },
    { name: 'cancellationPolicyId', label: { ar: 'سياسة الإلغاء', en: 'Cancellation policy' }, type: 'select', options: policies, defaultValue: s?.cancellationPolicy?.id },
  ];
}
