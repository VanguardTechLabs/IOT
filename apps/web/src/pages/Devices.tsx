import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Plus, Radio } from 'lucide-react';
import { api, ApiError, type Device } from '../lib/api';
import { getSocket, type StatusEvent } from '../lib/socket';
import { browserTimeZone, formatCount, relativeTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import { Alert, Badge, Button, CopyField, EmptyState, Field, Input, Modal, SectionTitle, Spinner, StatusDot } from '../components/ui';

export function DevicesPage() {
  const queryClient = useQueryClient();
  const { plan } = useAuth();
  const [creating, setCreating] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ token: string; device: Device } | null>(null);
  // Default to the zone of whoever is creating the device; it stays editable per
  // device afterwards, which is what a customer with sites in two zones needs.
  const [form, setForm] = useState({ name: '', description: '', intervalS: 10, timezone: browserTimeZone() });
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<{ devices: Device[] }>('/devices'),
  });

  // Presence changes arrive over the socket, so the list stays truthful without polling.
  useEffect(() => {
    const socket = getSocket();
    const onStatus = (event: StatusEvent) => {
      queryClient.setQueryData<{ devices: Device[] }>(['devices'], (prev) =>
        prev
          ? {
              devices: prev.devices.map((d) =>
                d.id === event.deviceId
                  ? {
                      ...d,
                      online: event.online,
                      lastSeenAt: event.lastSeenAt,
                      messageCount: event.messageCount ?? d.messageCount,
                      pointCount: event.pointCount ?? d.pointCount,
                    }
                  : d,
              ),
            }
          : prev,
      );
    };
    socket.on('device:status', onStatus);
    return () => {
      socket.off('device:status', onStatus);
    };
  }, [queryClient]);

  const createDevice = useMutation({
    mutationFn: () => api.post<{ device: Device; token: string }>('/devices', form),
    onSuccess: (result) => {
      setCreating(false);
      setForm({ name: '', description: '', intervalS: 10, timezone: browserTimeZone() });
      setIssuedToken(result);
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create the device'),
  });

  const devices = data?.devices ?? [];
  // A failed fetch leaves `devices` empty, which must not read as "room for more" —
  // the create would then fail server-side against the real plan limit anyway.
  const atLimit = plan && !isError ? devices.length >= plan.maxDevices : false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Devices</h1>
          <p className="mt-1 text-sm text-slate-400">
            {devices.length} of {plan?.maxDevices ?? '—'} devices on the {plan?.name ?? ''} plan ·{' '}
            {devices.filter((d) => d.online).length} online
          </p>
        </div>
        <Button
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
          disabled={atLimit || isError}
          title={atLimit ? 'Device limit reached for this plan' : undefined}
        >
          <Plus size={16} /> New device
        </Button>
      </div>

      {atLimit && (
        <Alert tone="amber">
          You have reached the {plan?.name} plan limit of {plan?.maxDevices} devices. Upgrade to connect more.
        </Alert>
      )}

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <Alert>
          Could not load your devices.{' '}
          <button className="underline underline-offset-2" onClick={() => void refetch()}>
            Retry
          </button>
        </Alert>
      ) : devices.length === 0 ? (
        <EmptyState
          icon={<Cpu size={32} />}
          title="No devices yet"
          description="Create a device to get its credentials, then flash the ESP32 example and watch the values arrive live."
          action={<Button onClick={() => setCreating(true)}>Create your first device</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {devices.map((device) => (
            <Link
              key={device.id}
              to={`/devices/${device.id}`}
              className="card group p-5 transition hover:border-cyan-400/30 hover:bg-ink-850/70"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-white group-hover:text-cyan-200">{device.name}</p>
                  <code className="mt-0.5 block truncate font-mono text-xs text-slate-500">{device.deviceKey}</code>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <StatusDot online={device.online} />
                  {device.online ? 'Online' : 'Offline'}
                </div>
              </div>

              {device.description && (
                <p className="mt-3 line-clamp-2 text-sm text-slate-400">{device.description}</p>
              )}

              <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                <Stat label="Variables" value={String(device.variableCount ?? 0)} />
                <Stat label="Messages" value={formatCount(device.messageCount)} />
                <Stat label="Datapoints" value={formatCount(device.pointCount)} />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-4 text-xs text-slate-500">
                <Badge tone="slate">every {device.intervalS}s</Badge>
                {device.lastTransport && (
                  <Badge tone="cyan">
                    <Radio size={11} /> {device.lastTransport.toUpperCase()}
                  </Badge>
                )}
                <span className="ml-auto">{relativeTime(device.lastSeenAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        title="New device"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createDevice.mutate()}
              loading={createDevice.isPending}
              disabled={form.name.trim().length === 0}
            >
              Create device
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Greenhouse sensor #1" autoFocus />
          </Field>
          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Optional"
            />
          </Field>
          <Field label="Reporting interval (seconds)" hint={`Minimum allowed on your plan: ${plan?.minIntervalS ?? 3}s. 10s is a good default — it cuts storage by 3x versus 3s.`}>
            <Input
              type="number"
              min={plan?.minIntervalS ?? 3}
              max={86400}
              value={form.intervalS}
              onChange={(e) => setForm({ ...form, intervalS: Number(e.target.value) })}
            />
          </Field>
          {error && <Alert>{error}</Alert>}
        </div>
      </Modal>

      <Modal
        open={issuedToken !== null}
        title="Device credentials"
        onClose={() => setIssuedToken(null)}
        footer={<Button onClick={() => setIssuedToken(null)}>Done</Button>}
      >
        <div className="space-y-4">
          <Alert tone="amber">
            This token is shown once and stored only as a hash. Copy it into your firmware now — if you lose it,
            rotate the token from the device page.
          </Alert>
          <CopyField label="Device key (MQTT username)" value={issuedToken?.device.deviceKey ?? ''} />
          <CopyField label="Device token (MQTT password)" value={issuedToken?.token ?? ''} />
        </div>
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] py-2">
      <p className="font-mono text-sm text-slate-200">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
    </div>
  );
}
