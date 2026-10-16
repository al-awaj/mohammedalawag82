'use client';
import { useState } from 'react';
import { useAction, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Card, ErrorBox, Form, Loading, Notice, Page, type Values } from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';

type Setting = { key: string; default: unknown; values: { scope: string; countryId: string | null; value: unknown }[] };
type Contact = { phone?: string; whatsapp?: string; email?: string; address?: { ar?: string; en?: string }; hours?: { ar?: string; en?: string } };
const SOCIAL = ['instagram', 'x', 'tiktok', 'snapchat', 'facebook', 'youtube', 'linkedin'] as const;

/**
 * Platform name, colour, logo, contact details and social links shown on the website and app. Each save is a setting
 * change (with reason, history and audit) for all countries or for one country.
 */
export default function Branding() {
  const tr = useTr();
  const countries = useCountries();
  const [countryId, setCountryId] = useState('');
  const { data, error, isLoading } = useGet<Setting[]>('/v1/admin/settings');
  const save = useAction(async (api, v: Values) => {
    const scope = countryId ? { scope: 'country', countryId } : { scope: 'global' };
    const put = (key: string, value: unknown) => api.put(`/v1/admin/settings/${key}`, { ...scope, value, reason: v.reason });
    const pick = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && x !== '' && !(typeof x === 'object' && x && !Object.keys(x).length)));
    await put('branding.name', { ar: v.nameAr, en: v.nameEn });
    await put('branding.primary_color', v.color);
    await put('contact.info', pick({
      phone: v.phone, whatsapp: v.whatsapp, email: v.email,
      address: pick({ ar: v.addressAr, en: v.addressEn }), hours: pick({ ar: v.hoursAr, en: v.hoursEn }),
    }));
    await put('contact.social', pick(Object.fromEntries(SOCIAL.map((k) => [k, v[`social_${k}`]]))));
  });
  if (isLoading) return <Loading />;
  const value = <T,>(key: string): T | undefined => {
    const d = data?.find((x) => x.key === key);
    const s = d?.values ?? [];
    return (s.find((x) => x.countryId === (countryId || null))?.value ?? s.find((x) => x.scope === 'global')?.value ?? d?.default) as T | undefined;
  };
  const name = value<{ ar: string; en: string }>('branding.name');
  const c = value<Contact>('contact.info') ?? {};
  const social = value<Record<string, string>>('contact.social') ?? {};
  return (
    <Page title={tr({ ar: 'الهوية والتواصل', en: 'Branding & contact' })} actions={
      <ActionButton label={tr({ ar: 'رفع الشعار', en: 'Upload logo' })}
        note={tr({ ar: 'PNG أو JPG أو WEBP، ويفضّل خلفية شفافة وارتفاع 80 بكسل على الأقل.', en: 'PNG, JPG or WEBP, ideally transparent and at least 80px high.' })}
        fields={[{ name: 'file', label: { ar: 'الشعار', en: 'Logo' }, type: 'file', required: true }, { name: 'reason', label: { ar: 'السبب', en: 'Reason' }, type: 'textarea', required: true }]}
        run={(api, v) => {
          const f = new FormData();
          if (countryId) f.append('countryId', countryId);
          f.append('reason', String(v.reason));
          f.append('file', v.file as File);
          return api.upload('/v1/admin/branding/logo', f);
        }} />
    }>
      <ErrorBox error={error ?? save.error} />
      {save.isSuccess && <Notice kind="success">{tr({ ar: 'تم الحفظ؛ يظهر في الموقع خلال دقيقة.', en: 'Saved; the website shows it within a minute.' })}</Notice>}
      <div className="filters">
        <label className="filter"><span>{tr({ ar: 'النطاق', en: 'Scope' })}</span>
          <select id="f-scope" value={countryId} onChange={(e) => setCountryId(e.target.value)}>
            <option value="">{tr({ ar: 'كل الدول', en: 'All countries' })}</option>
            {countries.list.map((x) => <option key={x.id} value={x.id}>{countries.code(x.id)}</option>)}
          </select></label>
      </div>
      <Card>
        <Form key={`${countryId}-${JSON.stringify([name, c, social])}`} busy={save.isPending} onSubmit={(v) => save.mutate(v)} fields={[
          { name: 'nameAr', label: { ar: 'اسم المنصة بالعربية', en: 'Name (Arabic)' }, required: true, defaultValue: name?.ar },
          { name: 'nameEn', label: { ar: 'اسم المنصة بالإنجليزية', en: 'Name (English)' }, required: true, defaultValue: name?.en },
          { name: 'color', label: { ar: 'اللون الأساسي', en: 'Main colour' }, required: true, defaultValue: value<string>('branding.primary_color') ?? '#6d28d9', placeholder: '#6d28d9' },
          { name: 'phone', label: { ar: 'الهاتف', en: 'Phone' }, type: 'tel', defaultValue: c.phone },
          { name: 'whatsapp', label: { ar: 'واتساب', en: 'WhatsApp' }, type: 'tel', defaultValue: c.whatsapp },
          { name: 'email', label: { ar: 'البريد الإلكتروني', en: 'Email' }, type: 'email', defaultValue: c.email },
          { name: 'addressAr', label: { ar: 'العنوان بالعربية', en: 'Address (Arabic)' }, defaultValue: c.address?.ar },
          { name: 'addressEn', label: { ar: 'العنوان بالإنجليزية', en: 'Address (English)' }, defaultValue: c.address?.en },
          { name: 'hoursAr', label: { ar: 'أوقات العمل بالعربية', en: 'Working hours (Arabic)' }, defaultValue: c.hours?.ar },
          { name: 'hoursEn', label: { ar: 'أوقات العمل بالإنجليزية', en: 'Working hours (English)' }, defaultValue: c.hours?.en },
          ...SOCIAL.map((k) => ({ name: `social_${k}`, label: `${k} (https://…)`, defaultValue: social[k] })),
          { name: 'reason', label: { ar: 'سبب التعديل', en: 'Reason' }, type: 'textarea', required: true },
        ]} />
      </Card>
    </Page>
  );
}
