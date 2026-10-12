import { Header } from '@/lib/header';
import { currentCountry, visitor } from '@/lib/server';

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const v = await visitor();
  const { list, country } = await currentCountry(v.lang, v.country);
  return (
    <>
      <Header countries={list.map((c) => ({ code: c.code, name: c.name }))} current={country?.code ?? null} />
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <p>{v.lang === 'ar' ? 'الأسعار المعروضة هي ما يدفعه العميل، دون رسوم منصة إضافية.' : 'Prices shown are what the customer pays, with no extra platform fee.'}</p>
        <a href="/terms">{v.lang === 'ar' ? 'شروط الاستخدام' : 'Terms of use'}</a> · <a href="/terms?kind=privacy_policy">{v.lang === 'ar' ? 'سياسة الخصوصية' : 'Privacy policy'}</a>
      </footer>
    </>
  );
}
