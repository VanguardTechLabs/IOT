import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { SeriesPoint, VariableState, Widget as WidgetModel } from '../api';
import { c, radius, space } from '../theme';
import { Chart } from './Chart';

/**
 * The ten widget types, as they appear on a phone.
 *
 * The panel lays these out on a 12-column grid the user drags around. A phone is
 * too narrow for that to survive translation, so position is honoured only as
 * ORDER — sorted by row, then column — and each widget picks a full or half
 * width from its desktop width. The result reads like the dashboard the user
 * built without pretending a 360 px screen is a 12-column canvas.
 */

export interface WidgetProps {
  widget: WidgetModel;
  state: VariableState | undefined;
  points: SeriesPoint[];
  width: number;
  onWrite: (key: string, value: string) => void;
  writing: boolean;
}

function num(state: VariableState | undefined): number | null {
  if (!state) return null;
  if (state.valueNum !== null) return state.valueNum;
  if (state.valueText !== null && state.valueText !== '') {
    const parsed = Number(state.valueText);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isOn(state: VariableState | undefined, onValue = '1'): boolean {
  if (!state) return false;
  if (state.valueNum !== null) return state.valueNum !== 0;
  return state.valueText === onValue || state.valueText === 'true' || state.valueText === 'on';
}

function fmt(value: number | null, decimals = 1): string {
  if (value === null) return '—';
  return value.toFixed(decimals);
}

/** Where a value sits between min and max, clamped to 0–1. */
function fraction(value: number | null, min: number, max: number): number {
  if (value === null || max - min === 0) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Perceived brightness of a hex colour, 0-1.
 *
 * Rec. 601 luma, matching the web exactly so the same background does not read
 * as light on one and dark on the other. Green looks far brighter than blue at
 * the same value, which a plain channel average gets wrong.
 */
function luminance(hex?: string): number {
  if (!hex) return 0;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  let h = m[1]!;
  if (h.length === 3)
    h = h
      .split('')
      .map((ch) => ch + ch)
      .join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function Widget(props: WidgetProps) {
  const { widget, state } = props;
  const cfg = widget.config ?? {};
  const title = cfg.label ?? state?.label ?? state?.key ?? widget.type;
  const unit = cfg.unit ?? state?.unit ?? '';

  // A pale background chosen on the web would otherwise leave this card's
  // light-on-dark text unreadable on the phone.
  const bg = cfg.background;
  const light = luminance(bg) > 0.6;
  const titleColour = light ? '#475569' : c.textDim;
  const stampColour = light ? '#64748b' : c.textFaint;

  return (
    <View style={[s.card, { width: props.width }, bg ? { backgroundColor: bg } : null]}>
      <Text style={[s.title, { color: titleColour }]} numberOfLines={1}>
        {title}
      </Text>
      <Body {...props} unit={unit} light={light} />
      {state?.ts ? (
        <Text style={[s.stamp, { color: stampColour }]}>
          {new Date(state.ts).toLocaleTimeString()}
        </Text>
      ) : widget.type !== 'text' ? (
        <Text style={[s.stamp, { color: stampColour }]}>never reported</Text>
      ) : null}
    </View>
  );
}

function Body({
  widget,
  state,
  points,
  width,
  onWrite,
  writing,
  unit,
  light,
}: WidgetProps & { unit: string; light: boolean }) {
  const cfg = widget.config ?? {};
  const min = cfg.min ?? 0;
  const max = cfg.max ?? 100;
  const decimals = cfg.decimals ?? 1;
  const colour = cfg.color ?? c.accent;
  const value = num(state);
  // React Native does not cascade colour from a View, so every Text that
  // carries a reading has to be told explicitly.
  const text = light ? '#0f172a' : c.text;
  const dim = light ? '#475569' : c.textDim;

  switch (widget.type) {
    case 'number':
      return (
        <View style={s.centre}>
          <Text style={[s.big, { color: text }]}>
            {fmt(value, decimals)}
            {unit ? <Text style={[s.unit, { color: dim }]}> {unit}</Text> : null}
          </Text>
        </View>
      );

    case 'text':
      return (
        <View style={s.centre}>
          <Text style={[s.bodyText, { color: text }]}>{cfg.body ?? state?.valueText ?? ''}</Text>
        </View>
      );

    case 'led': {
      const on = isOn(state, cfg.onValue ?? '1');
      const lit = cfg.onColor ?? c.good;
      const dark = cfg.offColor ?? c.textFaint;
      return (
        <View style={s.centre}>
          <Svg width={64} height={64}>
            {on ? <Circle cx={32} cy={32} r={30} fill={lit} opacity={0.18} /> : null}
            <Circle cx={32} cy={32} r={18} fill={on ? lit : dark} opacity={on ? 1 : 0.35} />
            <Circle cx={32} cy={32} r={18} stroke={on ? lit : c.border} strokeWidth={2} fill="none" />
          </Svg>
          <Text style={[s.stateLabel, { color: on ? lit : c.textFaint }]}>{on ? 'ON' : 'OFF'}</Text>
        </View>
      );
    }

    case 'gauge': {
      const f = fraction(value, min, max);
      const size = Math.min(width - space.lg * 2, 150);
      const r = size / 2 - 10;
      const cx = size / 2;
      const cy = size / 2;
      // A 240° sweep starting at 150°, which leaves the gap at the bottom where
      // the reading goes.
      const start = 150;
      const sweep = 240;
      const arc = (fromDeg: number, toDeg: number) => {
        const p = (deg: number) => {
          const rad = (deg * Math.PI) / 180;
          return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
        };
        const [x1, y1] = p(fromDeg);
        const [x2, y2] = p(toDeg);
        const large = toDeg - fromDeg > 180 ? 1 : 0;
        return `M${x1?.toFixed(1)},${y1?.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2?.toFixed(1)},${y2?.toFixed(1)}`;
      };
      return (
        <View style={s.centre}>
          <Svg width={size} height={size * 0.78}>
            <Path d={arc(start, start + sweep)} stroke={c.border} strokeWidth={10} fill="none" strokeLinecap="round" />
            {f > 0 ? (
              <Path
                d={arc(start, start + sweep * f)}
                stroke={colour}
                strokeWidth={10}
                fill="none"
                strokeLinecap="round"
              />
            ) : null}
          </Svg>
          <Text style={[s.big, { color: text, marginTop: -size * 0.3 }]}>
            {fmt(value, decimals)}
            {unit ? <Text style={[s.unit, { color: dim }]}> {unit}</Text> : null}
          </Text>
        </View>
      );
    }

    case 'tank':
    case 'thermometer': {
      const f = fraction(value, min, max);
      const tall = widget.type === 'thermometer';
      const h = 120;
      const w = tall ? 34 : 64;
      return (
        <View style={s.centre}>
          <Svg width={w} height={h}>
            <Rect x={1} y={1} width={w - 2} height={h - 2} rx={tall ? w / 2 : 6} stroke={c.border} strokeWidth={2} fill={c.surfaceAlt} />
            <Rect
              x={3}
              y={3 + (h - 6) * (1 - f)}
              width={w - 6}
              height={Math.max(0, (h - 6) * f)}
              rx={tall ? (w - 6) / 2 : 4}
              fill={colour}
              opacity={0.85}
            />
          </Svg>
          <Text style={[s.mid, { color: text }]}>
            {fmt(value, decimals)}
            {unit ? <Text style={[s.unit, { color: dim }]}> {unit}</Text> : null}
          </Text>
        </View>
      );
    }

    case 'chart':
      return <Chart points={points} width={width - space.lg * 2} colour={colour} />;

    case 'toggle':
      return (
        <Toggle
          on={isOn(state, cfg.onValue ?? '1')}
          disabled={!state?.writable || writing}
          onToggle={(next) =>
            onWrite(state?.key ?? '', next ? (cfg.onValue ?? '1') : (cfg.offValue ?? '0'))
          }
        />
      );

    case 'button':
      return (
        <MomentaryButton
          label={cfg.label ?? 'Send'}
          disabled={!state?.writable || writing}
          onValue={cfg.onValue ?? '1'}
          offValue={cfg.offValue ?? '0'}
          pulseMs={cfg.pulseMs ?? 500}
          onWrite={(v) => onWrite(state?.key ?? '', v)}
        />
      );

    case 'slider':
      return (
        <SliderControl
          value={value ?? min}
          min={min}
          max={max}
          step={cfg.step ?? 1}
          unit={unit}
          decimals={decimals}
          light={light}
          colour={colour}
          disabled={!state?.writable || writing}
          onCommit={(v) => onWrite(state?.key ?? '', String(v))}
        />
      );

    default:
      return <Text style={s.stamp}>Unsupported widget: {widget.type}</Text>;
  }
}

/**
 * Optimistic toggle.
 *
 * The switch moves immediately and the real state arrives over the socket a
 * moment later. If nothing arrives within a few seconds the optimistic value is
 * dropped, so a switch that did not actually reach the device springs back
 * rather than lying about it.
 */
function Toggle({ on, disabled, onToggle }: { on: boolean; disabled: boolean; onToggle: (next: boolean) => void }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pending !== null && pending === on) {
      setPending(null);
      if (timer.current) clearTimeout(timer.current);
    }
  }, [on, pending]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const shown = pending ?? on;

  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        const next = !shown;
        setPending(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setPending(null), 6000);
        onToggle(next);
      }}
      style={s.centre}
    >
      <View style={[s.track, shown && { backgroundColor: c.accentDim, borderColor: c.accent }, disabled && s.dim]}>
        <View style={[s.knob, shown && { alignSelf: 'flex-end', backgroundColor: c.accent }]} />
      </View>
      <Text style={[s.stateLabel, { color: shown ? c.accent : c.textFaint }]}>{shown ? 'ON' : 'OFF'}</Text>
      {pending !== null ? <Text style={s.stamp}>sending…</Text> : null}
    </Pressable>
  );
}

