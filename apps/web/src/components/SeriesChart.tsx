import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SeriesResponse } from '../lib/api';
import { formatClock, formatFullClock } from '../lib/format';

type Series = SeriesResponse['series'][number];

/**
 * Every series in a response shares the same bucket width, so merging on the
 * timestamp is exact rather than an interpolation — no resampling needed here.
 */
function mergeSeries(series: Series[]): Array<Record<string, number | null>> {
  const byTime = new Map<number, Record<string, number | null>>();
  for (const entry of series) {
    for (const point of entry.points) {
      const row = byTime.get(point.t) ?? { t: point.t };
      row[entry.variable.id] = point.v;
      byTime.set(point.t, row);
    }
  }
  return [...byTime.values()].sort((a, b) => (a.t as number) - (b.t as number));
}

export function SeriesChart({
  series,
  from,
  to,
  timeZone,
  height = 320,
}: {
  series: Series[];
  from: number;
  to: number;
  /** The device's configured zone. Undefined renders in the viewer's own zone. */
  timeZone?: string;
  height?: number;
}) {
  const numeric = useMemo(() => series.filter((s) => s.variable.type !== 'string'), [series]);
  const data = useMemo(() => mergeSeries(numeric), [numeric]);
  const span = to - from;

  if (numeric.length === 0) {
    return (
      <div className="grid h-64 place-items-center text-sm text-slate-500">
        Select at least one numeric variable to plot.
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="grid h-64 place-items-center text-sm text-slate-500">
        No data in this range yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={[from, to]}
          scale="time"
          tickFormatter={(t: number) => formatClock(t, span, timeZone)}
          stroke="#475569"
          tick={{ fill: '#64748b', fontSize: 11 }}
          minTickGap={48}
        />
        <YAxis
          stroke="#475569"
          tick={{ fill: '#64748b', fontSize: 11 }}
          width={56}
          tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v * 100) / 100))}
        />
        <Tooltip
          contentStyle={{
            background: 'rgba(2, 6, 23, 0.95)',
            border: '1px solid rgba(148, 163, 184, 0.2)',
            borderRadius: 12,
            fontSize: 12,
          }}
          labelFormatter={(t) => formatFullClock(Number(t), timeZone)}
          formatter={(value: number, name: string) => {
            const variable = numeric.find((s) => s.variable.id === name)?.variable;
            const rendered = variable?.type === 'bool' ? (value >= 0.5 ? 'ON' : 'OFF') : value;
            return [`${rendered}${variable?.unit ? ` ${variable.unit}` : ''}`, variable?.label ?? name];
          }}
        />
        {numeric.map((entry) => (
          <Line
            key={entry.variable.id}
            type="monotone"
            dataKey={entry.variable.id}
            stroke={entry.variable.color}
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
