import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../src/session';
import { c } from '../src/theme';

export default function RootLayout() {
  // Created once per app launch. A module-level client would survive Fast
  // Refresh with stale data attached to it.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Telemetry arrives over the socket, so polling is a fallback for the
            // seconds around a reconnect rather than the primary path.
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <SessionProvider>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: c.bg },
              headerTintColor: c.text,
              headerTitleStyle: { fontWeight: '600' },
              contentStyle: { backgroundColor: c.bg },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="device/[id]" options={{ title: 'Device' }} />
            <Stack.Screen name="dashboard/[id]" options={{ title: 'Dashboard' }} />
          </Stack>
        </SafeAreaProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
