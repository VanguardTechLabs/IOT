import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { StateEntry, Widget } from '../../lib/api';
import { relativeTime } from '../../lib/format';

/**
 * Renders one widget from its stored config plus the live value of its variable.
 *
 * Every widget is driven by the same `StateEntry` the device page already gets
 * over the socket — nothing here polls or fetches. Interactive widgets call back
 * up to the page, which owns the command mutation.
 */

export interface WidgetViewProps {
  widget: Widget;
  entry?: StateEntry;
  /** Fires for toggle / button / slider. Values are strings, like every downlink. */
  onCommand?: (variableId: string, value: string) => void;
  disabled?: boolean;
}

const DEFAULT_COLOR = '#38bdf8';

/** Numeric value of the entry, or null when there is nothing to show yet. */
function numeric(entry?: StateEntry): number | null {
  if (!entry) return null;
  if (entry.valueNum !== null && entry.valueNum !== undefined) return entry.valueNum;
  return null;
}

/** Clamp to 0..1 for the fill-style widgets. */
function fraction(value: number | null, min: number, max: number): number {
  if (value === null || max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

function resolveRange(widget: Widget, entry?: StateEntry): { min: number; max: number } {
  // Widget config wins, then the variable's own min/max (which have existed in the
  // schema since 0001 and were never surfaced anywhere), then a sane default.
  const min = widget.config.min ?? 0;
  const max = widget.config.max ?? 100;
  return { min, max: max > min ? max : min + 1 };
}

function label(widget: Widget, entry?: StateEntry): string {
  return widget.config.label ?? entry?.label ?? entry?.key ?? '—';
}

function unit(widget: Widget, entry?: StateEntry): string {
  return widget.config.unit ?? entry?.unit ?? '';
}

function display(widget: Widget, entry?: StateEntry): string {
  if (!entry) return '—';
  if (entry.type === 'string') return entry.valueText ?? '—';
  const n = numeric(entry);
  if (n === null) return '—';
  if (entry.type === 'bool') return n >= 0.5 ? 'ON' : 'OFF';
  const decimals = widget.config.decimals ?? (entry.type === 'int' ? 0 : 1);
  return n.toFixed(decimals);
}

// ── Shell ───────────────────────────────────────────────────────────────────

/**
 * Perceived brightness of a hex colour, 0–1.
 *
 * Rec. 601 luma: green reads far brighter to the eye than blue at the same
 * value, so a plain channel average would call #0000ff light and #00ff00 dark.
 * Anything unparseable returns 0 and is treated as dark, which is the default.
 */
export function luminance(hex?: string): number {
  if (!hex) return 0;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** True when text on this background needs to be dark rather than light. */
export function isLightBackground(hex?: string): boolean {
  return luminance(hex) > 0.6;
}

export function Frame({
  title,
  background,
  children,
}: {
  title: string;
  background?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 p-3',
        !background && 'bg-slate-900/60',
        isLightBackground(background) && 'widget-light',
      )}
      style={background ? { background } : undefined}
    >
      <div className="drag-handle mb-2 shrink-0 cursor-grab truncate text-xs font-medium uppercase tracking-wide text-slate-400 active:cursor-grabbing">
        {title}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">{children}</div>
    </div>
  );
}

// ── Gauge — a 240° arc ──────────────────────────────────────────────────────

function Gauge({ widget, entry }: WidgetViewProps) {
  const { min, max } = resolveRange(widget, entry);
  const f = fraction(numeric(entry), min, max);
  const color = widget.config.color ?? entry?.color ?? DEFAULT_COLOR;

  // 240° sweep starting at 150°, so the gap sits at the bottom.
  const START = 150;
  const SWEEP = 240;
  const R = 42;
  const arc = (fromDeg: number, toDeg: number) => {
    const p = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      return [50 + R * Math.cos(rad), 50 + R * Math.sin(rad)];
    };
    const [x1, y1] = p(fromDeg);
    const [x2, y2] = p(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`;
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <svg viewBox="0 0 100 78" className="h-full w-full max-h-[140px]">
        <path d={arc(START, START + SWEEP)} fill="none" stroke="#1e293b" strokeWidth="9" strokeLinecap="round" />
        {f > 0 && (
          <path
            d={arc(START, START + SWEEP * f)}
            fill="none"
            stroke={color}
            strokeWidth="9"
            strokeLinecap="round"
          />
        )}
        <text x="50" y="52" textAnchor="middle" className="fill-white" style={{ fontSize: 18, fontWeight: 600 }}>
          {display(widget, entry)}
        </text>
        <text x="50" y="65" textAnchor="middle" className="fill-slate-400" style={{ fontSize: 8 }}>
          {unit(widget, entry)}
        </text>
      </svg>
    </div>
  );
}

// ── Tank — vertical fill ────────────────────────────────────────────────────

function Tank({ widget, entry }: WidgetViewProps) {
  const { min, max } = resolveRange(widget, entry);
  const f = fraction(numeric(entry), min, max);
  const color = widget.config.color ?? entry?.color ?? DEFAULT_COLOR;

  return (
    <div className="flex h-full w-full items-center justify-center gap-3">
      <div className="relative h-full max-h-[160px] w-14 overflow-hidden rounded-lg border-2 border-slate-700 bg-slate-950">
        <div
          className="absolute bottom-0 left-0 right-0 transition-[height] duration-500"
          style={{ height: `${f * 100}%`, backgroundColor: color, opacity: 0.85 }}
        />
      </div>
      <div className="text-left">
        <div className="text-xl font-semibold text-white">{display(widget, entry)}</div>
        <div className="text-xs text-slate-400">{unit(widget, entry)}</div>
        <div className="mt-1 text-[10px] text-slate-500">{Math.round(f * 100)}%</div>
      </div>
    </div>
  );
}

// ── Thermometer ─────────────────────────────────────────────────────────────

function Thermometer({ widget, entry }: WidgetViewProps) {
  const { min, max } = resolveRange(widget, entry);
  const f = fraction(numeric(entry), min, max);
  const color = widget.config.color ?? entry?.color ?? '#f87171';

  return (
    <div className="flex h-full w-full items-center justify-center gap-4">
      <div className="relative flex h-full max-h-[150px] flex-col items-center">
        <div className="relative w-3 flex-1 overflow-hidden rounded-t-full bg-slate-800">
          <div
            className="absolute bottom-0 left-0 right-0 transition-[height] duration-500"
            style={{ height: `${f * 100}%`, backgroundColor: color }}
          />
        </div>
        <div className="-mt-1 h-6 w-6 rounded-full" style={{ backgroundColor: color }} />
      </div>
      <div className="text-left">
        <div className="text-2xl font-semibold text-white">{display(widget, entry)}</div>
        <div className="text-xs text-slate-400">{unit(widget, entry)}</div>
      </div>
    </div>
  );
}

// ── Number ──────────────────────────────────────────────────────────────────

function NumberView({ widget, entry }: WidgetViewProps) {
  const color = widget.config.color ?? entry?.color ?? DEFAULT_COLOR;
  return (
    <div className="text-center">
      <div className="text-4xl font-semibold tracking-tight" style={{ color }}>
        {display(widget, entry)}
      </div>
      {unit(widget, entry) && <div className="mt-1 text-sm text-slate-400">{unit(widget, entry)}</div>}
      {entry?.ts && (
        <div className="mt-2 text-[10px] text-slate-500">{relativeTime(entry.ts)}</div>
      )}
    </div>
  );
}

// ── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({ widget, entry, onCommand, disabled }: WidgetViewProps) {
  const deviceOn = (numeric(entry) ?? 0) >= 0.5;
  const color = widget.config.color ?? entry?.color ?? '#22c55e';

  // The switch used to render purely from the device's reported value, so it did
  // not move until the firmware echoed the change back — and never at all if the
  // device was offline. Flip immediately, then defer to the device once it agrees.
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? deviceOn;

  useEffect(() => {
    if (pending !== null && deviceOn === pending) setPending(null);
  }, [deviceOn, pending]);

  // If the device never confirms, stop pretending rather than lying indefinitely.
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), 6000);
    return () => clearTimeout(timer);
  }, [pending]);

  return (
    <button
      type="button"
      disabled={disabled || !widget.variableId}
      onClick={() => {
        if (!widget.variableId) return;
        const next = !on;
        setPending(next);
        onCommand?.(widget.variableId, next ? (widget.config.onValue ?? '1') : (widget.config.offValue ?? '0'));
      }}
      className="flex flex-col items-center gap-3 disabled:opacity-50"
    >
      <span
        className="relative flex h-9 w-16 items-center rounded-full border border-slate-700 transition-colors"
        style={{ backgroundColor: on ? color : '#1e293b' }}
      >
        <span
          className="absolute h-7 w-7 rounded-full bg-white shadow transition-transform"
          style={{ transform: on ? 'translateX(33px)' : 'translateX(3px)' }}
        />
      </span>
      <span className="text-xs font-medium text-slate-300">
        {on ? 'ON' : 'OFF'}
        {pending !== null && <span className="ml-1 text-slate-500">…</span>}
      </span>
    </button>
  );
}

// ── Button — momentary ──────────────────────────────────────────────────────

function PushButton({ widget, onCommand, disabled }: WidgetViewProps) {
  const color = widget.config.color ?? DEFAULT_COLOR;
  const pulseMs = widget.config.pulseMs ?? 500;
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A momentary button: send the ON value, then return to OFF by itself. Without
  // the second send the variable stays at 1 forever and the next press is a no-op.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const press = () => {
    const variableId = widget.variableId;
    if (!variableId) return;
    onCommand?.(variableId, widget.config.onValue ?? '1');
    if (pulseMs <= 0) return;
    setHeld(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onCommand?.(variableId, widget.config.offValue ?? '0');
      setHeld(false);
    }, pulseMs);
  };

  return (
    <button
      type="button"
      disabled={disabled || !widget.variableId}
      onClick={press}
      className="rounded-lg px-6 py-3 text-sm font-semibold text-slate-950 shadow transition active:scale-95 disabled:opacity-50"
      style={{ backgroundColor: color, opacity: held ? 0.7 : undefined }}
    >
      {widget.config.label ?? 'Send'}
    </button>
  );
}

// ── LED — a read-only lamp ──────────────────────────────────────────────────

function Led({ widget, entry }: WidgetViewProps) {
  const threshold = widget.config.threshold ?? 0.5;
  const on = (numeric(entry) ?? 0) >= threshold;
  const onColor = widget.config.onColor ?? '#22c55e';
  const offColor = widget.config.offColor ?? '#334155';
  const color = on ? onColor : offColor;

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="h-14 w-14 rounded-full border-2 transition-all duration-300"
        style={{
          backgroundColor: color,
          borderColor: on ? color : '#475569',
          // The glow is what makes it read as a lamp rather than a coloured dot.
          boxShadow: on ? `0 0 18px 4px ${color}80` : 'none',
        }}
      />
      <span className="text-xs font-medium text-slate-300">{on ? 'ON' : 'OFF'}</span>
    </div>
  );
}

// ── Slider ──────────────────────────────────────────────────────────────────

function Slider({ widget, entry, onCommand, disabled }: WidgetViewProps) {
  const { min, max } = resolveRange(widget, entry);
  const live = numeric(entry);
  const [local, setLocal] = useState<number>(live ?? min);

  // Follow the device while the user is not dragging.
  useEffect(() => {
    if (live !== null) setLocal(live);
  }, [live]);

  return (
    <div className="w-full px-2">
      <input
        type="range"
        min={min}
        max={max}
        step={widget.config.step ?? 1}
        value={local}
        disabled={disabled || !widget.variableId}
        onChange={(e) => setLocal(Number(e.target.value))}
        // Commit on release, not on every pixel of the drag — otherwise one
        // gesture floods the device with dozens of commands.
        onMouseUp={() => widget.variableId && onCommand?.(widget.variableId, String(local))}
        onTouchEnd={() => widget.variableId && onCommand?.(widget.variableId, String(local))}
        className="w-full accent-cyan-400 disabled:opacity-50"
      />
      <div className="mt-2 flex items-baseline justify-between text-xs text-slate-400">
        <span>{min}</span>
        <span className="text-lg font-semibold text-white">
          {local}
          <span className="ml-1 text-xs text-slate-400">{unit(widget, entry)}</span>
        </span>
        <span>{max}</span>
      </div>
    </div>
  );
}

// ── Text ────────────────────────────────────────────────────────────────────

function TextNote({ widget }: WidgetViewProps) {
  return (
    <p className="w-full whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
      {widget.config.body ?? ''}
    </p>
  );
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export function WidgetView(props: WidgetViewProps) {
  const { widget, entry } = props;
  const title = widget.type === 'text' ? (widget.config.label ?? 'Note') : label(widget, entry);

  const body = (() => {
    switch (widget.type) {
      case 'gauge':
        return <Gauge {...props} />;
      case 'tank':
        return <Tank {...props} />;
      case 'thermometer':
        return <Thermometer {...props} />;
      case 'number':
        return <NumberView {...props} />;
      case 'toggle':
        return <Toggle {...props} />;
      case 'led':
        return <Led {...props} />;
      case 'button':
        return <PushButton {...props} />;
      case 'slider':
        return <Slider {...props} />;
      case 'text':
        return <TextNote {...props} />;
      case 'chart':
        // The chart widget renders through the existing SeriesChart on the page,
        // which already owns the range query and the socket patching.
        return <div className="text-xs text-slate-500">Chart</div>;
      default:
        return <div className="text-xs text-slate-500">Unknown widget</div>;
    }
  })();

  return (
    <Frame title={title} background={widget.config.background}>
      {body}
    </Frame>
  );
}
