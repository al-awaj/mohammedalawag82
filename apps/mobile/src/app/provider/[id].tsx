import { Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { formatDate } from '@events/shared';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { ServiceCard, type ServiceSummary } from '../../components/service-card';
import { Card, Empty, ErrorText, Loading, P, Screen } from '../../components/ui';

type PublicProvider = {
  id: string; businessName: string; activityType: string; city: string; description: string | null; countryCode: string;
  memberSince: string; rating: { average: string | null; count: number }; serviceCount: number;
};

/** Public provider page; exists only while the provider's identity may be shown (the API answers 404 otherwise). */
export default function ProviderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useTr();
  const { lang } = useSession();
  const p = useGet<PublicProvider>(`/v1/providers/${id}`);
  const services = useGet<{ items: ServiceSummary[] }>(p.data ? '/v1/services' : null, { country: p.data?.countryCode ?? '', provider: id, limit: 50 });
  if (p.isLoading) return <Loading />;
  if (!p.data) return <Screen><ErrorText error={p.error} /></Screen>;
  const d = p.data;
  return (
    <Screen>
      <Stack.Screen options={{ title: d.businessName }} />
      <Card testID="provider-page">
        <Text style={{ fontWeight: '700', fontSize: 18 }}>{d.businessName}</Text>
        <P muted>{d.activityType} · {d.city}{d.rating.average ? ` · ★ ${d.rating.average} (${d.rating.count})` : ''}</P>
        <P small muted>{tr({ ar: 'على المنصة منذ ', en: 'On the platform since ' })}{formatDate(d.memberSince, lang)}</P>
        {d.description ? <P>{d.description}</P> : null}
      </Card>
      <P muted>{tr({ ar: `الخدمات (${d.serviceCount})`, en: `Services (${d.serviceCount})` })}</P>
      {services.isLoading ? <Loading /> : !services.data?.items.length ? <Empty>{tr({ ar: 'لا توجد خدمات منشورة حاليًا', en: 'No published services right now' })}</Empty>
        : services.data.items.map((s) => <ServiceCard key={s.id} s={s} />)}
    </Screen>
  );
}
