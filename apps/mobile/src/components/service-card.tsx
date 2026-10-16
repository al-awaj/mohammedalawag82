import { Image, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { formatMoney, localized } from '@events/shared';
import { API_URL } from '../lib/api';
import { useSession } from '../lib/session';
import { colors, shadow } from './ui';

export interface ServiceSummary { id: string; title: Record<string, string>; city: string; fromPrice: string; currency: string; typeName: Record<string, string>; rating: string | null; reviewCount: number; coverUrl: string | null; providerName: string | null; requiresProviderApproval?: boolean }

export function ServiceCard({ s }: { s: ServiceSummary }) {
  const { lang } = useSession();
  const ar = lang === 'ar';
  return (
    <Pressable testID={`service-${s.id}`} accessibilityRole="button" onPress={() => router.push(`/service/${s.id}`)}
      style={({ pressed }) => [{ backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', ...shadow }, pressed && { opacity: 0.9, transform: [{ scale: 0.99 }] }]}>
      <View>
        {s.coverUrl
          ? <Image source={{ uri: `${API_URL}${s.coverUrl}` }} style={{ width: '100%', aspectRatio: 16 / 10, backgroundColor: colors.primarySoft }} accessibilityIgnoresInvertColors />
          : <View style={{ width: '100%', aspectRatio: 16 / 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="sparkles-outline" size={40} color={colors.primary} /></View>}
        <View style={{ position: 'absolute', top: 10, start: 10, backgroundColor: 'rgba(20,17,39,0.72)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{localized(s.typeName, lang)}</Text>
        </View>
        {s.rating ? (
          <View style={{ position: 'absolute', top: 10, end: 10, backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Ionicons name="star" size={12} color={colors.gold} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>{s.rating}</Text>
            <Text style={{ fontSize: 11, color: colors.muted }}>({s.reviewCount})</Text>
          </View>
        ) : null}
      </View>
      <View style={{ padding: 14, gap: 6 }}>
        <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }} numberOfLines={2}>{localized(s.title, lang)}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="location-outline" size={14} color={colors.muted} />
          <Text style={{ color: colors.muted, fontSize: 13 }} numberOfLines={1}>{s.city}{s.providerName ? ` · ${s.providerName}` : ''}</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 2 }}>
          <View>
            <Text style={{ color: colors.muted, fontSize: 12 }}>{ar ? 'يبدأ من' : 'From'}</Text>
            <Text style={{ fontWeight: '800', fontSize: 17, color: colors.primary, writingDirection: 'ltr' }}>{formatMoney(s.fromPrice, s.currency)}</Text>
          </View>
          {s.requiresProviderApproval !== undefined && (
            <View style={{ backgroundColor: s.requiresProviderApproval ? colors.warnSoft : colors.okSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: s.requiresProviderApproval ? colors.warn : colors.ok }}>
                {s.requiresProviderApproval ? (ar ? 'بتأكيد صاحب الخدمة' : 'Provider confirms') : (ar ? 'حجز فوري' : 'Instant')}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}
