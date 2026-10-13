import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { ApiError, enumLabel, formatMoney } from '@events/shared';
import { useSession } from '../lib/session';

export const colors = {
  bg: '#f6f7f9', surface: '#ffffff', text: '#18202b', muted: '#5d6878', border: '#dfe3ea', primary: '#6a3df0', primarySoft: '#efe9ff',
  ok: '#137a4a', okSoft: '#e3f5ec', bad: '#b42318', badSoft: '#fdecea', warn: '#9a6200', warnSoft: '#fff4dc',
};

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return scroll
    ? <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    : <View style={[s.screen, s.content]}>{children}</View>;
}

export function H1({ children }: { children: ReactNode }) { return <Text style={s.h1} accessibilityRole="header">{children}</Text>; }
export function H2({ children }: { children: ReactNode }) { return <Text style={s.h2}>{children}</Text>; }
export function P({ children, muted, small }: { children: ReactNode; muted?: boolean; small?: boolean }) {
  return <Text style={[s.p, muted && s.muted, small && s.small]}>{children}</Text>;
}

export function Card({ children, onPress, testID }: { children: ReactNode; onPress?: () => void; testID?: string }) {
  return onPress
    ? <Pressable testID={testID} onPress={onPress} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}>{children}</Pressable>
    : <View testID={testID} style={s.card}>{children}</View>;
}

export function Button({ title, onPress, variant = 'primary', disabled, testID }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.btn, variant === 'secondary' && s.btnSecondary, variant === 'danger' && s.btnDanger, (disabled || pressed) && { opacity: disabled ? 0.5 : 0.85 }]}>
      <Text style={[s.btnText, variant === 'secondary' && { color: colors.text }]}>{title}</Text>
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} style={s.input} accessibilityLabel={label} {...props} />
    </View>
  );
}

export function Row({ children }: { children: ReactNode }) { return <View style={s.row}>{children}</View>; }

export function Loading() { return <View style={{ padding: 24 }}><ActivityIndicator color={colors.primary} /></View>; }

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  const details = error instanceof ApiError && Array.isArray(error.details) ? (error.details as { path?: string; message?: string }[]).map((d) => `${d.path ?? ''} ${d.message ?? ''}`).join('\n') : '';
  return <View style={s.alertBad} accessibilityRole="alert"><Text style={{ color: colors.bad }}>{msg}{details ? `\n${details}` : ''}</Text></View>;
}

export function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'warn' | 'ok' }) {
  const bg = kind === 'warn' ? colors.warnSoft : kind === 'ok' ? colors.okSoft : colors.primarySoft;
  return <View style={[s.notice, { backgroundColor: bg }]}><Text style={{ color: colors.text }}>{children}</Text></View>;
}

export function Empty({ children }: { children: ReactNode }) { return <View style={s.empty}><Text style={s.muted}>{children}</Text></View>; }

export function Money({ amount, currency }: { amount: string | null | undefined; currency: string | null | undefined }) {
  return <Text style={s.money}>{formatMoney(amount, currency)}</Text>;
}

const TONE: Record<string, string> = { confirmed: 'ok', completed: 'ok', succeeded: 'ok', paid: 'ok', failed: 'bad', rejected: 'bad', expired: 'bad', cancelled_by_customer: 'bad', cancelled_by_provider: 'bad', cancelled_by_admin: 'bad', cancelled: 'bad' };
export function Badge({ group, value }: { group: string; value: string | null | undefined }) {
  const { lang } = useSession();
  const tone = TONE[value ?? ''];
  return (
    <View style={[s.badge, tone === 'ok' && { backgroundColor: colors.okSoft }, tone === 'bad' && { backgroundColor: colors.badSoft }]}>
      <Text style={[s.small, tone === 'ok' && { color: colors.ok }, tone === 'bad' && { color: colors.bad }]}>{enumLabel(group, value, lang)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  h1: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'left' },
  h2: { fontSize: 17, fontWeight: '600', color: colors.text, textAlign: 'left' },
  p: { color: colors.text, fontSize: 15, lineHeight: 22, textAlign: 'left' },
  muted: { color: colors.muted },
  small: { fontSize: 13 },
  card: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 6 },
  btn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  btnSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  btnDanger: { backgroundColor: colors.bad },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  label: { color: colors.muted, marginBottom: 4, fontSize: 13, textAlign: 'left' },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  alertBad: { backgroundColor: colors.badSoft, borderRadius: 10, padding: 10 },
  notice: { borderRadius: 10, padding: 10 },
  empty: { padding: 24, alignItems: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: 12 },
  money: { fontWeight: '700', color: colors.text, writingDirection: 'ltr' },
  badge: { alignSelf: 'flex-start', backgroundColor: '#eef0f4', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
});
