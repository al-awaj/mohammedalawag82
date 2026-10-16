import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTr } from '../../lib/i18n';
import { colors } from '../../components/ui';

type Icon = keyof typeof Ionicons.glyphMap;
const icon = (name: Icon, active: Icon) => ({ color, focused, size }: { color: unknown; focused: boolean; size: number }) => <Ionicons name={focused ? active : name} color={color as string} size={size} />;

export default function TabsLayout() {
  const tr = useTr();
  return (
    <Tabs screenOptions={{
      tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted, headerTitleAlign: 'center',
      headerStyle: { backgroundColor: colors.surface }, headerTitleStyle: { fontWeight: '700', color: colors.text }, headerShadowVisible: false,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, minHeight: 64, paddingTop: 6 },
      tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
    }}>
      <Tabs.Screen name="index" options={{ title: tr({ ar: 'الرئيسية', en: 'Home' }), headerShown: false, tabBarIcon: icon('home-outline', 'home') }} />
      <Tabs.Screen name="search" options={{ title: tr({ ar: 'البحث', en: 'Search' }), tabBarIcon: icon('search-outline', 'search') }} />
      <Tabs.Screen name="bookings" options={{ title: tr({ ar: 'حجوزاتي', en: 'My bookings' }), tabBarIcon: icon('calendar-outline', 'calendar') }} />
      <Tabs.Screen name="account" options={{ title: tr({ ar: 'حسابي', en: 'Account' }), tabBarIcon: icon('person-circle-outline', 'person-circle') }} />
    </Tabs>
  );
}
