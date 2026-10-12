import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { AppProviders } from '@events/web-kit/client';
import '@events/web-kit/styles.css';
import './site.css';

export const metadata: Metadata = {
  title: { default: 'حجز خدمات المناسبات', template: '%s — حجز خدمات المناسبات' },
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
