import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  api,
  type Dashboard,
  type Series,
  type SeriesPoint,
  type VariableState,
  type Widget as WidgetModel,
} from '../../src/api';
import { Empty, Loading, Note } from '../../src/components/ui';
import { Widget } from '../../src/components/Widget';
import { getSocket, type TelemetryEvent } from '../../src/socket';
import { c, space } from '../../src/theme';

interface DashboardResponse {
  dashboard: Dashboard;
  widgets: WidgetModel[];
}

/**
 * A dashboard the user built on the web, shown on a phone.
 *
 * The panel places widgets on a 12-column grid the user drags around. A 360 px
 * screen cannot honour that, and shrinking it produces twelve unreadable
 * columns. So the grid becomes an ORDER — sorted by row, then by column, which
 * is how someone reads their own layout — and each widget takes a full or half
 * width depending on how wide it was on the desktop. Narrow widgets pair up,
 * wide ones span. The dashboard stays recognisably the one they built.
 */
export default function DashboardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const qc = useQueryClient();
  const { width: screenWidth } = useWindowDimensions();
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => api.get<DashboardResponse>(`/dashboards/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    const name = query.data?.dashboard.name;
    if (name) navigation.setOptions({ title: name });
  }, [query.data?.dashboard.name, navigation]);

  const widgets = useMemo(
    () => [...(query.data?.widgets ?? [])].sort((a, b) => a.y - b.y || a.x - b.x),
    [query.data?.widgets],
  );

  // Which devices these widgets belong to is not on the widget record, so state
  // is fetched per device across the account. One request per device beats one
  // per widget: a dashboard commonly has nine widgets on a single device.
  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<{ devices: { id: string }[] }>('/devices'),
  });

  const deviceIds = useMemo(() => (devicesQuery.data?.devices ?? []).map((d) => d.id), [devicesQuery.data]);

  const stateQueries = useQueries({
    queries: deviceIds.map((deviceId) => ({
      queryKey: ['device', deviceId],
      queryFn: () => api.get<{ device: { id: string }; state: VariableState[] }>(`/devices/${deviceId}/state`),
    })),
  });

  /** variableId → its newest value, across every device the account owns. */
  const stateByVariable = useMemo(() => {
    const map = new Map<string, VariableState>();
    for (const q of stateQueries) {
      for (const row of q.data?.state ?? []) map.set(row.variableId, row);
    }
    return map;
  }, [stateQueries]);

  /** variableId → the device that owns it, so a command knows where to go. */
  const deviceByVariable = useMemo(() => {
    const map = new Map<string, string>();
    stateQueries.forEach((q, index) => {
      const deviceId = deviceIds[index];
      if (!deviceId) return;
      for (const row of q.data?.state ?? []) map.set(row.variableId, deviceId);
    });
    return map;
  }, [stateQueries, deviceIds]);

  // Charts need history, which the state endpoint does not carry. Only chart
  // widgets ask for it — fetching a series for a gauge would be a wasted query.
  const chartWidgets = widgets.filter((w) => w.type === 'chart' && w.variableId);
  const seriesQueries = useQueries({
    queries: chartWidgets.map((w) => ({
      queryKey: ['series', w.variableId, w.config?.rangeMs ?? 3_600_000],
      queryFn: () => {
        const range = w.config?.rangeMs ?? 3_600_000;
        const to = Date.now();
        return api.get<Series>(
          `/variables/${w.variableId}/series?from=${to - range}&to=${to}&maxPoints=200`,
        );
      },
      refetchInterval: 60_000,
    })),
  });

  const seriesByVariable = useMemo(() => {
    const map = new Map<string, SeriesPoint[]>();
    chartWidgets.forEach((w, index) => {
      const points = seriesQueries[index]?.data?.points;
      if (w.variableId && points) map.set(w.variableId, points);
    });
    return map;
  }, [chartWidgets, seriesQueries]);

  // Live values, patched into whichever device query owns the variable.
  useEffect(() => {
    const socket = getSocket();
    const onTelemetry = (event: TelemetryEvent) => {
      qc.setQueryData<{ device: { id: string }; state: VariableState[] }>(
        ['device', event.deviceId],
        (prev) => {
          if (!prev) return prev;
          const patch = new Map(event.points.map((p) => [p.variableId, p]));
          return {
            ...prev,
            state: prev.state.map((row) => {
              const point = patch.get(row.variableId);
              if (!point) return row;
              return {
                ...row,
                ts: new Date(point.ts).toISOString(),
                valueNum: point.num,
                valueText: point.text,
              };
            }),
          };
        },
      );
    };
    socket.on('telemetry', onTelemetry);
    return () => {
      socket.off('telemetry', onTelemetry);
    };
  }, [qc]);

  const write = useMutation({
    mutationFn: (vars: { deviceId: string; key: string; value: string }) =>
      api.post(`/devices/${vars.deviceId}/commands`, { key: vars.key, value: vars.value }),
    onError: (err: Error) => setError(err.message),
    onSuccess: () => setError(null),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError) {
    return (
      <View style={{ padding: space.lg }}>
        <Note>Could not load this dashboard.</Note>
      </View>
    );
  }

  const gap = space.md;
  const full = screenWidth - space.lg * 2;
  const half = (full - gap) / 2;

  return (
    <ScrollView
      contentContainerStyle={widgets.length === 0 ? s.grow : s.page}
      refreshControl={
        <RefreshControl refreshing={query.isFetching} onRefresh={() => void query.refetch()} tintColor={c.accent} />
      }
    >
      {error ? <Note>{error}</Note> : null}

      {widgets.length === 0 ? (
        <Empty title="This dashboard is empty" hint="Add widgets on the web panel and they appear here." />
      ) : (
        <View style={[s.grid, { gap }]}>
          {widgets.map((widget) => {
            const state = widget.variableId ? stateByVariable.get(widget.variableId) : undefined;
            const deviceId = widget.variableId ? deviceByVariable.get(widget.variableId) : undefined;
            // A chart squeezed into half a screen is unreadable, so it always
            // spans regardless of its desktop width.
            const wide = widget.w > 4 || widget.type === 'chart' || widget.type === 'text';
            const width = wide ? full : half;
            return (
              <Widget
                key={widget.id}
                widget={widget}
                state={state}
                points={widget.variableId ? (seriesByVariable.get(widget.variableId) ?? []) : []}
                width={width}
                writing={write.isPending}
                onWrite={(key, value) => {
                  if (!deviceId || !key) {
                    setError('This widget is not linked to a device that can receive commands');
                    return;
                  }
                  write.mutate({ deviceId, key, value });
                }}
              />
            );
          })}
        </View>
      )}

      <Text style={s.footnote}>Layout follows the order you set on the web panel.</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: space.lg, gap: space.md },
  grow: { flexGrow: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  footnote: { color: c.textFaint, fontSize: 11, textAlign: 'center', marginTop: space.sm },
});
