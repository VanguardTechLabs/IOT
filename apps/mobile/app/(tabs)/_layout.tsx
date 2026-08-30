import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { View } from 'react-native';
import { Loading } from '../../src/components/ui';
import { useSession } from '../../src/session';
import { c } from '../../src/theme';

export default function TabsLayout() {
  const { user, restoring } = useSession();

  if (restoring) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Loading />
      </View>
    );
  }
  // Signing out unmounts everything below this, so the guard lives here rather
  // than on each screen.
  if (!user) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.text,
        headerTitleStyle: { fontWeight: '600' },
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textFaint,
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Devices',
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="chip" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="dashboards"
        options={{
          title: 'Dashboards',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="view-dashboard-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="account-circle-outline" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
