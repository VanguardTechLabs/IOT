import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { api, type Device, type VariableState, type WidgetType } from '../../src/api';
import { Card, Dot, Empty, Loading, Note } from '../../src/components/ui';
import { Widget } from '../../src/components/Widget';
import { getSocket, type StatusEvent, type TelemetryEvent } from '../../src/socket';
import { c, space } from '../../src/theme';

interface StateResponse {
  device: Device;
  state: VariableState[];
}

/**
 * One device, live.
 *
 * Every variable is shown, and the writable ones get a control — a toggle for
 * booleans, a slider for numbers. This is the screen the client described as the
 * point of the app: see the tank level and flip the pump without opening a
 * laptop.
 */
export default function DeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const qc = useQueryClient();
  const { width: screenWidth } = useWindowDimensions();
  const [error, setError] = useState<string | null>(null);
  // Single column, page padding on both sides.
  const cardWidth = screenWidth - space.lg * 2;

  const query = useQuery({
    queryKey: ['device', id],
    queryFn: () => api.get<StateResponse>(`/devices/${id}/state`),
    enabled: Boolean(id),
  });

  const device = query.data?.device;

  useEffect(() => {
    if (device?.name) navigation.setOptions({ title: device.name });
  }, [device?.name, navigation]);

  // Live values. The socket carries every device the account owns, so the
  // deviceId check is what keeps another device's telemetry off this screen.
  useEffect(() => {
    if (!id) return;
    const socket = getSocket();

    const onTelemetry = (event: TelemetryEvent) => {
      if (event.deviceId !== id) return;
      qc.setQueryData<StateResponse>(['device', id], (prev) => {
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
      });
    };

    const onStatus = (event: StatusEvent) => {
      if (event.deviceId !== id) return;
      qc.setQueryData<StateResponse>(['device', id], (prev) =>
        prev
          ? {
              ...prev,
              device: { ...prev.device, online: event.online, lastSeenAt: event.lastSeenAt ?? prev.device.lastSeenAt },
            }
          : prev,
      );
    };

    socket.on('telemetry', onTelemetry);
    socket.on('status', onStatus);
    return () => {
      socket.off('telemetry', onTelemetry);
      socket.off('status', onStatus);
    };
  }, [id, qc]);

  const write = useMutation({
    mutationFn: (vars: { key: string; value: string }) => api.post(`/devices/${id}/commands`, vars),
    onError: (err: Error) => setError(err.message),
    onSuccess: () => setError(null),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError || !device) {
    return (
      <View style={{ padding: space.lg }}>
        <Note>Could not load this device.</Note>
      </View>
    );
  }

  const rows = query.data?.state ?? [];

  return (
    <ScrollView
      contentContainerStyle={rows.length === 0 ? s.grow : s.page}
      refreshControl={
        <RefreshControl refreshing={query.isFetching} onRefresh={() => void query.refetch()} tintColor={c.accent} />
      }
    >
      <Card>
        <View style={s.headline}>
          <Dot on={device.online} />
          <Text style={s.status}>{device.online ? 'Online' : 'Offline'}</Text>
        </View>
        <Text style={s.dim}>
          Reports every {device.intervalS}s over {device.lastTransport ?? 'no transport yet'} ·{' '}
          {device.messageCount.toLocaleString()} messages
        </Text>
      </Card>

      {error ? <Note>{error}</Note> : null}

      {rows.length === 0 ? (
        <Empty
          title="No variables yet"
          hint="Variables appear automatically the first time this device sends a reading."
        />
      ) : (
        rows.map((row) => (
          <VariableRow
            key={row.variableId}
            row={row}
            width={cardWidth}
            writing={write.isPending}
            onWrite={(key, value) => write.mutate({ key, value })}
          />
        ))
      )}
    </ScrollView>
  );
}

/**
 * A variable rendered with the control that fits it.
 *
 * There is no widget record here — this screen is the raw device, not a
 * dashboard — so a synthetic one is built to reuse exactly the same components
 * the dashboard uses. Two renderers for one job is how the two drift apart.
 */
function VariableRow({
  row,
  width,
  writing,
  onWrite,
}: {
  row: VariableState;
  width: number;
  writing: boolean;
  onWrite: (key: string, value: string) => void;
}) {
  // The database stores int | float | bool | string, so matching on 'boolean'
  // or 'number' matched nothing and every variable fell through to a read-only
  // display.
  //
  // Type alone is not enough either. inferType() reads the string "1" a device
  // sends as an INT, so nearly every relay in the system is typed int rather
  // than bool — bool only happens when someone sets it by hand or the firmware
  // sends "on"/"true". Treating writable ints as sliders would therefore put a
  // 0-100 slider on almost every relay, and let someone send 47 to a device
  // that understands 0 and 1.
  //
  // So an integer is a switch unless its configured range says otherwise. A
  // slider only appears where a real range exists to slide across.
  const hasRange = row.minValue !== null && row.maxValue !== null;
  const spansMoreThanOnOff = hasRange && row.maxValue! - row.minValue! > 1;
  const switchLike = row.type === 'bool' || (row.type === 'int' && !spansMoreThanOnOff);

  const type: WidgetType = !row.writable
    ? switchLike
      ? 'led'
      : 'number'
    : switchLike
      ? 'toggle'
      : row.type === 'float' || row.type === 'int'
        ? 'slider'
        : 'number';

  return (
    <Widget
      widget={{
        id: row.variableId,
        dashboardId: '',
        variableId: row.variableId,
        type,
        x: 0,
        y: 0,
        w: 12,
        h: 2,
        config: {
          label: row.label ?? row.key,
          unit: row.unit ?? undefined,
          // The slider's real bounds when they exist. Falling back to 0-100 for
          // an unconfigured variable is a guess, but a visible one — the value
          // is shown above the track before anything is sent.
          ...(hasRange ? { min: row.minValue!, max: row.maxValue! } : {}),
          ...(row.type === 'int' ? { decimals: 0 } : {}),
        },
      }}
      state={row}
      points={[]}
      width={width}
      onWrite={onWrite}
      writing={writing}
    />
  );
}

const s = StyleSheet.create({
  page: { padding: space.lg, gap: space.md },
  grow: { flexGrow: 1 },
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  status: { color: c.text, fontSize: 16, fontWeight: '600' },
  dim: { color: c.textDim, fontSize: 12 },
});
