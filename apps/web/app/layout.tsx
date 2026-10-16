import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { AppProviders } from '@events/web-kit/client';
import '@events/web-kit/fonts.css';
import '@events/web-kit/styles.css';
import './site.css';
import { BRAND } from '../lib/brand';

export const metadata: Metadata = {
  title: { default: `${BRAND.ar} — حجز خدمات المناسبات`, template: `%s — ${BRAND.ar}` },
  description: 'احجز قاعات الأفراح والتصوير والضيافة وكل خدمات المناسبات بأسعار واضحة وسياسات إلغاء معلنة.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = (await cookies()).get('lang')?.value === 'en' ? 'en' : 'ar';
  return (
    <html lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <body><AppProviders lang={lang}>{children}</AppProviders></body>
    </html>
  );
}
