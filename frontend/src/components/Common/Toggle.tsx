import { useId } from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  // Opt-in alternative to `disabled` (#1159). Native `disabled` removes the
  // element from the tab order, so a reason shown alongside it (via
  // `aria-describedby`) is reachable only in screen-reader browse mode, never
  // by keyboard focus. `ariaDisabled` keeps the switch focusable and renders
  // `aria-disabled` instead of the native attribute; click and keyboard
  // (Space/Enter) activation are both ignored, and the same disabled visual
  // styling is kept. Use this whenever a disabled reason is shown next to the
  // switch; keep plain `disabled` everywhere else.
  ariaDisabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  // A disabled control must still be able to say *why* it is disabled. Without
  // this passthrough the explanation is visible text with nothing tying it to
  // the switch, so a screen reader announces "dimmed" and no reason (#356).
  "aria-describedby"?: string;
}

export function Toggle({ checked, onChange, disabled, ariaDisabled, id, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy }: ToggleProps) {
  const inertToActivation = disabled || ariaDisabled;
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      aria-disabled={ariaDisabled ? true : undefined}
      onClick={() => {
        // Guards both mouse click and keyboard activation: a native <button>
        // fires a click event for Space/Enter, so blocking here is enough —
        // no separate onKeyDown handler is needed (#1159).
        if (inertToActivation) return;
        onChange(!checked);
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40 ${
        ariaDisabled ? "cursor-not-allowed opacity-40" : ""
      } ${checked ? "bg-primary" : "bg-surface-active"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-fg shadow transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-[3px]"
        }`}
      />
    </button>
  );
}

interface ToggleFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  labelSize?: "sm" | "xs";
}

export function ToggleField({ checked, onChange, label, description, disabled, labelSize = "sm" }: ToggleFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;

  return (
    <div className="flex items-center justify-between cursor-pointer" onClick={() => !disabled && onChange(!checked)}>
      <div className="min-w-0 pr-4">
        <span id={labelId} className={`${labelSize === "xs" ? "text-xs" : "text-sm"} text-fg-secondary`}>{label}</span>
        {description && (
          <p className={`${labelSize === "xs" ? "text-xs" : "text-sm"} text-fg-muted mt-0.5`}>{description}</p>
        )}
      </div>
      <Toggle
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-labelledby={labelId}
      />
    </div>
  );
}
