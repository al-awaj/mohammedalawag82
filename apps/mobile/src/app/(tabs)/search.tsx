import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { Button, Choice, Empty, ErrorText, Field, Loading, Notice, P, Row, Screen } from '../../components/ui';
import { ServiceCard, type ServiceSummary } from '../../components/service-card';

type Sort = 'newest' | 'price_asc' | 'price_desc' | 'rating';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

/** Search with the same filters as the website: text, city, date, price range, rating and order (clause 57). */
export default function Search() {
  const tr = useTr();
  const params = useLocalSearchParams<{ q?: string; category?: string }>();
  const { country } = useSession();
  const countries = useGet<{ code: string; baseCurrency: string }[]>('/v1/countries');
  const code = country ?? countries.data?.[0]?.code ?? null;
  const currency = countries.data?.find((c) => c.code === code)?.baseCurrency ?? null;
  const empty = { q: params.q ?? '', city: '', date: '', minPrice: '', maxPrice: '', minRating: null as string | null, sort: 'newest' as Sort, category: params.category ?? '' };
  const [form, setForm] = useState(empty);
  const [applied, setApplied] = useState(empty);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const priced = !!(applied.minPrice || applied.maxPrice || applied.sort.startsWith('price'));
  const query = {
    country: code ?? '', limit: 30, sort: applied.sort,
    ...(applied.q.trim().length >= 2 ? { q: applied.q.trim() } : {}),
    ...(applied.city ? { city: applied.city } : {}),
    ...(applied.category ? { category: applied.category } : {}),
    ...(applied.date ? { date: applied.date } : {}),
    ...(applied.minPrice ? { minPrice: applied.minPrice } : {}),
    ...(applied.maxPrice ? { maxPrice: applied.maxPrice } : {}),
    ...(applied.minRating ? { minRating: applied.minRating } : {}),
    ...(priced && currency ? { currency } : {}),
  };
  const res = useGet<{ total: number; items: ServiceSummary[] }>(code ? '/v1/services' : null, query);
  const apply = () => {
    if (form.date && !DAY.test(form.date)) return setProblem(tr({ ar: 'اكتب التاريخ بصيغة 2028-03-01.', en: 'Write the date as 2028-03-01.' }));
    if ((form.minPrice && !AMOUNT.test(form.minPrice)) || (form.maxPrice && !AMOUNT.test(form.maxPrice))) return setProblem(tr({ ar: 'السعر رقم.', en: 'Prices must be numbers.' }));
    setProblem(null);
    setApplied(form);
  };
  return (
    <Screen>
      <Field testID="search-q" label={tr({ ar: 'بحث', en: 'Search' })} value={form.q} onChangeText={set('q')} />
      <Field label={tr({ ar: 'المدينة', en: 'City' })} value={form.city} onChangeText={set('city')} />
      <Button variant="secondary" testID="more-filters" title={more ? tr({ ar: 'إخفاء الفلاتر', en: 'Hide filters' }) : tr({ ar: 'فلاتر أكثر', en: 'More filters' })} onPress={() => setMore(!more)} />
      {more && <>
        <Field testID="search-date" label={tr({ ar: 'متاح في تاريخ (2028-03-01)', en: 'Available on (2028-03-01)' })} value={form.date} onChangeText={set('date')} />
        <Field label={`${tr({ ar: 'أقل سعر', en: 'Min price' })}${currency ? ` (${currency})` : ''}`} value={form.minPrice} onChangeText={set('minPrice')} keyboardType="decimal-pad" />
          <Field label={`${tr({ ar: 'أعلى سعر', en: 'Max price' })}${currency ? ` (${currency})` : ''}`} value={form.maxPrice} onChangeText={set('maxPrice')} keyboardType="decimal-pad" />
        <Choice label={tr({ ar: 'أقل تقييم', en: 'Minimum rating' })} value={form.minRating} onChange={(v) => setForm((f) => ({ ...f, minRating: v }))}
          options={['3', '4', '4.5'].map((r) => ({ value: r, label: `★ ${r}+` }))} />
        <Choice<Sort> testID="sort" label={tr({ ar: 'الترتيب', en: 'Sort by' })} value={form.sort} onChange={(v) => setForm((f) => ({ ...f, sort: v ?? 'newest' }))} options={[
          { value: 'newest', label: tr({ ar: 'الأحدث', en: 'Newest' }) }, { value: 'price_asc', label: tr({ ar: 'الأقل سعرًا', en: 'Lowest price' }) },
          { value: 'price_desc', label: tr({ ar: 'الأعلى سعرًا', en: 'Highest price' }) }, { value: 'rating', label: tr({ ar: 'الأعلى تقييمًا', en: 'Top rated' }) },
        ]} />
      </>}
      {problem ? <Notice kind="warn">{problem}</Notice> : null}
      <Row>
        <Button testID="apply-search" title={tr({ ar: 'تطبيق', en: 'Apply' })} onPress={apply} />
        <Button variant="secondary" title={tr({ ar: 'مسح', en: 'Clear' })} onPress={() => { setForm({ ...empty, q: '', category: '' }); setApplied({ ...empty, q: '', category: '' }); }} />
      </Row>
      <ErrorText error={res.error} />
      {res.isLoading ? <Loading /> : <>
        <P muted>{tr({ ar: `${res.data?.total ?? 0} نتيجة`, en: `${res.data?.total ?? 0} results` })}</P>
        {res.data?.items.length ? res.data.items.map((s) => <ServiceCard key={s.id} s={s} />) : <Empty>{tr({ ar: 'لا توجد نتائج', en: 'No results' })}</Empty>}
      </>}
    </Screen>
  );
}
