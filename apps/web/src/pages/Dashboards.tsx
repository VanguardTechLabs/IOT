import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, type Dashboard, type Device } from '../lib/api';
import { relativeTime } from '../lib/format';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
} from '../components/ui';

/**
 * Dashboards are device-scoped in this first version: one device per dashboard,
 * so every widget on it reads from the same live state query. The schema already
 * allows a null device for a multi-device dashboard later.
 */
export function DashboardsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api.get<{ dashboards: Dashboard[] }>('/dashboards'),
  });

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<{ devices: Device[] }>('/devices'),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ dashboard: Dashboard }>('/dashboards', { name, deviceId: deviceId || null }),
    onSuccess: () => {
      setCreating(false);
      setName('');
      setDeviceId('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create the dashboard'),
  });

  /**
   * Deleting takes the widgets with it — the foreign key cascades — so the
   * confirmation names the dashboard rather than asking a generic "are you
   * sure". Someone who built forty widgets deserves to see which one is about
   * to go.
   */
  const remove = useMutation({
    mutationFn: (dashboardId: string) => api.delete(`/dashboards/${dashboardId}`),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not delete the dashboard'),
  });

  const dashboards = data?.dashboards ?? [];
  const devices = devicesQuery.data?.devices ?? [];
  const deviceName = (id: string | null) => devices.find((d) => d.id === id)?.name ?? 'All devices';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Dashboards</h1>
          <p className="mt-1 text-sm text-slate-400">
            Build your own view with gauges, tanks, switches and charts.
          </p>
        </div>
        <Button
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
          disabled={isError || devices.length === 0}
          title={devices.length === 0 ? 'Create a device first' : undefined}
        >
          <Plus size={16} /> New dashboard
        </Button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <Alert>
          Could not load your dashboards.{' '}
          <button className="underline underline-offset-2" onClick={() => void refetch()}>
            Retry
          </button>
        </Alert>
      ) : dashboards.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid size={32} />}
          title="No dashboards yet"
          description="A dashboard lets you arrange indicators however you like — level gauges, thermometers, switches and sliders — and resize and move each one."
          action={
            devices.length > 0 ? (
              <Button onClick={() => setCreating(true)}>Create your first dashboard</Button>
            ) : (
              <p className="text-sm text-slate-400">Create a device first.</p>
            )
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((d) => (
            <div key={d.id} className="relative">
              {/*
                * Outside the Link, not inside it: nesting a button in an anchor
                * means every delete also navigates.
                */}
              <button
                type="button"
                aria-label={`Delete ${d.name}`}
                title="Delete dashboard"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    confirm(
                      `Delete the dashboard "${d.name}"?

Its widgets go with it. Your devices and their history are not touched.`,
                    )
                  ) {
                    remove.mutate(d.id);
                  }
                }}
                className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
              >
                <Trash2 size={16} />
              </button>
              <Link to={`/dashboards/${d.id}`}>
                <Card className="p-5 transition hover:border-cyan-500/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 pr-8">
                      <h3 className="truncate text-base font-semibold text-white">{d.name}</h3>
                      <p className="mt-1 truncate text-sm text-slate-400">{deviceName(d.deviceId)}</p>
                    </div>
                  </div>
                  <p className="mt-4 text-xs text-slate-500">Updated {relativeTime(d.updatedAt)}</p>
                </Card>
              </Link>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        title="New dashboard"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button loading={create.isPending} disabled={!name.trim() || !deviceId} onClick={() => create.mutate()}>
              Create dashboard
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Planta baja" autoFocus />
          </Field>
          <Field label="Device" hint="Every widget on this dashboard reads from this device.">
            <Select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Select a device…</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}
