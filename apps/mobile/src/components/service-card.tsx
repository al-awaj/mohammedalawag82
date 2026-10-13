import { Image, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatMoney, localized } from '@events/shared';
import { API_URL } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, colors } from './ui';

export interface ServiceSummary { id: string; title: Record<string, string>; city: string; fromPrice: string; currency: string; typeName: Record<string, string>; rating: string | null; reviewCount: number; coverUrl: string | null; providerName: string | null }

export function ServiceCard({ s }: { s: ServiceSummary }) {
  const { lang } = useSession();
  return (
    <Card testID={`service-${s.id}`} onPress={() => router.push(`/service/${s.id}`)}>
      {s.coverUrl && <Image source={{ uri: `${API_URL}${s.coverUrl}` }} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: '#eef0f4' }} accessibilityIgnoresInvertColors />}
      <Text style={{ color: colors.muted, fontSize: 13 }}>{localized(s.typeName, lang)} · {s.city}</Text>
      <Text style={{ fontWeight: '600', fontSize: 16, color: colors.text }}>{localized(s.title, lang)}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontWeight: '700' }}>{formatMoney(s.fromPrice, s.currency)}</Text>
        <Text style={{ color: colors.muted }}>{s.rating ? `★ ${s.rating} (${s.reviewCount})` : ''}</Text>
      </View>
    </Card>
  );
}
