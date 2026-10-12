'use client';
import { Shell } from '@events/web-kit/ui';
import { useTr } from '@events/web-kit/client';
import { NAV, ProviderGate, useProvider } from '@/lib/provider';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const tr = useTr();
  const { provider } = useProvider();
  return (
    <Shell brand={provider?.businessName ?? tr({ ar: 'لوحة أصحاب الخدمات', en: 'Provider panel' })} nav={NAV} kinds={['provider']}>
      <ProviderGate>{children}</ProviderGate>
    </Shell>
  );
}
