import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { useSession } from '../src/session';
import { Loading } from '../src/components/ui';
import { c } from '../src/theme';

/**
 * Launch gate.
 *
 * Holds the splash a moment while the stored session is checked, then sends the
 * user to the right place. Rendering the login screen first and redirecting away
 * from it would flash a form at somebody who never signed out.
 */
export default function Index() {
  const { user, restoring } = useSession();

  if (restoring) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Loading label="Signing you in…" />
      </View>
    );
  }

  return <Redirect href={user ? '/(tabs)' : '/login'} />;
}
