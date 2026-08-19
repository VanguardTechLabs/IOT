import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Pencil, Send } from 'lucide-react';
import type { StateEntry } from '../lib/api';
import { formatValue, relativeTime } from '../lib/format';

export function VariableTile({
  entry,
  selected,
  onToggle,
  onEdit,
  onCommand,
}: {
  entry: StateEntry;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onCommand: (value: string) => void;
}) {
  const [flash, setFlash] = useState(false);
  const previous = useRef<string | null>(null);
  const rendered = formatValue(entry.type, entry.valueNum, entry.valueText);

  // Flash the number when a fresh sample lands so the dashboard feels alive.
  useEffect(() => {
    const changed = previous.current !== null && previous.current !== rendered;
    previous.current = rendered;
    if (!changed) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(timer);
  }, [rendered]);

  return (
    <div
      className={clsx(
        'card relative flex flex-col p-4 transition',
        selected ? 'border-cyan-400/40 bg-ink-850/80' : 'hover:border-white/10',
      )}
    >
      <button
        onClick={onToggle}
        className="absolute inset-0 rounded-2xl"
        title={selected ? 'Hide from chart' : 'Show on chart'}
        aria-label={selected ? 'Hide from chart' : 'Show on chart'}
      />

      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} />
            <p className="truncate text-sm font-medium text-slate-200">{entry.label}</p>
          </div>
          <code className="mt-0.5 block truncate font-mono text-[11px] text-slate-500">{entry.key}</code>
        </div>
        <button
          onClick={onEdit}
          className="relative z-10 rounded-md p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
          title="Edit variable"
        >
          <Pencil size={13} />
        </button>
      </div>

      <div className="relative mt-4 flex items-baseline gap-1.5">
        <span
          className={clsx(
            'font-mono text-2xl font-semibold tracking-tight',
            entry.valueNum === null && entry.valueText === null ? 'text-slate-600' : 'text-white',
            flash && 'value-flash',
          )}
        >
          {rendered}
        </span>
        {entry.unit && <span className="text-sm text-slate-500">{entry.unit}</span>}
      </div>

      <div className="relative mt-3 flex items-center justify-between text-[11px] text-slate-500">
        <span>{relativeTime(entry.ts)}</span>
        <span className="uppercase tracking-wide">{entry.type}</span>
      </div>

      {entry.writable && (
        <div className="relative z-10 mt-3 border-t border-white/5 pt-3">
          <WriteControl entry={entry} onCommand={onCommand} />
        </div>
      )}
    </div>
  );
}

function WriteControl({ entry, onCommand }: { entry: StateEntry; onCommand: (value: string) => void }) {
  const [draft, setDraft] = useState('');

  if (entry.type === 'bool') {
    const on = (entry.valueNum ?? 0) >= 0.5;
    return (
      <button
        onClick={() => onCommand(on ? '0' : '1')}
        className={clsx(
          'flex w-full items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition',
          on ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25' : 'bg-white/5 text-slate-300 hover:bg-white/10',
        )}
      >
        <Send size={12} /> Turn {on ? 'off' : 'on'}
      </button>
    );
  }

  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) {
          onCommand(draft.trim());
          setDraft('');
        }
      }}
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Send value…"
        className="input px-2 py-1 text-xs"
        type={entry.type === 'string' ? 'text' : 'number'}
        step="any"
      />
      <button type="submit" className="btn-ghost px-2.5 py-1" title="Send to device">
        <Send size={12} />
      </button>
    </form>
  );
}
