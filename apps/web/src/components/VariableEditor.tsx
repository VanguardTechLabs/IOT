import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Variable, type VariableType } from '../lib/api';
import { Alert, Button, Field, Input, Modal, Select } from './ui';

const TYPES: Array<{ value: VariableType; label: string }> = [
  { value: 'float', label: 'Decimal' },
  { value: 'int', label: 'Integer' },
  { value: 'bool', label: 'Boolean' },
  { value: 'string', label: 'Text' },
];

const PALETTE = ['#22d3ee', '#f97316', '#a78bfa', '#34d399', '#facc15', '#f472b6', '#38bdf8', '#94a3b8'];

export interface VariableDraft {
  id?: string;
  key: string;
  label: string;
  type: VariableType;
  unit: string;
  writable: boolean;
  color: string;
  /** Expected range. Gauges, tanks, thermometers and sliders default to these. */
  minValue: number | null;
  maxValue: number | null;
}

export function VariableEditor({
  deviceId,
  variable,
  open,
  onClose,
}: {
  deviceId: string;
  variable: Variable | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<VariableDraft>({
    key: '',
    label: '',
    type: 'float',
    unit: '',
    minValue: null,
    maxValue: null,
    writable: false,
    color: PALETTE[0],
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(
      variable
        ? {
            id: variable.id,
            key: variable.key,
            label: variable.label,
            type: variable.type,
            unit: variable.unit,
            writable: variable.writable,
            color: variable.color,
            minValue: variable.minValue,
            maxValue: variable.maxValue,
          }
        : {
            key: '',
            label: '',
            type: 'float',
            unit: '',
            writable: false,
            color: PALETTE[0],
            minValue: null,
            maxValue: null,
          },
    );
  }, [open, variable]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['device-state', deviceId] });
    void queryClient.invalidateQueries({ queryKey: ['variables', deviceId] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        label: draft.label || draft.key,
        type: draft.type,
        unit: draft.unit,
        writable: draft.writable,
        color: draft.color,
        minValue: draft.minValue,
        maxValue: draft.maxValue,
      };
      if (draft.id) return api.patch(`/variables/${draft.id}`, body);
      return api.post(`/devices/${deviceId}/variables`, { ...body, key: draft.key });
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the variable'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/variables/${draft.id}`),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not delete the variable'),
  });

  return (
    <Modal
      open={open}
      title={variable ? `Edit ${variable.key}` : 'New variable'}
      onClose={onClose}
      footer={
        <>
          {variable && (
            <Button
              variant="danger"
              className="mr-auto"
              loading={remove.isPending}
              onClick={() => {
                if (confirm(`Delete "${variable.key}" and all of its history? This cannot be undone.`)) {
                  remove.mutate();
                }
              }}
            >
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!draft.key.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Key" hint={variable ? 'The key cannot change once data exists.' : 'Exactly what the ESP32 sends.'}>
            <Input
              value={draft.key}
              disabled={Boolean(variable)}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              placeholder="temp"
            />
          </Field>
          <Field label="Display name">
            <Input
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="Temperature"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" hint="The device always sends a string; this is how it gets read.">
            <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as VariableType })}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit">
            <Input value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} placeholder="°C" />
          </Field>
        </div>

        {/* Only meaningful for a numeric reading — a boolean or a string has no range. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Expected minimum"
            hint="Gauges and tanks use this as their scale. Optional."
          >
            <Input
              type="number"
              value={draft.minValue ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, minValue: e.target.value === '' ? null : Number(e.target.value) })
              }
              placeholder="0"
              disabled={draft.type === 'string' || draft.type === 'bool'}
            />
          </Field>
          <Field label="Expected maximum">
            <Input
              type="number"
              value={draft.maxValue ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, maxValue: e.target.value === '' ? null : Number(e.target.value) })
              }
              placeholder="100"
              disabled={draft.type === 'string' || draft.type === 'bool'}
            />
          </Field>
        </div>

        <Field label="Colour">
          <div className="flex flex-wrap gap-2">
            {PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setDraft({ ...draft, color })}
                className={`h-7 w-7 rounded-full transition ${draft.color === color ? 'ring-2 ring-white ring-offset-2 ring-offset-ink-900' : ''}`}
                style={{ background: color }}
                aria-label={color}
              />
            ))}
          </div>
        </Field>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <input
            type="checkbox"
            checked={draft.writable}
            onChange={(e) => setDraft({ ...draft, writable: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan-500"
          />
          <span className="text-sm">
            <span className="font-medium text-slate-200">Writable</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Adds a control to the dashboard that publishes to the device's command topic.
            </span>
          </span>
        </label>

        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}
