import { Tabs } from 'expo-router';
import { useTr } from '../../lib/i18n';
import { colors } from '../../components/ui';

export default function TabsLayout() {
  const tr = useTr();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary, headerTitleAlign: 'center' }}>
      <Tabs.Screen name="index" options={{ title: tr({ ar: 'الرئيسية', en: 'Home' }), tabBarLabel: tr({ ar: 'الرئيسية', en: 'Home' }) }} />
      <Tabs.Screen name="search" options={{ title: tr({ ar: 'البحث', en: 'Search' }) }} />
      <Tabs.Screen name="bookings" options={{ title: tr({ ar: 'حجوزاتي', en: 'My bookings' }) }} />
      <Tabs.Screen name="account" options={{ title: tr({ ar: 'حسابي', en: 'Account' }) }} />
    </Tabs>
  );
}
