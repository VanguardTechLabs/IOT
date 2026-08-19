import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, HardDrive, Radio, Search, ShieldCheck, Trash2, Users } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, type Plan } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatCount, relativeTime } from '../lib/format';
import { Alert, Badge, Button, Card, Input, SectionTitle, Select, Spinner, StatusDot } from '../components/ui';

interface Overview {
  users: { total: number; admins: number; byPlan: Array<{ planId: string; count: number }> };
  devices: { total: number; online: number; disabled: number; messages: number; points: number };
  variables: number;
  storage: { telemetryRows: number; telemetryBytes: number; databaseBytes: number };
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  planId: string;
  createdAt: string;
  deviceCount: number;
  onlineCount: number;
  messageCount: number;
}

interface AdminDevice {
  id: string;
  deviceKey: string;
  name: string;
  online: boolean;
  enabled: boolean;
  intervalS: number;
  lastSeenAt: string | null;
  lastTransport: string | null;
  messageCount: number;
  pointCount: number;
  ownerEmail: string;
  ownerName: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'overview' | 'users' | 'devices'>('overview');

  if (user?.role !== 'admin') {
    return <Alert>This area is restricted to administrators.</Alert>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-white">
            <ShieldCheck size={22} className="text-cyan-400" /> Administration
          </h1>
          <p className="mt-1 text-sm text-slate-400">Platform-wide users, devices and storage.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-white/5 p-1">
          {(['overview', 'users', 'devices'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-sm font-medium capitalize transition',
                tab === t ? 'bg-cyan-500 text-ink-950' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'users' && <UsersTab currentUserId={user.id} />}
      {tab === 'devices' && <DevicesTab />}
    </div>
  );
}

function OverviewTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api.get<Overview>('/admin/overview'),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) return <Spinner />;

