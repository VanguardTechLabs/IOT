import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Redirect } from 'expo-router';
import { ApiError, API_URL } from '../src/api';
import { Button, Field, Note } from '../src/components/ui';
import { useSession } from '../src/session';
import { c, space } from '../src/theme';

export default function Login() {
  const { user, signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Redirect href="/(tabs)" />;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  const ready = email.trim().length > 0 && password.length > 0;

  return (
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.brand}>
          <Text style={s.logo}>Pulse</Text>
          <Text style={s.sub}>IoT platform</Text>
        </View>

        <View style={{ gap: space.lg }}>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="you@example.com"
            returnKeyType="next"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            placeholder="••••••••"
            returnKeyType="go"
            onSubmitEditing={() => {
              if (ready && !busy) void submit();
            }}
          />

          {error ? <Note>{error}</Note> : null}

          <Button label="Sign in" onPress={() => void submit()} loading={busy} disabled={!ready} />

          <Text style={s.hint}>
            Accounts are created on the web panel. This app signs in to the same account.
          </Text>
          <Text style={s.server}>{API_URL.replace(/^https?:\/\//, '')}</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: c.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.xl },
  brand: { alignItems: 'center', gap: space.xs },
  logo: { color: c.accent, fontSize: 40, fontWeight: '800', letterSpacing: -1 },
  sub: { color: c.textDim, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' },
  hint: { color: c.textFaint, fontSize: 12, textAlign: 'center', lineHeight: 18 },
  server: { color: c.textFaint, fontSize: 11, textAlign: 'center', opacity: 0.7 },
});

