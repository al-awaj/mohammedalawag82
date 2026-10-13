import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { localized } from '@events/shared';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { Button, Card, colors, Empty, ErrorText, Field, H1, H2, Loading, P, Screen } from '../../components/ui';
import { ServiceCard, type ServiceSummary } from '../../components/service-card';

type Country = { code: string; name: Record<string, string> };
type Category = { id: string; slug: string; name: Record<string, string>; children: Category[] };

export default function Home() {
  const tr = useTr();
  const { lang, country, setCountry } = useSession();
  const countries = useGet<Country[]>('/v1/countries');
  const code = country ?? countries.data?.[0]?.code ?? null;
  const categories = useGet<Category[]>(code ? '/v1/categories' : null, { country: code ?? '' });
  const latest = useGet<{ items: ServiceSummary[] }>(code ? '/v1/services' : null, { country: code ?? '', sort: 'newest', limit: 10 });
  const [q, setQ] = useState('');
  return (
    <Screen>
      <H1>{tr({ ar: 'كل خدمات مناسبتك في مكان واحد', en: 'Everything for your occasion' })}</H1>
      <P muted>{tr({ ar: 'أسعار واضحة وتوافر فوري وسياسة إلغاء معلنة قبل الدفع.', en: 'Clear prices, live availability and a cancellation policy before you pay.' })}</P>
      {(countries.data?.length ?? 0) > 1 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {countries.data!.map((c) => (
            <Pressable key={c.code} onPress={() => setCountry(c.code)} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: c.code === code ? colors.primary : colors.border, backgroundColor: c.code === code ? colors.primarySoft : colors.surface }}>
              <Text>{localized(c.name, lang)}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Field label={tr({ ar: 'ابحث عن خدمة', en: 'Search for a service' })} value={q} onChangeText={setQ} returnKeyType="search" onSubmitEditing={() => router.push({ pathname: '/search', params: { q } })} />
      <Button title={tr({ ar: 'بحث', en: 'Search' })} onPress={() => router.push({ pathname: '/search', params: { q } })} />
      <ErrorText error={countries.error ?? categories.error ?? latest.error} />
      <H2>{tr({ ar: 'التصنيفات', en: 'Categories' })}</H2>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(categories.data ?? []).flatMap((c) => [c, ...c.children]).map((c) => (
          <Card key={c.id} onPress={() => router.push({ pathname: '/search', params: { category: c.slug } })}><Text>{localized(c.name, lang)}</Text></Card>
        ))}
      </View>
      <H2>{tr({ ar: 'أضيف حديثًا', en: 'Recently added' })}</H2>
      {latest.isLoading ? <Loading /> : latest.data?.items.length ? latest.data.items.map((s) => <ServiceCard key={s.id} s={s} />) : <Empty>{tr({ ar: 'لا توجد خدمات بعد', en: 'No services yet' })}</Empty>}
    </Screen>
  );
}