  const bytesPerRow = data.storage.telemetryRows > 0 ? data.storage.telemetryBytes / data.storage.telemetryRows : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={<Users size={16} />} label="Accounts" value={String(data.users.total)} hint={`${data.users.admins} admin`} />
        <Tile
          icon={<Radio size={16} />}
          label="Devices"
          value={String(data.devices.total)}
          hint={`${data.devices.online} online · ${data.devices.disabled} disabled`}
        />
        <Tile icon={<Database size={16} />} label="Datapoints" value={formatCount(data.devices.points)} hint={`${formatCount(data.devices.messages)} messages`} />
        <Tile
          icon={<HardDrive size={16} />}
          label="Telemetry on disk"
          value={formatBytes(data.storage.telemetryBytes)}
          hint={`of ${formatBytes(data.storage.databaseBytes)} total`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle title="Accounts by plan" />
          <div className="space-y-2">
            {data.users.byPlan.map((row) => (
              <div key={row.planId} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <span className="text-sm capitalize text-slate-300">{row.planId}</span>
                <span className="font-mono text-sm text-white">{row.count}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle
            title="Storage efficiency"
            subtitle="Compression kicks in on chunks older than two days."
          />
          <dl className="space-y-2 text-sm">
            <Row label="Telemetry rows (approx.)" value={data.storage.telemetryRows.toLocaleString()} />
            <Row label="Bytes per row" value={bytesPerRow ? `${bytesPerRow.toFixed(1)} B` : '—'} />
            <Row label="Variables defined" value={String(data.variables)} />
          </dl>
          <p className="mt-4 text-xs text-slate-500">
            Uncompressed a telemetry row costs roughly 50 B. A figure well below that means the compression policy is
            doing its job; a figure at or above it means most data is still in the recent, uncompressed chunks.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 pb-2">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-mono text-slate-200">{value}</dd>
    </div>
  );
}

function Tile({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <Card className="py-4">
      <div className="flex items-center gap-2 text-slate-500">
        {icon}
        <p className="text-xs uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold text-white">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

function UsersTab({ currentUserId }: { currentUserId: string }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ plans: Plan[] }>('/plans') });
  const usersQuery = useQuery({
    queryKey: ['admin-users', search],
    queryFn: () => api.get<{ users: AdminUser[] }>(`/admin/users?search=${encodeURIComponent(search)}`),
  });

  const update = useMutation({
    mutationFn: (payload: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/admin/users/${payload.id}`, payload.body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Delete failed'),
  });

  return (
    <Card>
      <SectionTitle
        title="Users"
        subtitle="Change a plan to move someone onto paid limits — the ingest workers pick it up immediately."
        action={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search email or name"
              className="w-56 pl-9"
            />
          </div>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {usersQuery.isLoading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">Account</th>
                <th className="pb-2 font-medium">Devices</th>
                <th className="pb-2 font-medium">Messages</th>
                <th className="pb-2 font-medium">Plan</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(usersQuery.data?.users ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="py-3 pr-4">
                    <p className="font-medium text-slate-200">{row.name}</p>
                    <p className="text-xs text-slate-500">{row.email}</p>
                  </td>
                  <td className="py-3 pr-4 font-mono text-slate-300">
                    {row.deviceCount}
                    {row.onlineCount > 0 && <span className="ml-2 text-xs text-emerald-400">{row.onlineCount} up</span>}
                  </td>
                  <td className="py-3 pr-4 font-mono text-slate-400">{formatCount(row.messageCount)}</td>
                  <td className="py-3 pr-4">
                    <Select
                      value={row.planId}
                      onChange={(e) => update.mutate({ id: row.id, body: { planId: e.target.value } })}
                      className="w-32 py-1 text-xs"
                    >
                      {(plansQuery.data?.plans ?? []).map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-3 pr-4">
                    <Select
                      value={row.role}
                      disabled={row.id === currentUserId}
                      onChange={(e) => update.mutate({ id: row.id, body: { role: e.target.value } })}
                      className="w-28 py-1 text-xs"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </td>
                  <td className="py-3 text-right">
                    <button
                      disabled={row.id === currentUserId}
                      onClick={() => {
                        if (confirm(`Delete ${row.email}, their ${row.deviceCount} device(s) and all telemetry?`)) {
                          remove.mutate(row.id);
                        }
                      }}
                      className="rounded-md p-1.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-30 disabled:hover:bg-transparent"
                      title={row.id === currentUserId ? 'You cannot delete your own account here' : 'Delete account'}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function DevicesTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');

  const devicesQuery = useQuery({
    queryKey: ['admin-devices', search],
    queryFn: () => api.get<{ devices: AdminDevice[] }>(`/admin/devices?search=${encodeURIComponent(search)}`),
    refetchInterval: 20_000,
  });

  const toggle = useMutation({
    mutationFn: (payload: { id: string; enabled: boolean }) =>
      api.patch(`/admin/devices/${payload.id}`, { enabled: payload.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-devices'] }),
  });

  return (
    <Card>
      <SectionTitle
        title="All devices"
        subtitle="Disabling revokes broker credentials on the next connect and closes the HTTP and WebSocket paths."
        action={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search device or owner"
              className="w-56 pl-9"
            />
          </div>
        }
      />

      {devicesQuery.isLoading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">Device</th>
                <th className="pb-2 font-medium">Owner</th>
                <th className="pb-2 font-medium">Interval</th>
                <th className="pb-2 font-medium">Traffic</th>
                <th className="pb-2 font-medium">Last seen</th>
                <th className="pb-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(devicesQuery.data?.devices ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <StatusDot online={row.online} />
                      <div>
                        <p className="font-medium text-slate-200">{row.name}</p>
                        <code className="font-mono text-xs text-slate-500">{row.deviceKey}</code>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-xs text-slate-400">{row.ownerEmail}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-slate-400">{row.intervalS}s</td>
                  <td className="py-3 pr-4 font-mono text-xs text-slate-400">
                    {formatCount(row.messageCount)} msg · {formatCount(row.pointCount)} pts
                  </td>
                  <td className="py-3 pr-4 text-xs text-slate-500">
                    {relativeTime(row.lastSeenAt)}
                    {row.lastTransport && <Badge tone="slate">{row.lastTransport.toUpperCase()}</Badge>}
                  </td>
                  <td className="py-3">
                    <Button
                      variant={row.enabled ? 'ghost' : 'danger'}
                      className="px-2.5 py-1 text-xs"
                      onClick={() => toggle.mutate({ id: row.id, enabled: !row.enabled })}
                    >
                      {row.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
