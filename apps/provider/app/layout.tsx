import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { AppProviders } from '@events/web-kit/client';
import '@events/web-kit/styles.css';

export const metadata: Metadata = { title: `لوحة أصحاب الخدمات — Provider panel${process.env.NEXT_PUBLIC_BRAND_AR ? ` — ${process.env.NEXT_PUBLIC_BRAND_AR}` : ''}`, robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = (await cookies()).get('lang')?.value === 'en' ? 'en' : 'ar';
  return (
    <html lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <body><AppProviders lang={lang}>{children}</AppProviders></body>
    </html>
  );
}
