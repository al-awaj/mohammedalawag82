import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '../lib/session';

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTitleAlign: 'center' }}>
        {/* The title is what the back button of pushed screens shows. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'مناسبات' }} />
      </Stack>
    </SessionProvider>
  );
}
