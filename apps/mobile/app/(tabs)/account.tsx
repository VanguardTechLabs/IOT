import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, API_URL, type UsageResponse } from '../../src/api';
import { Button, Card, Loading, Note } from '../../src/components/ui';
import { useSession } from '../../src/session';
import { c, radius, space } from '../../src/theme';

export default function Account() {
  const { user, signOut } = useSession();
  const query = useQuery({
    queryKey: ['usage'],
    queryFn: () => api.get<UsageResponse>('/account/usage'),
  });

  if (query.isLoading) return <Loading />;

  const data = query.data;
  const month = data?.month;
  const plan = data?.plan;

  return (
    <ScrollView
      contentContainerStyle={s.page}
      refreshControl={
        <RefreshControl refreshing={query.isFetching} onRefresh={() => void query.refetch()} tintColor={c.accent} />
      }
    >
      <Card>
        <Text style={s.name}>{user?.name}</Text>
        <Text style={s.dim}>{user?.email}</Text>
        {plan ? (
          <View style={s.planPill}>
            <Text style={s.planPillText}>{plan.name} plan</Text>
          </View>
        ) : null}
      </Card>

      {month ? (
        <Card>
          <Text style={s.section}>Data this month</Text>
          <Meter fraction={month.fraction} blocked={month.blocked} />
          <Text style={s.dim}>
            {month.datapoints.toLocaleString()} of {month.limit.toLocaleString()} datapoints
          </Text>
          {month.blocked ? (
            <Note>
              You have reached this month&apos;s limit. Your saved data and this app keep working — new
              readings resume next month, or as soon as you move to a larger plan.
            </Note>
          ) : month.warned ? (
            <Note tone="warn">
              You have used more than 80% of this month&apos;s data. At 100% new readings pause until next
              month.
            </Note>
          ) : null}
        </Card>
      ) : null}

      {data ? (
        <Card>
          <Text style={s.section}>Usage</Text>
          <Row label="Devices" value={`${data.usage.devices} of ${data.plan.maxDevices}`} />
          <Row label="Online now" value={String(data.usage.devicesOnline)} />
          <Row label="Variables" value={`${data.usage.variables} of ${data.plan.maxVariablesTotal}`} />
          <Row label="Dashboards" value={`${data.usage.dashboards} of ${data.plan.maxDashboards}`} />
          <Row label="History kept" value={`${data.plan.retentionDays} days`} />
          <Row label="Fastest interval" value={`${data.plan.minIntervalS}s`} />
        </Card>
      ) : null}

      <Card>
        <Text style={s.section}>Plan changes</Text>
        <Text style={s.dim}>
          Upgrades and payment are handled on the web panel, where PayPal&apos;s checkout runs.
        </Text>
        <Text style={s.server}>{API_URL.replace(/^https?:\/\//, '')}</Text>
      </Card>

      <Button label="Sign out" tone="danger" onPress={() => void signOut()} />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.dim}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

/** Cyan, amber past 80%, red at the ceiling — the same language as the panel. */
function Meter({ fraction, blocked }: { fraction: number; blocked: boolean }) {
  const pct = Math.min(100, Math.max(0, fraction * 100));
  const colour = blocked || pct >= 100 ? c.bad : pct >= 80 ? c.warn : c.accent;
  return (
    <View style={s.meterTrack}>
      <View style={[s.meterFill, { width: `${pct}%`, backgroundColor: colour }]} />
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: space.lg, gap: space.md },
  name: { color: c.text, fontSize: 18, fontWeight: '700' },
  dim: { color: c.textDim, fontSize: 13 },
  section: { color: c.text, fontSize: 15, fontWeight: '600' },
  planPill: {
    alignSelf: 'flex-start',
    backgroundColor: c.accentDim + '44',
    borderColor: c.accent + '55',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    marginTop: space.xs,
  },
  planPillText: { color: c.accent, fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowValue: { color: c.text, fontSize: 13, fontWeight: '600' },
  meterTrack: {
    height: 10,
    backgroundColor: c.surfaceAlt,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
  },
  meterFill: { height: '100%' },
  server: { color: c.textFaint, fontSize: 11 },
});
