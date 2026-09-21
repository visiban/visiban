import { useEffect, useRef, useState } from "react";
import type { FieldDefinitionShape } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import { ToggleField } from "../Common/Toggle";
import { isValidForType } from "../../utils/customFieldValue";

interface Props {
  definition: FieldDefinitionShape;
  value: string | undefined;
  /**
   * "" clears. The component owns its own commit timing per type — text and
   * number debounce 600ms (mirrors `CardDetail`'s Weight field), date /
   * dropdown / checkbox commit immediately (mirrors the priority / label
   * pattern) — so every call site gets consistent behavior without
   * reimplementing a timer. The caller is responsible for turning this into
   * an actual save (building the full `custom_field_values` array and
   * calling the API), and for wrapping that in whatever autosave/optimistic
   * pattern its surface uses.
   */
  onCommit: (value: string) => void;
  disabled?: boolean;
  /** `sm` = quick-edit popover chrome (card face). `md` = card-detail / Fields-tab. */
  size?: "sm" | "md";
  autoFocus?: boolean;
  /**
   * Debounce for the text and number types, in ms. Defaults to 600, matching
   * the autosave surfaces this was written for. A surface that commits behind
   * an explicit Save button must pass `0` (#1140): with a debounce, clicking
   * Save within the window silently drops the last keystrokes, because the
   * timer never fires before the form is read.
   */
  debounceMs?: number;
  /**
   * Forwarded to the dropdown type's `SingleSelectDropdown` (#1140). Pass a
   * value above 40 when this input is rendered inside a `ModalWrapper`, or
   * Escape closes the modal instead of the open menu.
   */
  escapePriority?: number;
}

const DEBOUNCE_MS = 600;

export default function CustomFieldValueInput({ definition, value, onCommit, disabled, size = "md", autoFocus, debounceMs = DEBOUNCE_MS, escapePriority }: Props) {
  const [local, setLocal] = useState(value ?? "");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  // Re-sync local state if the value changes from outside (e.g. a WS update
  // replaced the whole card) while this input isn't mid-edit.
  useEffect(() => {
    setLocal(value ?? "");
  }, [value]);

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  const debouncedCommit = (next: string) => {
    setLocal(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (debounceMs === 0) { onCommit(next); return; }
    debounceTimer.current = setTimeout(() => onCommit(next), debounceMs);
  };

  const inputClasses = `bg-surface border border-line rounded text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent ${
    size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
  }`;

  // §5(b) defensive-rendering contract: a stored value that doesn't parse for
  // the field's *current* type (e.g. after a retype — #1121) must never be
  // fed into a typed control. A broken date string silently clears a native
  // <input type=date>, which would be a silent data-loss risk on next save.
  if (value !== undefined && value !== "" && !isValidForType(definition, value)) {
    return (
      <div>
        <p className="text-xs text-warning h-4 mb-1">Stored value doesn't match this field's current type. Edit to replace it.</p>
        <input
          type="text"
          className={`${inputClasses} w-full`}
          placeholder="Enter a new value"
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => debouncedCommit(e.target.value)}
        />
      </div>
    );
  }

  switch (definition.field_type) {
    case "text":
      return (
        <input
          type="text"
          className={`${inputClasses} w-full`}
          value={local}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => debouncedCommit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (debounceTimer.current) clearTimeout(debounceTimer.current);
              setLocal(value ?? "");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      );

    case "number":
      return (
        <input
          type="number"
          className={`${inputClasses} ${size === "sm" ? "w-20" : "w-32"}`}
          value={local}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => debouncedCommit(e.target.value)}
        />
      );

    case "date": {
      // Exact parity with CardDetail's due-date pattern: a transparent native
      // <input type=date> sits over a styled display div so the user always
      // sees their configured date format rather than the browser's locale
      // default. showPicker() opens the calendar on click; Safari falls back
      // to .focus().
      const openPicker = () => {
        const el = dateInputRef.current;
        if (!el || disabled) return;
        if (typeof (el as HTMLInputElement & { showPicker?: () => void }).showPicker === "function") {
          try {
            (el as HTMLInputElement & { showPicker: () => void }).showPicker();
            return;
          } catch {
            /* ignore */
          }
        }
        el.focus();
      };
      return (
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 cursor-pointer" onClick={openPicker}>
            <div className={`text-sm border rounded px-2.5 py-1.5 w-full select-none flex items-center justify-between pointer-events-none ${local ? "bg-surface-hover border-line-strong text-fg" : "bg-surface-hover border-line-strong text-fg-muted"}`}>
              <span>{local || "Select a date"}</span>
              <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5" /><path d="M5 1v3M11 1v3M1.5 6h13" /></svg>
            </div>
            <input
              ref={dateInputRef}
              type="date"
              value={local}
              disabled={disabled}
              onChange={(e) => onCommit(e.target.value)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          {local && !disabled && (
            <button
              onClick={() => onCommit("")}
              className="text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
              title="Clear date"
            >
              ✕
            </button>
          )}
        </div>
      );
    }

    case "dropdown": {
      // §5(a): a stored value no longer in the field's current choice set
      // still displays as selected — inject it as a synthetic leading
      // option rather than erroring or silently clearing the selection.
      const stale = value && value !== "" && !definition.choices.includes(value);
      const options = [
        ...(stale ? [{ value: value!, label: `${value} (no longer a valid choice)` }] : []),
        ...definition.choices.map((c) => ({ value: c, label: c })),
      ];
      return (
        <SingleSelectDropdown
          label="— No value —"
          options={options}
          selected={local || null}
          onChange={(v) => { const next = v ?? ""; setLocal(next); onCommit(next); }}
          className={size === "md" ? "w-full justify-between" : undefined}
          escapePriority={escapePriority}
        />
      );
    }

    case "checkbox":
      // Per-type layout exception (ux-design spec §6): ToggleField renders
      // its own label + description, so the caller (CustomFieldEditRow) must
      // skip its own name/help_text paragraph for this type to avoid
      // duplicating the field name.
      return (
        <ToggleField
          checked={local === "true"}
          onChange={(checked) => { const next = checked ? "true" : "false"; setLocal(next); onCommit(next); }}
          label={definition.name}
          description={definition.help_text || undefined}
          disabled={disabled}
          labelSize={size === "sm" ? "xs" : "sm"}
        />
      );

    default:
      return null;
  }
}
