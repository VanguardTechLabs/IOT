import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, KeyRound, Plus, Settings2, Trash2 } from 'lucide-react';
import {
  api,
  ApiError,
  getAccessToken,
  refreshSession,
  type Device,
  type SeriesResponse,
  type StateEntry,
  type Variable,
} from '../lib/api';
import { getSocket, type StatusEvent, type TelemetryEvent } from '../lib/socket';
import {
  RANGES,
  browserTimeZone,
  formatCount,
  formatFullClock,
  listTimeZones,
  relativeTime,
} from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyField,
  EmptyState,
  Field,
  Input,
  Modal,
  SectionTitle,
  Select,
  Spinner,
  StatusDot,
} from '../components/ui';
import { VariableTile } from '../components/VariableTile';
import { SeriesChart } from '../components/SeriesChart';
import { ConnectPanel } from '../components/ConnectPanel';
import { VariableEditor } from '../components/VariableEditor';

interface StateResponse {
  device: Device;
  state: StateEntry[];
}

export function DeviceDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [rangeMs, setRangeMs] = useState<number>(RANGES[1].ms);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Variable | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The chart defaults apply once per device, not every time the selection empties.
  const defaultsApplied = useRef(false);

  const stateQuery = useQuery({
    queryKey: ['device-state', id],
    queryFn: () => api.get<StateResponse>(`/devices/${id}/state`),
  });

  const variablesQuery = useQuery({
    queryKey: ['variables', id],
    queryFn: () => api.get<{ variables: Variable[] }>(`/devices/${id}/variables`),
  });

  const seriesQuery = useQuery({
    queryKey: ['series', id, rangeMs, [...selected].sort().join(',')],
    queryFn: () => {
      // Anchor the window at fetch time and plot the range the server actually
      // used, so the axis can never drift away from the data it is labelling.
      const now = Date.now();
      return api.get<SeriesResponse>(
        `/devices/${id}/series?from=${now - rangeMs}&to=${now}` +
          (selected.size > 0 ? `&variableIds=${[...selected].join(',')}` : ''),
      );
    },
    enabled: Boolean(id),
    // Short windows keep refreshing so the chart tracks the live tiles; long
    // windows are backed by rollups that only change every minute anyway.
    refetchInterval: rangeMs <= 3_600_000 ? 15_000 : 60_000,
  });

  // Default the chart to the first four numeric variables — once. Keying this on
  // `selected.size` re-applied the defaults the instant the user unticked the last
  // variable, so clearing the chart was impossible.
  useEffect(() => {
    defaultsApplied.current = false;
  }, [id]);

  useEffect(() => {
    if (defaultsApplied.current) return;
    const numeric = (stateQuery.data?.state ?? []).filter((s) => s.type !== 'string').slice(0, 4);
    if (numeric.length > 0) {
      defaultsApplied.current = true;
      setSelected(new Set(numeric.map((s) => s.variableId)));
    }
  }, [stateQuery.data]);

  // Live values: patch the cached state in place instead of refetching.
  useEffect(() => {
    if (!id) return;
    const socket = getSocket();
    // Rooms live on the server side of a connection, so they do not survive a
    // reconnect. Without re-joining, the page keeps rendering stale values after a
    // brief network blip with nothing on screen to say the feed died.
    const join = () => socket.emit('subscribe:device', id);
    join();
    socket.on('connect', join);

    const onTelemetry = (event: TelemetryEvent) => {
      if (event.deviceId !== id) return;
      queryClient.setQueryData<StateResponse>(['device-state', id], (prev) => {
        if (!prev) return prev;
        const patch = new Map(event.points.map((p) => [p.variableId, p]));
        return {
          ...prev,
          state: prev.state.map((entry) => {
            const point = patch.get(entry.variableId);
            if (!point) return entry;
            return {
              ...entry,
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
      queryClient.setQueryData<StateResponse>(['device-state', id], (prev) =>
        prev
          ? {
              ...prev,
              device: {
                ...prev.device,
                online: event.online,
                lastSeenAt: event.lastSeenAt,
                messageCount: event.messageCount ?? prev.device.messageCount,
                pointCount: event.pointCount ?? prev.device.pointCount,
              },
            }
          : prev,
      );
    };

    const onVariableCreated = () => {
      void queryClient.invalidateQueries({ queryKey: ['device-state', id] });
      void queryClient.invalidateQueries({ queryKey: ['variables', id] });
    };

    socket.on('telemetry', onTelemetry);
    socket.on('device:status', onStatus);
    socket.on('variable:created', onVariableCreated);

    return () => {
      socket.emit('unsubscribe:device', id);
      socket.off('connect', join);
      socket.off('telemetry', onTelemetry);
      socket.off('device:status', onStatus);
      socket.off('variable:created', onVariableCreated);
    };
  }, [id, queryClient]);

  const sendCommand = useMutation({
    mutationFn: (payload: { key: string; value: string }) => api.post(`/devices/${id}/commands`, payload),
    onSuccess: (_data, payload) => setToast(`Sent ${payload.key} = ${payload.value}`),
    onError: (err) => setToast(err instanceof ApiError ? err.message : 'Command failed'),
  });

  const removeDevice = useMutation({
    mutationFn: () => api.delete(`/devices/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      navigate('/devices');
    },
  });

  const rotateToken = useMutation({
    mutationFn: () => api.post<{ token: string }>(`/devices/${id}/rotate-token`),
    onSuccess: (result) => setRotatedToken(result.token),
  });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const toggleSelected = useCallback((variableId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(variableId)) next.delete(variableId);
      else next.add(variableId);
      return next;
    });
  }, []);

  const exportCsv = useCallback(async () => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - rangeMs).toISOString(),
      to: new Date().toISOString(),
    });
    if (selected.size > 0) params.set('variableIds', [...selected].join(','));

    // The export route streams, so fetch it with the bearer token and hand the
    // browser a blob rather than opening an unauthenticated URL. This bypasses the
    // api helper, so it has to retry the 401 refresh itself — otherwise an expired
    // access token turns a 30-day export into a bare "Export failed".
    const doFetch = () =>
      fetch(`/api/v1/devices/${id}/export.csv?${params}`, {
        headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
        credentials: 'include',
      });

    let res = await doFetch();
    if (res.status === 401 && (await refreshSession())) res = await doFetch();

    if (!res.ok) {
      setToast('Export failed');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${stateQuery.data?.device.name ?? 'device'}.csv`;
    // Firefox ignores a click on an anchor that is not in the document.
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [id, rangeMs, selected, stateQuery.data]);

  if (stateQuery.isLoading) return <Spinner />;
  if (stateQuery.isError || !stateQuery.data) return <Alert>Device not found.</Alert>;

  const { device, state } = stateQuery.data;
  const variables = variablesQuery.data?.variables ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/devices" className="mb-2 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200">
            <ArrowLeft size={13} /> All devices
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-white">{device.name}</h1>
            <span className="flex items-center gap-1.5 text-sm text-slate-400">
              <StatusDot online={device.online} />
              {device.online ? 'Online' : 'Offline'}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <code className="font-mono text-slate-400">{device.deviceKey}</code>
            <Badge tone="slate">every {device.intervalS}s</Badge>
            <Badge tone="slate">{formatCount(device.messageCount)} messages</Badge>
            <Badge tone="slate">{formatCount(device.pointCount)} datapoints</Badge>
            <span>last seen {relativeTime(device.lastSeenAt)}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void exportCsv()}>
            <Download size={15} /> Export CSV
          </Button>
          <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={15} /> Settings
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <Plus size={15} /> Variable
          </Button>
        </div>
      </div>

      {state.length === 0 ? (
        <EmptyState
          title="No variables yet"
          description="Add them here, or just start publishing — unknown keys are created automatically with an inferred type that you can refine."
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              Add a variable
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {state.map((entry) => (
            <VariableTile
              key={entry.variableId}
              entry={entry}
              selected={selected.has(entry.variableId)}
              onToggle={() => toggleSelected(entry.variableId)}
              onEdit={() => {
                setEditing(variables.find((v) => v.id === entry.variableId) ?? null);
                setEditorOpen(true);
              }}
              onCommand={(value) => sendCommand.mutate({ key: entry.key, value })}
            />
          ))}
        </div>
      )}

      <Card>
        <SectionTitle
          title="History"
          subtitle={
            seriesQuery.data
              ? `Resolution: ${seriesQuery.data.series[0]?.resolution ?? 'raw'} · times in ${device.timezone} · click a tile above to add or remove it`
              : undefined
          }
          action={
            <div className="flex gap-1 rounded-lg bg-white/5 p-1">
              {RANGES.map((range) => (
                <button
                  key={range.label}
                  onClick={() => setRangeMs(range.ms)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    rangeMs === range.ms ? 'bg-cyan-500 text-ink-950' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {range.label}
                </button>
              ))}
            </div>
          }
        />
        {seriesQuery.isLoading ? (
          <Spinner />
        ) : (
          <SeriesChart
            series={seriesQuery.data?.series ?? []}
            from={seriesQuery.data?.from ?? Date.now() - rangeMs}
            to={seriesQuery.data?.to ?? Date.now()}
            timeZone={device.timezone}
          />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card>
          <SectionTitle title="Connect this device" subtitle="Same credentials across all three protocols." />
          <ConnectPanel deviceId={id} />
        </Card>

        <CommandHistory deviceId={id} timeZone={device.timezone} refreshKey={sendCommand.submittedAt} />
      </div>

      <VariableEditor deviceId={id} variable={editing} open={editorOpen} onClose={() => setEditorOpen(false)} />

      <DeviceSettings
        device={device}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onRotate={() => rotateToken.mutate()}
        rotating={rotateToken.isPending}
        onDelete={() => {
          if (confirm(`Delete "${device.name}" and all of its telemetry? This cannot be undone.`)) {
            removeDevice.mutate();
          }
        }}
      />

      <Modal
        open={rotatedToken !== null}
        title="New device token"
        onClose={() => setRotatedToken(null)}
        footer={<Button onClick={() => setRotatedToken(null)}>Done</Button>}
      >
        <div className="space-y-4">
          <Alert tone="amber">The previous token stopped working immediately. Update your firmware now.</Alert>
          <CopyField label="Device token" value={rotatedToken ?? ''} />
        </div>
      </Modal>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-ink-850/95 px-4 py-2 text-sm text-slate-200 shadow-xl backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}

interface CommandRow {
  id: string;
  key: string;
  value: string;
  source: string;
  createdAt: string;
}

/** Audit trail of every write sent to this device, newest first. */
function CommandHistory({
  deviceId,
  timeZone,
  refreshKey,
}: {
  deviceId: string;
  timeZone: string;
  refreshKey: number;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['commands', deviceId],
    queryFn: () => api.get<{ commands: CommandRow[] }>(`/devices/${deviceId}/commands`),
  });

  // A command sent from a tile above should show up here without a manual refresh.
  useEffect(() => {
    if (refreshKey) void queryClient.invalidateQueries({ queryKey: ['commands', deviceId] });
  }, [refreshKey, deviceId, queryClient]);

  const commands = data?.commands ?? [];

  return (
    <Card>
      <SectionTitle title="Command history" subtitle="Writes sent from the panel to this device." />
      {isLoading ? (
        <Spinner />
      ) : commands.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No commands sent yet. Mark a variable as writable to get a control on its tile.
        </p>
      ) : (
        <div className="max-h-80 divide-y divide-white/5 overflow-y-auto">
          {commands.map((command) => (
            <div key={command.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-slate-200">
                  {command.key} <span className="text-slate-500">=</span>{' '}
                  <span className="text-cyan-300">{command.value}</span>
                </p>
                <p className="text-[11px] text-slate-500">
                  {formatFullClock(new Date(command.createdAt).getTime(), timeZone)}
                </p>
              </div>
              <Badge tone="slate">{command.source}</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function DeviceSettings({
  device,
  open,
  onClose,
  onRotate,
  rotating,
  onDelete,
}: {
  device: Device;
  open: boolean;
  onClose: () => void;
  onRotate: () => void;
  rotating: boolean;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: device.name,
    description: device.description,
    intervalS: device.intervalS,
    timezone: device.timezone,
    enabled: device.enabled,
    autoCreateVariables: device.autoCreateVariables,
  });
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => listTimeZones(), []);

  useEffect(() => {
    if (open) {
      setForm({
        name: device.name,
        description: device.description,
        intervalS: device.intervalS,
        timezone: device.timezone,
        enabled: device.enabled,
        autoCreateVariables: device.autoCreateVariables,
      });
      setError(null);
    }
  }, [open, device]);

  const save = useMutation({
    mutationFn: () => api.patch(`/devices/${device.id}`, form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['device-state', device.id] });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save'),
  });

  return (
    <Modal
      open={open}
      title="Device settings"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" className="mr-auto" onClick={onDelete}>
            <Trash2 size={14} /> Delete device
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field
          label="Reporting interval (seconds)"
          hint="Sent to the device on connect and used to decide when it counts as offline."
        >
          <Input
            type="number"
            min={1}
            max={86400}
            value={form.intervalS}
            onChange={(e) => setForm({ ...form, intervalS: Number(e.target.value) })}
          />
        </Field>

        <Field
          label="Time zone"
          hint="Telemetry is always stored in UTC — this only changes how this device's charts and CSV export are labelled."
        >
          <div className="flex gap-2">
            <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {!zones.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              className="shrink-0"
              onClick={() => setForm({ ...form, timezone: browserTimeZone() })}
              title="Use the zone this browser is in"
            >
              Use mine
            </Button>
          </div>
        </Field>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <input
            type="checkbox"
            checked={form.autoCreateVariables}
            onChange={(e) => setForm({ ...form, autoCreateVariables: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan-500"
          />
          <span className="text-sm">
            <span className="font-medium text-slate-200">Create variables automatically</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Unknown keys in an uplink become variables with an inferred type. Turn this off to reject anything
              you have not declared.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan-500"
          />
          <span className="text-sm">
            <span className="font-medium text-slate-200">Enabled</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Disabling revokes the broker credentials immediately, without deleting any history.
            </span>
          </span>
        </label>

        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Device token</p>
              <code className="mt-0.5 block font-mono text-xs text-slate-500">{device.tokenPreview || 'hidden'}</code>
            </div>
            <Button variant="ghost" onClick={onRotate} loading={rotating}>
              <KeyRound size={14} /> Rotate
            </Button>
          </div>
        </div>

        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}
