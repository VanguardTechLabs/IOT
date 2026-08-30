import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, type Dashboard } from '../../src/api';
import { Empty, Loading, Note } from '../../src/components/ui';
import { c, radius, space } from '../../src/theme';

export default function Dashboards() {
  const router = useRouter();
  const query = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api.get<{ dashboards: Dashboard[] }>('/dashboards'),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError) {
    return (
      <View style={{ padding: space.lg }}>
        <Note>Could not load your dashboards. Pull down to try again.</Note>
      </View>
    );
  }

  const dashboards = query.data?.dashboards ?? [];

  return (
    <FlatList
      data={dashboards}
      keyExtractor={(d) => d.id}
      contentContainerStyle={dashboards.length === 0 ? s.grow : s.list}
      refreshControl={
        <RefreshControl refreshing={query.isFetching} onRefresh={() => void query.refetch()} tintColor={c.accent} />
      }
      ListEmptyComponent={
        <Empty
          title="No dashboards yet"
          hint="Build one on the web panel — drag the widgets where you want them — and it will show up here."
        />
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push({ pathname: '/dashboard/[id]', params: { id: item.id } })}
          style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
        >
          <View style={{ flex: 1, gap: space.xs }}>
            <Text style={s.name} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={s.meta}>
              {item.widgetCount === undefined
                ? item.slug
                : `${item.widgetCount} ${item.widgetCount === 1 ? 'widget' : 'widgets'}`}
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
  name: { color: c.text, fontSize: 16, fontWeight: '600' },
  meta: { color: c.textDim, fontSize: 12 },
  chev: { color: c.textFaint, fontSize: 22 },
});
