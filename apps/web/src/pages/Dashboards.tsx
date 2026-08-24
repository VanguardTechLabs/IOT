import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, Plus } from 'lucide-react';
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
            <Link key={d.id} to={`/dashboards/${d.id}`}>
              <Card className="p-5 transition hover:border-cyan-500/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-white">{d.name}</h3>
                    <p className="mt-1 truncate text-sm text-slate-400">{deviceName(d.deviceId)}</p>
                  </div>
                  <LayoutGrid size={18} className="shrink-0 text-slate-500" />
                </div>
                <p className="mt-4 text-xs text-slate-500">Updated {relativeTime(d.updatedAt)}</p>
              </Card>
            </Link>
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
