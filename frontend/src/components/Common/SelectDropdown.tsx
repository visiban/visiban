import { useEffect, useRef, useState } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface SelectDropdownOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectDropdownOption<T>[];
  disabled?: boolean;
  /** Shown as a tooltip on the trigger when disabled, explaining why. */
  disabledReason?: string;
  /** "xs" for compact inline selects; "sm" for form-level selects */
  size?: "xs" | "sm";
  placeholder?: string;
  className?: string;
}

export default function SelectDropdown<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  disabledReason,
  size = "sm",
  placeholder,
  className = "",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useDropdownEscape(open, () => setOpen(false), triggerRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? value;

  const triggerPadding = size === "xs" ? "px-2 py-1 text-sm" : "px-2.5 py-1.5 text-sm";

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : undefined}
        aria-label={disabled && disabledReason ? disabledReason : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`${triggerPadding} bg-surface border rounded outline-none flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-sunken
          ${open
            ? "border-info text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
          }`}
      >
        <span className="truncate flex-1 text-left">{label}</span>
        <svg
          className={`w-3 h-3 shrink-0 text-fg-tertiary transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-full max-h-60 overflow-y-auto">
          {options.map((opt, i) => (
            <div key={opt.value}>
              {i > 0 && (
                <div role="separator" className="mx-4">
                  <div className="h-px bg-sunken" />
                  <div className="h-px bg-surface-active/50" />
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-sm transition hover:bg-surface-hover
                  ${opt.value === value ? "text-info" : "text-fg-secondary"}`}
              >
                {opt.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
