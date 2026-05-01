import { useId } from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function Toggle({ checked, onChange, disabled, id, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-primary" : "bg-surface-active"
      }`}
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
