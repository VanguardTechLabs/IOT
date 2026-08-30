import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { c, radius, space } from '../theme';

/** The small shared vocabulary every screen is built from. */

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function H1({ children }: { children: ReactNode }) {
  return <Text style={s.h1}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  loading,
  disabled,
  tone = 'accent',
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  tone?: 'accent' | 'ghost' | 'danger';
}) {
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        s.btn,
        tone === 'accent' && s.btnAccent,
        tone === 'ghost' && s.btnGhost,
        tone === 'danger' && s.btnDanger,
        off && s.btnOff,
        pressed && !off && s.btnPressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={tone === 'accent' ? c.bg : c.text} />
      ) : (
        <Text style={[s.btnText, tone === 'accent' && s.btnTextAccent]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, ...props }: { label: string } & TextInputProps) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        placeholderTextColor={c.textFaint}
        style={s.input}
        // Autocorrect on an email field turns a valid address into a wrong one
        // and the user cannot see why the login failed.
        autoCorrect={false}
        {...props}
      />
    </View>
  );
}

export function Note({ children, tone = 'bad' }: { children: ReactNode; tone?: 'bad' | 'warn' | 'good' }) {
  const colour = tone === 'bad' ? c.bad : tone === 'warn' ? c.warn : c.good;
  return (
    <View style={[s.note, { borderColor: colour + '55', backgroundColor: colour + '15' }]}>
      <Text style={{ color: colour, fontSize: 13 }}>{children}</Text>
    </View>
  );
}

export function Dot({ on }: { on: boolean }) {
  return <View style={[s.dot, { backgroundColor: on ? c.good : c.textFaint }]} />;
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={s.center}>
      <ActivityIndicator color={c.accent} />
      {label ? <Text style={[s.muted, { marginTop: space.sm }]}>{label}</Text> : null}
    </View>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={s.center}>
      <Text style={s.emptyTitle}>{title}</Text>
      {hint ? <Text style={[s.muted, { textAlign: 'center', marginTop: space.xs }]}>{hint}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
  },
  h1: { color: c.text, fontSize: 22, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 13 },
  label: { color: c.textDim, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    backgroundColor: c.surfaceAlt,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: c.text,
    fontSize: 16,
  },
  btn: {
    borderRadius: radius.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  btnAccent: { backgroundColor: c.accent },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.border },
  btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.bad + '66' },
  btnOff: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { color: c.text, fontSize: 15, fontWeight: '600' },
  btnTextAccent: { color: c.bg },
  note: { borderWidth: 1, borderRadius: radius.sm, padding: space.md },
  dot: { width: 8, height: 8, borderRadius: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '600' },
});

export const styles = s;
