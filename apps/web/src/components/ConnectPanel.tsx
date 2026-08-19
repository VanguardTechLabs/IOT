import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ConnectionInfo } from '../lib/api';
import { CopyField, Spinner } from './ui';

const TABS = ['MQTT', 'HTTP', 'WebSocket'] as const;

export function ConnectPanel({ deviceId }: { deviceId: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('MQTT');
  const { data, isLoading } = useQuery({
    queryKey: ['connection', deviceId],
    queryFn: () => api.get<ConnectionInfo>(`/devices/${deviceId}/connection`),
  });

  if (isLoading || !data) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex gap-1 rounded-lg bg-white/5 p-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab === t ? 'bg-cyan-500 text-ink-950' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'MQTT' && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <CopyField label="Host" value={data.mqtt.host} />
            <CopyField label="Port (TCP / WS)" value={`${data.mqtt.port} / ${data.mqtt.wsPort}`} />
          </div>
          <CopyField label="Username" value={data.mqtt.username} />
          <CopyField label="Password" value="the device token (rotate it below if lost)" />
          <CopyField label="Publish telemetry to" value={data.mqtt.publishTopic} />
          <CopyField label="Subscribe for commands" value={data.mqtt.subscribeTopic} />
          <CopyField label="Last will / status" value={`${data.mqtt.statusTopic} → "online" / "offline" (retained)`} />
        </div>
      )}

      {tab === 'HTTP' && (
        <div className="space-y-3">
          <CopyField label="Endpoint" value={`POST ${data.http.url}`} />
          <CopyField label="Headers" value={`X-Device-Key: ${data.http.headers['X-Device-Key']}\nX-Device-Token: <device token>`} />
          <p className="text-xs text-slate-500">
            Best for devices that report rarely or sit behind restrictive firewalls. One request per cycle carrying
            every variable — never one request per variable.
          </p>
        </div>
      )}

      {tab === 'WebSocket' && (
        <div className="space-y-3">
          <CopyField label="Endpoint" value={data.websocket.url} />
          <p className="text-xs text-slate-500">
            Keeps a single connection open for both telemetry and commands. Send the same JSON frame as MQTT; the
            server replies with an ack containing accepted and rejected keys.
          </p>
        </div>
      )}

      <div>
        <p className="label">Payload — always one message per cycle</p>
        <pre className="overflow-x-auto rounded-lg border border-white/10 bg-ink-950/70 p-3 font-mono text-xs text-cyan-200">
{JSON.stringify(data.payloadExample, null, 2)}
        </pre>
        <p className="mt-2 text-xs text-slate-500">
          Values travel as strings; the platform casts each one using the type you declared for that variable.
          Batching all nine variables into one message is what keeps 100 devices at ~33 msg/s instead of 300.
        </p>
      </div>
    </div>
  );
}
