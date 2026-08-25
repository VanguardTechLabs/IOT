import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Pencil, Plus, Settings2 } from 'lucide-react';
import ReactGridLayout, { useContainerWidth, type Layout } from 'react-grid-layout';
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
// v2 bundles the resize-handle classes into this one file; the separate
// react-resizable stylesheet the README mentions is a v1 leftover, and it is not
// resolvable under pnpm's strict layout anyway since it is only a transitive dep.
import 'react-grid-layout/css/styles.css';

import {
  api,
  ApiError,
  type Dashboard,
  type VariableSeriesResponse,
  type StateEntry,
  type Variable,
  type Widget,
} from '../lib/api';
import { getSocket, type TelemetryEvent } from '../lib/socket';
import { WidgetView } from '../components/widgets/WidgetView';
import { WidgetEditor, type WidgetDraft } from '../components/WidgetEditor';
import { Alert, Button, EmptyState, Spinner } from '../components/ui';

interface DashboardResponse {
  dashboard: Dashboard;
  widgets: Widget[];
}

interface StateResponse {
  device: { id: string; name: string };
  state: StateEntry[];
}

const GRID_COLS = 12;
const ROW_HEIGHT = 56;

/**
 * A chart widget owns its own query — the range is per widget, so there is no
 * shared request to hoist. Everything else on the page renders from the single
 * device-state query and its socket patches.
 */
