import { View, Text } from 'react-native';
import Svg, { Path, Line } from 'react-native-svg';
import type { SeriesPoint } from '../api';
import { c } from '../theme';

/**
 * A small line chart.
 *
 * Hand-drawn rather than pulled from a charting library: the whole requirement
 * is one polyline in a fixed box, and every RN chart package brings either a
 * native module that has to survive an EAS build or a webview.
 *
 * Nulls break the line instead of interpolating across them. A gap in telemetry
 * is information — a device was offline — and joining the ends draws a
 * measurement that never happened.
 */
export function Chart({
  points,
  height = 120,
  width,
  colour = c.accent,
}: {
  points: SeriesPoint[];
  height?: number;
  width: number;
  colour?: string;
}) {
  const usable = points.filter((p) => p.v !== null && Number.isFinite(p.v));
  if (usable.length < 2) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: c.textFaint, fontSize: 12 }}>
          {points.length === 0 ? 'No data yet' : 'Not enough data to plot'}
        </Text>
      </View>
    );
  }

  const pad = 6;
  const xs = usable.map((p) => p.t);
  const ys = usable.map((p) => p.v as number);
  const tMin = Math.min(...xs);
  const tMax = Math.max(...xs);
  let vMin = Math.min(...ys);
  let vMax = Math.max(...ys);
  // A flat line has zero range, which would divide by zero and collapse the
  // plot onto one edge. Give it a band so it draws through the middle.
  if (vMax - vMin < 1e-9) {
    const centre = vMax;
    vMin = centre - 1;
    vMax = centre + 1;
  }

  const w = Math.max(1, width - pad * 2);
  const h = Math.max(1, height - pad * 2);
  const px = (t: number) => pad + ((t - tMin) / Math.max(1, tMax - tMin)) * w;
  const py = (v: number) => pad + h - ((v - vMin) / (vMax - vMin)) * h;

  // Walk the ORIGINAL points so a null starts a new subpath.
  let d = '';
  let penDown = false;
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) {
      penDown = false;
      continue;
    }
    const cmd = penDown ? 'L' : 'M';
    d += `${cmd}${px(p.t).toFixed(1)},${py(p.v).toFixed(1)} `;
    penDown = true;
  }

  return (
    <Svg width={width} height={height}>
      <Line x1={pad} y1={pad + h / 2} x2={pad + w} y2={pad + h / 2} stroke={c.border} strokeWidth={1} />
      <Path d={d.trim()} stroke={colour} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}
