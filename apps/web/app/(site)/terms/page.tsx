import type { Metadata } from 'next';
import { localized } from '@events/shared';
import { currentCountry, publicGet, visitor } from '@/lib/server';

export const metadata: Metadata = { title: 'الشروط والسياسات' };
const KINDS = { customer_terms: { ar: 'شروط الاستخدام', en: 'Terms of use' }, privacy_policy: { ar: 'سياسة الخصوصية', en: 'Privacy policy' } } as const;

export default async function Terms({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const sp = await searchParams;
  const { lang, country: code } = await visitor();
  const { country } = await currentCountry(lang, code);
  const kind = sp.kind === 'privacy_policy' ? 'privacy_policy' : 'customer_terms';
  const t = country ? await publicGet<{ version: string; content: Record<string, string>; publishedAt: string }>(`/v1/terms/current?kind=${kind}&country=${country.code}`, lang) : null;
  return (
    <article className="card">
      <h1>{KINDS[kind][lang]}</h1>
      {t ? <>
        <p className="muted small">{lang === 'ar' ? 'الإصدار' : 'Version'} {t.version}</p>
        <div style={{ whiteSpace: 'pre-wrap' }}>{localized(t.content, lang)}</div>
      </> : <p className="muted">{lang === 'ar' ? 'لا يوجد نص منشور.' : 'Nothing published.'}</p>}
    </article>
  );
}
