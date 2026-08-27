import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, type MonthlyUsage, type Plan } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatCount, relativeTime } from '../lib/format';
import { Alert, Button, Card, CopyField, Field, Input, Modal, SectionTitle, Spinner } from '../components/ui';

interface UsageResponse {
  plan: Plan;
  usage: {
    devices: number;
    devicesOnline: number;
    variables: number;
    dashboards: number;
    messages: number;
    points: number;
  };
  month: MonthlyUsage;
}

interface ApiKey {
  id: string;
  name: string;
  keyPreview: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export function AccountPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [creatingKey, setCreatingKey] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const usageQuery = useQuery({ queryKey: ['usage'], queryFn: () => api.get<UsageResponse>('/account/usage') });
  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ plans: Plan[] }>('/plans') });
  const keysQuery = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<{ apiKeys: ApiKey[] }>('/account/api-keys') });

  const createKey = useMutation({
    mutationFn: () => api.post<{ key: string }>('/account/api-keys', { name: keyName }),
    onSuccess: (result) => {
      setIssuedKey(result.key);
      setCreatingKey(false);
      setKeyName('');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const deleteKey = useMutation({
    mutationFn: (id: string) => api.delete(`/account/api-keys/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  if (usageQuery.isLoading) return <Spinner />;
  const usage = usageQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Account</h1>
        <p className="mt-1 text-sm text-slate-400">
          {user?.name} · {user?.email}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Devices" value={`${usage?.usage.devices ?? 0} / ${usage?.plan.maxDevices ?? '—'}`} />
        <Metric label="Online now" value={String(usage?.usage.devicesOnline ?? 0)} />
        <Metric
          label="Variables"
          value={`${usage?.usage.variables ?? 0} / ${usage?.plan.maxVariablesTotal ?? '—'}`}
        />
        <Metric
          label="Dashboards"
          value={`${usage?.usage.dashboards ?? 0} / ${usage?.plan.maxDashboards ?? '—'}`}
        />
      </div>

      {usage?.month && <MonthlyMeter month={usage.month} />}

      <Card>
        <SectionTitle
          title="Plan"
          subtitle={`You are on ${usage?.plan.name}. Retention is ${usage?.plan.retentionDays} days and the minimum reporting interval is ${usage?.plan.minIntervalS}s.`}
        />
        <div className="grid gap-4 md:grid-cols-3">
          {(plansQuery.data?.plans ?? []).map((plan) => {
            const current = plan.id === usage?.plan.id;
            return (
              <div
                key={plan.id}
                className={clsx(
                  'rounded-xl border p-4 transition',
                  current ? 'border-cyan-400/40 bg-cyan-500/5' : 'border-white/10 bg-white/[0.02]',
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-white">{plan.name}</p>
                  {current && (
                    <span className="chip border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                      <Check size={12} /> Current
                    </span>
                  )}
                </div>
                <p className="mt-2 font-mono text-lg text-slate-200">
                  {plan.priceCents === 0 ? 'Free' : `$${(plan.priceCents / 100).toFixed(0)}`}
                  {plan.priceCents > 0 && <span className="text-xs text-slate-500"> /mo</span>}
                </p>
                <ul className="mt-3 space-y-1.5 text-xs text-slate-400">
                  <li>{plan.maxDevices} devices</li>
                  <li>{plan.maxVariablesPerDevice} variables per device</li>
                  <li>{formatCount(plan.monthlyDatapoints)} datapoints per month</li>
                  <li>{plan.retentionDays} days of history</li>
                  <li>{plan.minIntervalS}s minimum interval</li>
                  <li>{plan.maxDashboards} dashboards</li>
                </ul>
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Billing is not enabled yet — every account runs on the free plan until payments go live. The limits above are already
          enforced end to end, so switching a user to a paid tier is a single field change.
        </p>
      </Card>

      <Card>
        <SectionTitle
          title="API keys"
          subtitle="Read-only access for third-party integrations. Send the key in the X-API-Key header."
          action={
            <Button variant="ghost" onClick={() => setCreatingKey(true)}>
              <Plus size={15} /> New key
            </Button>
          }
        />

        <pre className="mb-5 overflow-x-auto rounded-lg border border-white/10 bg-ink-950/70 p-3 font-mono text-xs text-cyan-200">
{`curl -H "X-API-Key: pk_your_key" \\
  ${window.location.origin}/api/v1/devices`}
        </pre>
        <p className="mb-5 text-xs text-slate-500">
          Works on any <code className="text-slate-400">GET</code> endpoint — devices, variables, current state,
          history and CSV export. Writes (creating devices, sending commands) always require a signed-in session, so
          a leaked key cannot alter your fleet.
        </p>
        {keysQuery.data?.apiKeys.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No API keys yet.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {(keysQuery.data?.apiKeys ?? []).map((key) => (
              <div key={key.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-200">{key.name}</p>
                  <code className="font-mono text-xs text-slate-500">{key.keyPreview}</code>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="hidden sm:inline">used {relativeTime(key.lastUsedAt)}</span>
                  <button
                    onClick={() => deleteKey.mutate(key.id)}
                    className="rounded-md p-1.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"
                    title="Revoke key"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle title="Security" subtitle="Changing your password signs out every other session." />
        <Button variant="ghost" onClick={() => setPasswordOpen(true)}>
          <KeyRound size={15} /> Change password
        </Button>
      </Card>

      <Modal
        open={creatingKey}
        title="New API key"
        onClose={() => setCreatingKey(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreatingKey(false)}>
              Cancel
            </Button>
            <Button onClick={() => createKey.mutate()} loading={createKey.isPending} disabled={!keyName.trim()}>
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Grafana" autoFocus />
        </Field>
      </Modal>

      <Modal
        open={issuedKey !== null}
        title="API key created"
        onClose={() => setIssuedKey(null)}
        footer={<Button onClick={() => setIssuedKey(null)}>Done</Button>}
      >
        <div className="space-y-4">
          <Alert tone="amber">Copy it now — only a hash is stored.</Alert>
          <CopyField value={issuedKey ?? ''} />
        </div>
      </Modal>

      <PasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}

/**
 * The month's data allowance.
 *
 * The bar exists so nobody meets the limit as a surprise: the warning at 80% is
 * recorded server-side, but a number on the page is what actually gets noticed.
 */
function MonthlyMeter({ month }: { month: MonthlyUsage }) {
  const percent = Math.round(month.fraction * 100);
  const tone = month.blocked ? 'bg-rose-500' : month.warned ? 'bg-amber-400' : 'bg-cyan-400';

  return (
    <Card>
      <SectionTitle
        title="Data this month"
        subtitle="Resets on the first of each month. Stored history is never affected."
      />

      <div className="flex items-baseline justify-between text-sm">
        <span className="font-mono text-2xl font-semibold text-white">
          {formatCount(month.datapoints)}
        </span>
        <span className="text-slate-400">of {formatCount(month.limit)} datapoints</span>
      </div>

      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={clsx('h-full rounded-full transition-all duration-500', tone)}
          style={{ width: `${Math.max(percent, month.datapoints > 0 ? 2 : 0)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500">{percent}% used</p>

      {month.blocked ? (
        <div className="mt-4">
          <Alert>
            You have reached this month's data limit, so new readings are not being stored until the
            first of next month. Everything already stored is still here, and the panel keeps working
            normally. Upgrading raises the limit immediately.
          </Alert>
        </div>
      ) : month.warned ? (
        <div className="mt-4">
          <Alert tone="amber">
            You have used more than 80% of this month's data. At 100% new readings stop being stored
            until the month resets — nothing already stored is lost.
          </Alert>
        </div>
      ) : null}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="py-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1.5 font-mono text-2xl font-semibold text-white">{value}</p>
    </Card>
  );
}

function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => api.post('/auth/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNext('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not change the password'),
  });

  return (
    <Modal
      open={open}
      title="Change password"
      onClose={() => {
        setError(null);
        setDone(false);
        onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => change.mutate()} loading={change.isPending} disabled={!current || next.length < 8}>
            Update
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        {error && <Alert>{error}</Alert>}
        {done && <Alert tone="cyan">Password updated.</Alert>}
      </div>
    </Modal>
  );
}
