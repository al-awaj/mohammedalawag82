import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { Button, Empty, ErrorText, Field, Loading, P, Screen } from '../../components/ui';
import { ServiceCard, type ServiceSummary } from '../../components/service-card';

export default function Search() {
  const tr = useTr();
  const params = useLocalSearchParams<{ q?: string; category?: string }>();
  const { country } = useSession();
  const countries = useGet<{ code: string }[]>('/v1/countries');
  const code = country ?? countries.data?.[0]?.code ?? null;
  const [q, setQ] = useState(params.q ?? '');
  const [city, setCity] = useState('');
  const [applied, setApplied] = useState({ q: params.q ?? '', city: '', category: params.category ?? '' });
  const query = { country: code ?? '', limit: 30, ...(applied.q.trim().length >= 2 ? { q: applied.q.trim() } : {}), ...(applied.city ? { city: applied.city } : {}), ...(applied.category ? { category: applied.category } : {}) };
  const res = useGet<{ total: number; items: ServiceSummary[] }>(code ? '/v1/services' : null, query);
  return (
    <Screen>
      <Field label={tr({ ar: 'بحث', en: 'Search' })} value={q} onChangeText={setQ} />
      <Field label={tr({ ar: 'المدينة', en: 'City' })} value={city} onChangeText={setCity} />
      <Button title={tr({ ar: 'تطبيق', en: 'Apply' })} onPress={() => setApplied({ q, city, category: applied.category })} />
      <ErrorText error={res.error} />
      {res.isLoading ? <Loading /> : <>
        <P muted>{tr({ ar: `${res.data?.total ?? 0} نتيجة`, en: `${res.data?.total ?? 0} results` })}</P>
        {res.data?.items.length ? res.data.items.map((s) => <ServiceCard key={s.id} s={s} />) : <Empty>{tr({ ar: 'لا توجد نتائج', en: 'No results' })}</Empty>}
      </>}
    </Screen>
  );
}