/**
 * Momentary push button: sends ON, then OFF after `pulseMs`.
 *
 * This is the shape a physical button has, which is what the client asked for —
 * press sends 1, release returns to 0 — rather than a second toggle.
 */
function MomentaryButton({
  label,
  disabled,
  onValue,
  offValue,
  pulseMs,
  onWrite,
}: {
  label: string;
  disabled: boolean;
  onValue: string;
  offValue: string;
  pulseMs: number;
  onWrite: (value: string) => void;
}) {
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        setHeld(true);
        onWrite(onValue);
        if (timer.current) clearTimeout(timer.current);
        if (pulseMs > 0) {
          timer.current = setTimeout(() => {
            setHeld(false);
            onWrite(offValue);
          }, pulseMs);
        } else {
          setHeld(false);
        }
      }}
      style={({ pressed }) => [s.push, (held || pressed) && s.pushOn, disabled && s.dim]}
    >
      <Text style={[s.pushText, held && { color: c.bg }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Slider that writes on release, not while dragging.
 *
 * Every intermediate position would otherwise become a command; dragging from 0
 * to 100 would send a hundred of them, blow through the burst limit and burn a
 * chunk of the account's monthly allowance on values nobody chose.
 */
function SliderControl({
  value,
  min,
  max,
  step,
  unit,
  decimals,
  colour,
  light,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  decimals: number;
  colour: string;
  light: boolean;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;

  return (
    <View style={{ gap: space.xs }}>
      <Text style={[s.mid, { textAlign: 'center', color: light ? '#0f172a' : c.text }]}>
        {fmt(shown, decimals)}
        {unit ? <Text style={[s.unit, { color: light ? '#475569' : c.textDim }]}> {unit}</Text> : null}
      </Text>
      <Slider
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={value}
        disabled={disabled}
        minimumTrackTintColor={colour}
        maximumTrackTintColor={c.border}
        thumbTintColor={colour}
        onValueChange={setDragging}
        onSlidingComplete={(v) => {
          setDragging(null);
          onCommit(v);
        }}
      />
      <View style={s.row}>
        <Text style={s.stamp}>{min}</Text>
        <Text style={s.stamp}>{max}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
    minHeight: 130,
    justifyContent: 'space-between',
  },
  title: { color: c.textDim, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  centre: { alignItems: 'center', justifyContent: 'center', gap: space.xs },
  big: { color: c.text, fontSize: 30, fontWeight: '700' },
  mid: { color: c.text, fontSize: 20, fontWeight: '600' },
  unit: { color: c.textDim, fontSize: 13, fontWeight: '400' },
  bodyText: { color: c.text, fontSize: 14, lineHeight: 20 },
  stamp: { color: c.textFaint, fontSize: 11 },
  stateLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  track: {
    width: 68,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
    padding: 3,
    justifyContent: 'center',
  },
  knob: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.textFaint },
  push: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.accent,
    paddingVertical: space.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  pushOn: { backgroundColor: c.accent },
  pushText: { color: c.accent, fontWeight: '700', fontSize: 15 },
  dim: { opacity: 0.4 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
});
