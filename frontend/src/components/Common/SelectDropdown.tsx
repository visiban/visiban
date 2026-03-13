import { useEffect, useRef, useState } from "react";

export interface SelectDropdownOption<T extends string> {
  value: T;
  label: string;
  /** Renders a separator above this item */
  separatorBefore?: boolean;
}

interface Props<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectDropdownOption<T>[];
  disabled?: boolean;
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
  size = "sm",
  placeholder,
  className = "",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const triggerBase =
    size === "xs"
      ? "text-xs px-2 py-1"
      : "text-sm px-2.5 py-1.5";

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`${triggerBase} bg-slate-800 border border-slate-600 rounded-lg text-slate-200 outline-none flex items-center gap-1.5 transition hover:border-slate-400 focus:border-blue-400 disabled:opacity-50 disabled:cursor-not-allowed ${open ? "border-blue-400" : ""}`}
      >
        <span className="truncate">{label}</span>
        <svg
          className={`w-3 h-3 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
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
        <div className="absolute top-full mt-1 left-0 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 min-w-full max-h-60 overflow-y-auto">
          {options.map((opt) => (
            <div key={opt.value}>
              {opt.separatorBefore && (
                <hr className="my-1 border-slate-700" />
              )}
              <button
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-sm transition hover:bg-slate-700 ${
                  opt.value === value ? "text-blue-400" : "text-slate-200"
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