function ChartWidget({ widget }: { widget: Widget }) {
  const rangeMs = widget.config.rangeMs ?? 3_600_000;
  const { data } = useQuery({
    queryKey: ['widget-series', widget.variableId, rangeMs],
    enabled: !!widget.variableId,
    refetchInterval: 30_000,
    queryFn: () => {
      const now = Date.now();
      return api.get<VariableSeriesResponse>(
        `/variables/${widget.variableId}/series?from=${now - rangeMs}&to=${now}&maxPoints=120`,
      );
    },
  });

  // Top level, not data.series[0] — that is the multi-series endpoint's shape, and
  // reading it here meant the chart silently rendered "No data yet" forever.
  const points = data?.points ?? [];
  const color = widget.config.color ?? data?.variable.color ?? '#38bdf8';

  if (points.length === 0) return <div className="text-xs text-slate-500">No data yet</div>;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <YAxis hide domain={['auto', 'auto']} />
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
          labelFormatter={() => ''}
        />
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function DashboardDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const { width, containerRef, mounted } = useContainerWidth();

  const [editing, setEditing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const dashQuery = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => api.get<DashboardResponse>(`/dashboards/${id}`),
  });

  const deviceId = dashQuery.data?.dashboard.deviceId ?? null;

  const stateQuery = useQuery({
    queryKey: ['device-state', deviceId],
    enabled: !!deviceId,
    queryFn: () => api.get<StateResponse>(`/devices/${deviceId}/state`),
  });

  const variablesQuery = useQuery({
    queryKey: ['variables', deviceId],
    enabled: !!deviceId,
    queryFn: () => api.get<{ variables: Variable[] }>(`/devices/${deviceId}/variables`),
  });

  // Live values, patched into the cached state exactly as the device page does.
  useEffect(() => {
    if (!deviceId) return;
    const socket = getSocket();
    const join = () => socket.emit('subscribe:device', deviceId);
    join();
    socket.on('connect', join);

    const onTelemetry = (event: TelemetryEvent) => {
      if (event.deviceId !== deviceId) return;
      queryClient.setQueryData<StateResponse>(['device-state', deviceId], (prev) => {
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

    socket.on('telemetry', onTelemetry);
    return () => {
      socket.emit('unsubscribe:device', deviceId);
      socket.off('connect', join);
      socket.off('telemetry', onTelemetry);
    };
  }, [deviceId, queryClient]);

  const widgets = dashQuery.data?.widgets ?? [];
  const entries = useMemo(() => {
    const map = new Map<string, StateEntry>();
    for (const e of stateQuery.data?.state ?? []) map.set(e.variableId, e);
    return map;
  }, [stateQuery.data]);

  const layout: Layout = useMemo(
    () => widgets.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2 })),
    [widgets],
  );

  const saveLayout = useMutation({
    mutationFn: (next: Layout) =>
      api.post(`/dashboards/${id}/layout`, {
        widgets: next.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
      }),
    onError: () => setToast('Could not save the layout'),
  });

  // onLayoutChange also fires on mount and whenever the widget list changes, so
  // only persist while the user is actually editing.
  const skipFirst = useRef(true);
  const onLayoutChange = useCallback(
    (next: Layout) => {
      if (skipFirst.current) {
        skipFirst.current = false;
        return;
      }
      if (!editing || next.length === 0) return;
      saveLayout.mutate(next);
    },
    [editing, saveLayout],
  );

  const saveWidget = useMutation({
    mutationFn: async (draft: WidgetDraft) => {
      if (editingWidget) {
        return api.patch(`/widgets/${editingWidget.id}`, {
          variableId: draft.variableId,
          config: draft.config,
        });
      }
      // Drop a new widget at the bottom so it never lands on top of another.
      const y = widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
      return api.post(`/dashboards/${id}/widgets`, { ...draft, x: 0, y, w: 3, h: 3 });
    },
    onSuccess: () => {
      setEditorOpen(false);
      setEditingWidget(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the widget'),
  });

  const deleteWidget = useMutation({
    mutationFn: (widgetId: string) => api.delete(`/widgets/${widgetId}`),
    onSuccess: () => {
      setEditorOpen(false);
      setEditingWidget(null);
      void queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
    },
  });

  const sendCommand = useMutation({
    mutationFn: ({ variableId, value }: { variableId: string; value: string }) => {
      const variable = variablesQuery.data?.variables.find((v) => v.id === variableId);
      if (!variable) throw new Error('Variable not found');
      return api.post(`/devices/${deviceId}/commands`, { key: variable.key, value });
    },
    onSuccess: () => setToast('Command sent'),
    onError: (err) => setToast(err instanceof ApiError ? err.message : 'Command failed'),
  });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  if (dashQuery.isLoading) return <Spinner />;
  if (dashQuery.isError || !dashQuery.data) return <Alert>Dashboard not found.</Alert>;

  const { dashboard } = dashQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/dashboards" className="mb-1 flex items-center gap-1 text-sm text-slate-400 hover:text-white">
            <ArrowLeft size={14} /> Dashboards
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-white">{dashboard.name}</h1>
          {stateQuery.data && <p className="mt-1 text-sm text-slate-400">{stateQuery.data.device.name}</p>}
        </div>

        <div className="flex items-center gap-2">
          {editing && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditingWidget(null);
                setError(null);
                setEditorOpen(true);
              }}
            >
              <Plus size={16} /> Add widget
            </Button>
          )}
          <Button variant={editing ? 'primary' : 'ghost'} onClick={() => setEditing((e) => !e)}>
            {editing ? (
              <>
                <Check size={16} /> Done
              </>
            ) : (
              <>
                <Settings2 size={16} /> Edit layout
              </>
            )}
          </Button>
        </div>
      </div>

      {toast && <Alert tone="cyan">{toast}</Alert>}

      {editing && (
        <Alert tone="amber">
          Drag a widget by its title to move it, or drag the bottom-right corner to resize. Click the
          pencil on a widget to configure it.
        </Alert>
      )}

      {widgets.length === 0 ? (
        <EmptyState
          title="This dashboard is empty"
          description="Turn on Edit layout, then add gauges, tanks, switches and charts for this device's variables."
          action={
            <Button
              onClick={() => {
                setEditing(true);
                setEditingWidget(null);
                setEditorOpen(true);
              }}
            >
              Add your first widget
            </Button>
          }
        />
      ) : (
        <div ref={containerRef}>
          {mounted && (
            <ReactGridLayout
              layout={layout}
              width={width}
              onLayoutChange={onLayoutChange}
              gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [12, 12] }}
              dragConfig={{ enabled: editing, handle: '.drag-handle' }}
              resizeConfig={{ enabled: editing }}
            >
              {widgets.map((w) => (
                <div key={w.id} className="relative">
                  {editing && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingWidget(w);
                        setError(null);
                        setEditorOpen(true);
                      }}
                      className="absolute right-2 top-2 z-10 rounded-md bg-slate-800/90 p-1.5 text-slate-300 hover:text-white"
                      title="Configure"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {w.type === 'chart' ? (
                    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                      <div className="drag-handle mb-2 shrink-0 cursor-grab truncate text-xs font-medium uppercase tracking-wide text-slate-400">
                        {w.config.label ?? entries.get(w.variableId ?? '')?.label ?? 'Chart'}
                      </div>
                      <div className="min-h-0 flex-1">
                        <ChartWidget widget={w} />
                      </div>
                    </div>
                  ) : (
                    <WidgetView
                      widget={w}
                      entry={w.variableId ? entries.get(w.variableId) : undefined}
                      disabled={editing || sendCommand.isPending}
                      onCommand={(variableId, value) => sendCommand.mutate({ variableId, value })}
                    />
                  )}
                </div>
              ))}
            </ReactGridLayout>
          )}
        </div>
      )}

      <WidgetEditor
        open={editorOpen}
        existing={editingWidget}
        variables={variablesQuery.data?.variables ?? []}
        saving={saveWidget.isPending}
        error={error}
        onClose={() => {
          setEditorOpen(false);
          setEditingWidget(null);
        }}
        onSave={(draft) => saveWidget.mutate(draft)}
        onDelete={
          editingWidget
            ? () => {
                if (confirm('Delete this widget?')) deleteWidget.mutate(editingWidget.id);
              }
            : undefined
        }
      />
    </div>
  );
}
