import { useEffect, useRef, useState } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface SingleSelectDropdownProps<T extends string | number> {
  label: string;
  options: { value: T; label: string }[];
  selected: T | null;
  onChange: (selected: T | null) => void;
}

export default function SingleSelectDropdown<T extends string | number>({
  label,
  options,
  selected,
  onChange,
}: SingleSelectDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useDropdownEscape(open, () => setOpen(false), triggerRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const displayLabel =
    selected === null
      ? label
      : options.find((o) => o.value === selected)?.label ?? label;

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className={`bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-sunken ${
          selected !== null
            ? "border-info text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
        }`}
      >
        {displayLabel}
        <svg
          className="w-3 h-3 text-fg-muted"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[140px]">
          {options.map((opt, i) => (
            <div key={opt.value}>
              {i > 0 && (
                <div role="separator" className="mx-4">
                  <div className="h-px bg-sunken" />
                  <div className="h-px bg-surface-active/50" />
                </div>
              )}
              <button
                onClick={() => {
                  onChange(selected === opt.value ? null : opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 hover:bg-surface-hover text-sm transition ${
                  selected === opt.value ? "text-info" : "text-fg-secondary"
                }`}
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
