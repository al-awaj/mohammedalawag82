import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { localized } from '@events/shared';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { colors, Empty, ErrorText, H2, Loading, shadow } from '../../components/ui';
import { ServiceCard, type ServiceSummary } from '../../components/service-card';

type Country = { code: string; name: Record<string, string> };
type Category = { id: string; slug: string; name: Record<string, string>; children: Category[] };
type Icon = keyof typeof import('@expo/vector-icons').Ionicons.glyphMap;

/** A recognisable icon for common event categories; anything else gets a neutral one. */
function categoryIcon(slug: string, name: string): Icon {
  const k = `${slug} ${name}`.toLowerCase();
  if (/hall|venue|قاع|مواقع|استراح/.test(k)) return 'business-outline';
  if (/photo|video|camera|تصوير/.test(k)) return 'camera-outline';
  if (/cater|food|coffee|ضياف|طعام|قهو/.test(k)) return 'restaurant-outline';
  if (/decor|flower|تنسيق|ورود|ديكور/.test(k)) return 'flower-outline';
  if (/music|sound|dj|entertain|صوت|ترفيه/.test(k)) return 'musical-notes-outline';
  if (/rent|equip|tent|تأجير|خيام/.test(k)) return 'cube-outline';
  if (/beauty|makeup|تجميل/.test(k)) return 'color-palette-outline';
  if (/plan|organ|تنظيم/.test(k)) return 'clipboard-outline';
  if (/car|transport|سيار|نقل/.test(k)) return 'car-sport-outline';
  return 'sparkles-outline';
}

export default function Home() {
  const tr = useTr();
  const insets = useSafeAreaInsets();
  const { lang, country, setCountry } = useSession();
  const countries = useGet<Country[]>('/v1/countries');
  const code = country ?? countries.data?.[0]?.code ?? null;
  const categories = useGet<Category[]>(code ? '/v1/categories' : null, { country: code ?? '' });
  const latest = useGet<{ items: ServiceSummary[] }>(code ? '/v1/services' : null, { country: code ?? '', sort: 'newest', limit: 10 });
  const [q, setQ] = useState('');
  const search = () => router.push({ pathname: '/search', params: q.trim() ? { q: q.trim() } : {} });
  const cats = (categories.data ?? []).flatMap((c) => [c, ...c.children]);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
      <LinearGradient colors={['#2a1660', colors.primary, colors.primary2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={{ paddingTop: insets.top + 20, paddingHorizontal: 18, paddingBottom: 30, borderBottomLeftRadius: 28, borderBottomRightRadius: 28 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="sparkles" size={18} color="#fff" />
          </View>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontWeight: '600' }}>{tr({ ar: 'حجز خدمات المناسبات', en: 'Event services booking' })}</Text>
        </View>
        <Text style={{ color: '#fff', fontSize: 27, fontWeight: '800', lineHeight: 36, textAlign: 'left' }} accessibilityRole="header">
          {tr({ ar: 'كل ما تحتاجه لمناسبتك في مكان واحد', en: 'Everything for your occasion in one place' })}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.8)', marginTop: 6, lineHeight: 21, textAlign: 'left' }}>
          {tr({ ar: 'أسعار واضحة، توافر فوري، وسياسة إلغاء معلنة قبل الدفع.', en: 'Clear prices, live availability and a cancellation policy before you pay.' })}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 16, marginTop: 18, paddingHorizontal: 12, ...shadow }}>
          <Ionicons name="search" size={20} color={colors.muted} />
          <TextInput value={q} onChangeText={setQ} onSubmitEditing={search} returnKeyType="search" placeholder={tr({ ar: 'ما الخدمة التي تبحث عنها؟', en: 'What are you looking for?' })}
            placeholderTextColor={colors.muted} accessibilityLabel={tr({ ar: 'ابحث عن خدمة', en: 'Search for a service' })}
            style={{ flex: 1, paddingVertical: 14, paddingHorizontal: 8, fontSize: 15, color: colors.text, textAlign: lang === 'ar' ? 'right' : 'left' }} />
          <Pressable onPress={search} accessibilityRole="button" accessibilityLabel={tr({ ar: 'بحث', en: 'Search' })} testID="home-search"
            style={{ backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9 }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{tr({ ar: 'بحث', en: 'Search' })}</Text>
          </Pressable>
        </View>
        {(countries.data?.length ?? 0) > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 14 }} contentContainerStyle={{ gap: 8 }}>
            {countries.data!.map((c) => {
              const on = c.code === code;
              return (
                <Pressable key={c.code} onPress={() => setCountry(c.code)} accessibilityRole="button" accessibilityState={{ selected: on }}
                  style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: on ? '#fff' : 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}>
                  <Text style={{ color: on ? colors.primary : '#fff', fontWeight: '600' }}>{localized(c.name, lang)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </LinearGradient>

      <View style={{ padding: 16, gap: 12 }}>
        <ErrorText error={countries.error ?? categories.error ?? latest.error} />
        {cats.length > 0 && <>
          <H2>{tr({ ar: 'تصفّح حسب التصنيف', en: 'Browse by category' })}</H2>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {cats.map((c) => (
              <Pressable key={c.id} accessibilityRole="button" onPress={() => router.push({ pathname: '/search', params: { category: c.slug } })}
                style={({ pressed }) => [{ width: '31%', backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.border, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center', gap: 8, ...shadow, shadowOpacity: 0.05 }, pressed && { opacity: 0.85 }]}>
                <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name={categoryIcon(c.slug, localized(c.name, 'ar') + localized(c.name, 'en'))} size={22} color={colors.primary} />
                </View>
                <Text style={{ fontWeight: '600', color: colors.text, textAlign: 'center', fontSize: 13 }} numberOfLines={2}>{localized(c.name, lang)}</Text>
              </Pressable>
            ))}
          </View>
        </>}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <H2>{tr({ ar: 'أضيف حديثًا', en: 'Recently added' })}</H2>
          <Pressable onPress={() => router.push('/search')} accessibilityRole="link"><Text style={{ color: colors.primary, fontWeight: '700' }}>{tr({ ar: 'عرض الكل', en: 'View all' })}</Text></Pressable>
        </View>
        {latest.isLoading ? <Loading /> : latest.data?.items.length ? latest.data.items.map((s) => <ServiceCard key={s.id} s={s} />) : <Empty>{tr({ ar: 'لا توجد خدمات بعد', en: 'No services yet' })}</Empty>}
        <View style={{ backgroundColor: colors.goldSoft, borderRadius: 18, padding: 16, gap: 10, marginTop: 4 }}>
          {[
            { i: 'shield-checkmark-outline' as Icon, t: tr({ ar: 'دفع آمن وإيصال لكل دفعة', en: 'Secure payment with a receipt for each' }) },
            { i: 'pricetag-outline' as Icon, t: tr({ ar: 'السعر المعروض هو ما تدفعه، دون رسوم خفية', en: 'The price shown is what you pay — no hidden fees' }) },
            { i: 'calendar-outline' as Icon, t: tr({ ar: 'توافر لحظي، ويُحجز موعدك مؤقتًا أثناء الدفع', en: 'Live availability; your slot is held while you pay' }) },
          ].map((x) => (
            <View key={x.t} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name={x.i} size={20} color={colors.gold} />
              <Text style={{ flex: 1, color: colors.ink, textAlign: 'left' }}>{x.t}</Text>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
