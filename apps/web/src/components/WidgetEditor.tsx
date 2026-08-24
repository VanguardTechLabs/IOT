import { useEffect, useMemo, useState } from 'react';
import {
  INTERACTIVE_WIDGETS,
  VARIABLE_FREE_WIDGETS,
  WIDGET_TYPES,
  type Variable,
  type Widget,
  type WidgetConfig,
  type WidgetType,
} from '../lib/api';
import { Alert, Button, Field, Input, Modal, Select } from './ui';

/**
 * Add or configure one widget.
 *
 * The variable list is filtered by widget type: an interactive widget can only be
 * bound to a writable variable, because the API rejects the rest — better to not
 * offer the choice than to explain the error afterwards.
 */

export interface WidgetDraft {
  type: WidgetType;
  variableId: string | null;
  config: WidgetConfig;
}

const TYPE_LABELS: Record<WidgetType, string> = {
  gauge: 'Gauge',
  tank: 'Tank level',
  thermometer: 'Thermometer',
  number: 'Number',
  chart: 'Chart',
  toggle: 'Toggle switch',
  button: 'Button',
  slider: 'Slider',
  text: 'Text note',
};

/** Which config fields each type actually uses. */
const USES_RANGE: readonly WidgetType[] = ['gauge', 'tank', 'thermometer', 'slider'];
const USES_DECIMALS: readonly WidgetType[] = ['gauge', 'tank', 'thermometer', 'number'];

export function WidgetEditor({
  open,
  existing,
  variables,
  onClose,
  onSave,
  onDelete,
  saving,
  error,
}: {
  open: boolean;
  /** Null when adding. */
  existing: Widget | null;
  variables: Variable[];
  onClose: () => void;
  onSave: (draft: WidgetDraft) => void;
  onDelete?: () => void;
  saving?: boolean;
  error?: string | null;
}) {
  const [type, setType] = useState<WidgetType>('gauge');
  const [variableId, setVariableId] = useState<string>('');
  const [config, setConfig] = useState<WidgetConfig>({});

  useEffect(() => {
    if (!open) return;
    setType(existing?.type ?? 'gauge');
    setVariableId(existing?.variableId ?? '');
    setConfig(existing?.config ?? {});
  }, [open, existing]);

  const needsVariable = !VARIABLE_FREE_WIDGETS.includes(type);
  const interactive = INTERACTIVE_WIDGETS.includes(type);

  const selectable = useMemo(
    () => (interactive ? variables.filter((v) => v.writable) : variables),
    [variables, interactive],
  );

  // Changing to an interactive type can strand a selection on a read-only
  // variable; drop it rather than submit something the API will reject.
  useEffect(() => {
    if (variableId && !selectable.some((v) => v.id === variableId)) setVariableId('');
  }, [selectable, variableId]);

  const selected = variables.find((v) => v.id === variableId);

  // Seed the range from the variable's own min/max when the user has not set one.
  useEffect(() => {
    if (!selected || !USES_RANGE.includes(type)) return;
    setConfig((c) => ({
      ...c,
      min: c.min ?? selected.minValue ?? undefined,
      max: c.max ?? selected.maxValue ?? undefined,
    }));
  }, [selected, type]);

  const patch = (next: Partial<WidgetConfig>) => setConfig((c) => ({ ...c, ...next }));
  const num = (v: string) => (v === '' ? undefined : Number(v));

  const blocked = needsVariable && !variableId;

  return (
    <Modal
      open={open}
      title={existing ? 'Edit widget' : 'Add widget'}
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <Button variant="danger" onClick={onDelete} className="mr-auto">
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={saving}
            disabled={blocked}
            onClick={() => onSave({ type, variableId: needsVariable ? variableId : null, config })}
          >
            {existing ? 'Save' : 'Add widget'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as WidgetType)} disabled={!!existing}>
            {WIDGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>

        {needsVariable && (
          <Field
            label="Variable"
            hint={
              interactive
                ? 'Only variables marked as writable can send commands to the device.'
                : undefined
            }
          >
            <Select value={variableId} onChange={(e) => setVariableId(e.target.value)}>
              <option value="">Select a variable…</option>
              {selectable.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label || v.key}
                  {v.unit ? ` (${v.unit})` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {interactive && selectable.length === 0 && (
          <Alert tone="amber">
            None of this device's variables are writable yet. Open a variable's editor, tick{' '}
            <strong>Writable</strong>, and it will appear here.
          </Alert>
        )}

        <Field label="Label" hint="Leave empty to use the variable's own name.">
          <Input
            value={config.label ?? ''}
            onChange={(e) => patch({ label: e.target.value || undefined })}
            placeholder={selected?.label ?? 'Widget title'}
          />
        </Field>

        {type === 'text' && (
          <Field label="Text">
            <textarea
              value={config.body ?? ''}
              onChange={(e) => patch({ body: e.target.value })}
              rows={4}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
            />
          </Field>
        )}

        {USES_RANGE.includes(type) && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum">
              <Input
                type="number"
                value={config.min ?? ''}
                onChange={(e) => patch({ min: num(e.target.value) })}
                placeholder="0"
              />
            </Field>
            <Field label="Maximum">
              <Input
                type="number"
                value={config.max ?? ''}
                onChange={(e) => patch({ max: num(e.target.value) })}
                placeholder="100"
              />
            </Field>
          </div>
        )}

        {type === 'slider' && (
          <Field label="Step">
            <Input
              type="number"
              value={config.step ?? ''}
              onChange={(e) => patch({ step: num(e.target.value) })}
              placeholder="1"
            />
          </Field>
        )}

        {(type === 'toggle' || type === 'button') && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Value when ON" hint="Sent to the device as text.">
              <Input
                value={config.onValue ?? ''}
                onChange={(e) => patch({ onValue: e.target.value || undefined })}
                placeholder="1"
              />
            </Field>
            {type === 'toggle' && (
              <Field label="Value when OFF">
                <Input
                  value={config.offValue ?? ''}
                  onChange={(e) => patch({ offValue: e.target.value || undefined })}
                  placeholder="0"
                />
              </Field>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit" hint="Overrides the variable's unit.">
            <Input
              value={config.unit ?? ''}
              onChange={(e) => patch({ unit: e.target.value || undefined })}
              placeholder={selected?.unit || '—'}
            />
          </Field>
          {USES_DECIMALS.includes(type) && (
            <Field label="Decimals">
              <Input
                type="number"
                min={0}
                max={6}
                value={config.decimals ?? ''}
                onChange={(e) => patch({ decimals: num(e.target.value) })}
                placeholder="1"
              />
            </Field>
          )}
        </div>

        <Field label="Colour">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={config.color ?? selected?.color ?? '#38bdf8'}
              onChange={(e) => patch({ color: e.target.value })}
              className="h-9 w-16 cursor-pointer rounded border border-slate-700 bg-slate-950"
            />
            <Input
              value={config.color ?? ''}
              onChange={(e) => patch({ color: e.target.value || undefined })}
              placeholder={selected?.color ?? '#38bdf8'}
            />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
