import { useEffect, useId, useRef, useState } from "react";
import type { FieldDefinitionShape } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import { ToggleField } from "../Common/Toggle";
import { CUSTOM_FIELD_VALUE_MAX, URL_ERROR_COPY, isValidForType, normalizeUrl } from "../../utils/customFieldValue";
import CustomFieldLink from "./CustomFieldLink";
import MultiSelectValueInput from "./MultiSelectValueInput";

interface Props {
  definition: FieldDefinitionShape;
  value: string | undefined;
  /**
   * "" clears. The component owns its own commit timing per type — text and
   * number debounce 600ms (mirrors `CardDetail`'s Weight field), date /
   * dropdown / checkbox commit immediately (mirrors the priority / label
   * pattern), url commits only on blur / Enter and only a valid address
   * (#1390) — so every call site gets consistent behavior without
   * reimplementing a timer. The caller is responsible for turning this into
   * an actual save (building the full `custom_field_values` array and
   * calling the API), and for wrapping that in whatever autosave/optimistic
   * pattern its surface uses.
   */
  onCommit: (value: string) => void | Promise<void>;
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
   * Forwarded to the dropdown type's `SingleSelectDropdown` (#1140) and the
   * multi-select menu (#1391). Pass a value above 40 when this input is
   * rendered inside a `ModalWrapper`, or Escape closes the modal instead of
   * the open menu. Unset, the multi-select menu uses 39 (inside `CardDetail`).
   */
  escapePriority?: number;
  /**
   * URL type only (#1390): inline copy for a save the server refused, mapped
   * by the caller (`urlErrorFromServer`). Shown in the same reserved slot as
   * the client-side error, and only while the input still holds the value
   * that was rejected — editing or Escape hides it.
   */
  serverError?: string | null;
  /**
   * URL type only (#1390): called from the blur / Enter / Escape handlers with
   * whether the input now holds text that failed validation (and so was *not*
   * committed). A Save-button surface (EditSwimlaneModal) needs this: clicking
   * Save blurs the input first, the invalid text is refused, and without this
   * signal the form would save without it and close as if nothing was wrong.
   * Called synchronously in the event handler, not from an effect, so the
   * Save click that caused the blur already sees it.
   */
  onInvalidChange?: (invalid: boolean) => void;
}

const DEBOUNCE_MS = 600;

export default function CustomFieldValueInput({ definition, value, onCommit, disabled, size = "md", autoFocus, debounceMs = DEBOUNCE_MS, escapePriority, serverError, onInvalidChange }: Props) {
  const [local, setLocal] = useState(value ?? "");
  // URL type (#1390): client-side validation error, and the last value handed
  // to onCommit — so a blur right after an Enter does not save twice, and a
  // server error is shown only against the value it was about.
  const [urlError, setUrlError] = useState<string | null>(null);
  const [lastCommitted, setLastCommitted] = useState(value ?? "");
  const slotId = useId();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  // Re-sync local state if the value changes from outside (e.g. a WS update
  // replaced the whole card) while this input isn't mid-edit.
  useEffect(() => {
    setLocal(value ?? "");
    setUrlError(null);
    setLastCommitted(value ?? "");
  }, [value]);

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  const debouncedCommit = (next: string) => {
    setLocal(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (debounceMs === 0) { void onCommit(next); return; }
    debounceTimer.current = setTimeout(() => onCommit(next), debounceMs);
  };

  const inputClasses = `bg-surface border border-line rounded text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent ${
    size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
  }`;

  // #1390: the URL editor, shared by the normal path and the legacy
  // type-mismatch fallback below so both commit on blur / Enter only — never
  // per keystroke, and never debounced, whatever `debounceMs` says. A
  // half-typed address is not a value worth a round trip, and an invalid one
  // must not be saved at all. Clicking a Save button blurs the input first, so
  // Save-button surfaces (EditSwimlaneModal) still receive the final value —
  // or, for invalid text, an `onInvalidChange(true)` so they can refuse to save.
  const renderUrlEditor = () => {
    const setError = (error: string | null) => {
      setUrlError(error);
      onInvalidChange?.(error !== null);
    };
    const commitUrl = (): boolean => {
      // Untouched (including an untouched legacy value): nothing to save, and
      // no error for a value the user has not edited yet.
      if (local === (value ?? "")) { setError(null); return true; }
      if (local.trim() === "") {
        setError(null);
        setLocal("");
        if (lastCommitted !== "") { setLastCommitted(""); void onCommit(""); }
        return true;
      }
      const result = normalizeUrl(local);
      if (!result.ok) {
        // Keep the typed text visible with the error; the saved value is untouched.
        setError(URL_ERROR_COPY[result.error]);
        return false;
      }
      setError(null);
      setLocal(result.url);
      if (result.url !== lastCommitted) { setLastCommitted(result.url); void onCommit(result.url); }
      return true;
    };
    const shownError = urlError ?? (serverError && local === lastCommitted ? serverError : null);
    // The invalid state keeps a danger indicator while focused: the base
    // classes' focus:border-transparent + primary ring would otherwise hide it
    // exactly while the user is fixing the value.
    const urlInputClasses = [
      "bg-surface border rounded text-fg-secondary focus:outline-none focus:ring-2 w-full placeholder-fg-muted",
      shownError ? "border-danger focus:ring-danger-emphasis" : "border-line focus:ring-primary-emphasis focus:border-transparent",
      size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
    ].join(" ");
    // The helper links the *saved* value, so it is hidden while the input
    // holds unsaved text — it would otherwise open something other than what
    // the user sees.
    const showHelper = !shownError && !disabled && !!value && local === value;
    return (
      <div>
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com"
          maxLength={CUSTOM_FIELD_VALUE_MAX}
          className={urlInputClasses}
          value={local}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={definition.name}
          aria-invalid={shownError ? true : undefined}
          // Only the error describes the input; the Open link helper is a
          // separate control, not a description of this field.
          aria-describedby={shownError ? slotId : undefined}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => { commitUrl(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // An invalid value must not submit an enclosing form either —
              // the form would save the *previous* value without saying so.
              if (!commitUrl()) e.preventDefault();
            } else if (e.key === "Escape") {
              setLocal(value ?? "");
              setError(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {/* Reserved slot (frontend/CLAUDE.md § Inline status messages):
            always rendered, so the row never jumps; it holds the error when
            there is one and otherwise the `Open link ↗` helper for the saved
            value. min-h-4 because the scheme error can wrap. */}
        <p className="text-xs min-h-4 mt-1">
          {shownError ? (
            <span id={slotId} role="alert" className="text-danger">{shownError}</span>
          ) : (
            showHelper ? <CustomFieldLink value={value!} variant="action" /> : null
          )}
        </p>
      </div>
    );
  };

  // #1391: multi-select owns its commit timing (once, on menu close) and its
  // own defensive parse — an unparseable stored value reads as no entries
  // rather than going through the per-keystroke text fallback below, which
  // would send free text the server refuses.
  if (definition.field_type === "multi_select") {
    return (
      <MultiSelectValueInput
        definition={definition}
        value={value}
        onCommit={onCommit}
        disabled={disabled}
        escapePriority={escapePriority}
      />
    );
  }

  // §5(b) defensive-rendering contract: a stored value that doesn't parse for
  // the field's *current* type (e.g. after a retype — #1121) must never be
  // fed into a typed control. A broken date string silently clears a native
  // <input type=date>, which would be a silent data-loss risk on next save.
  if (value !== undefined && value !== "" && !isValidForType(definition, value)) {
    if (definition.field_type === "url") {
      // A legacy URL value (e.g. a stored `javascript:`) is fixed through the
      // same blur/Enter editor and error slot as a normal one — the plain
      // fallback below saves on every keystroke, which would 400 repeatedly.
      return (
        <div>
          <p className="text-xs text-warning h-4 mb-1">Stored value doesn't match this field's current type. Edit to replace it.</p>
          {renderUrlEditor()}
        </div>
      );
    }
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
          <div className="relative flex-1 cursor-pointer rounded focus-within:ring-2 focus-within:ring-primary-emphasis">
            <div className={`text-sm border rounded px-2.5 py-1.5 w-full select-none flex items-center justify-between pointer-events-none ${local ? "bg-surface-hover border-line-strong text-fg" : "bg-surface-hover border-line-strong text-fg-muted"}`}>
              <span>{local || "Select a date"}</span>
              <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5" /><path d="M5 1v3M11 1v3M1.5 6h13" /></svg>
            </div>
            <input
              ref={dateInputRef}
              type="date"
              aria-label={definition.name}
              value={local}
              disabled={disabled}
              onChange={(e) => onCommit(e.target.value)}
              onClick={openPicker}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          {local && !disabled && (
            <button
              onClick={() => onCommit("")}
              className="text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
              title="Clear date"
              aria-label="Clear date"
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
          onChange={(v) => { const next = v ?? ""; setLocal(next); void onCommit(next); }}
          className={size === "md" ? "w-full justify-between" : undefined}
          escapePriority={escapePriority}
        />
      );
    }

    case "url":
      return renderUrlEditor();

    case "checkbox":
      // Per-type layout exception (ux-design spec §6): ToggleField renders
      // its own label + description, so the caller (CustomFieldEditRow) must
      // skip its own name/help_text paragraph for this type to avoid
      // duplicating the field name.
      return (
        <ToggleField
          checked={local === "true"}
          onChange={(checked) => { const next = checked ? "true" : "false"; setLocal(next); void onCommit(next); }}
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
