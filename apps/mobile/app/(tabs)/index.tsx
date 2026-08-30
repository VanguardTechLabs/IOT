import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, type Device } from '../../src/api';
import { Dot, Empty, Loading, Note } from '../../src/components/ui';
import { getSocket, type StatusEvent } from '../../src/socket';
import { c, radius, space } from '../../src/theme';

/** How long ago, in the shortest form that is still accurate. */
function ago(iso: string | null): string {
  if (!iso) return 'never seen';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function Devices() {
  const qc = useQueryClient();
  // Navigating imperatively rather than with <Link asChild>. Link clones its
  // child and its own props win, which silently dropped the Pressable's style —
  // the row lost its card entirely and the chevron wrapped to a new line.
  const router = useRouter();
  const query = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<{ devices: Device[] }>('/devices'),
  });

  // Presence arrives on the same socket the panel uses, so the dot flips within
  // a second of a device dropping instead of on the next pull-to-refresh.
  useEffect(() => {
    const socket = getSocket();
    const onStatus = (event: StatusEvent) => {
      qc.setQueryData<{ devices: Device[] }>(['devices'], (prev) =>
        prev
          ? {
              devices: prev.devices.map((d) =>
                d.id === event.deviceId
                  ? { ...d, online: event.online, lastSeenAt: event.lastSeenAt ?? d.lastSeenAt }
                  : d,
              ),
            }
          : prev,
      );
    };
    socket.on('status', onStatus);
    return () => {
      socket.off('status', onStatus);
    };
  }, [qc]);

  if (query.isLoading) return <Loading />;
  if (query.isError) {
    return (
      <View style={{ padding: space.lg }}>
        <Note>Could not load your devices. Pull down to try again.</Note>
      </View>
    );
  }

  const devices = query.data?.devices ?? [];

  return (
    <FlatList
      data={devices}
      keyExtractor={(d) => d.id}
      contentContainerStyle={devices.length === 0 ? s.grow : s.list}
      refreshControl={
        <RefreshControl refreshing={query.isFetching} onRefresh={() => void query.refetch()} tintColor={c.accent} />
      }
      ListEmptyComponent={
        <Empty
          title="No devices yet"
          hint="Add a device on the web panel and it will appear here as soon as it reports."
        />
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push({ pathname: '/device/[id]', params: { id: item.id } })}
          style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
        >
          <View style={s.rowMain}>
            <View style={s.rowTitle}>
              <Dot on={item.online} />
              <Text style={s.name} numberOfLines={1}>
                {item.name}
              </Text>
            </View>
            <Text style={s.meta}>
              {item.online ? 'Online' : 'Offline'} · {ago(item.lastSeenAt)}
              {item.variableCount !== undefined ? ` · ${item.variableCount} variables` : ''}
            </Text>
          </View>
          <Text style={s.chev}>›</Text>
        </Pressable>
      )}
    />
  );
}

const s = StyleSheet.create({
  list: { padding: space.lg, gap: space.md },
  grow: { flexGrow: 1 },
  row: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rowMain: { flex: 1, gap: space.xs },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { color: c.text, fontSize: 16, fontWeight: '600', flex: 1 },
  meta: { color: c.textDim, fontSize: 12 },
  chev: { color: c.textFaint, fontSize: 22 },
});
