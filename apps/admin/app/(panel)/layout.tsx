'use client';
import { Shell } from '@events/web-kit/ui';
import { useTr } from '@events/web-kit/client';
import { NAV } from '@/lib/nav';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const tr = useTr();
  return <Shell brand={tr({ ar: 'إدارة المنصة', en: 'Platform admin' })} nav={NAV} kinds={['staff']}>{children}</Shell>;
}
