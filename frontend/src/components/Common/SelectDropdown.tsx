import { useEffect, useId, useRef, useState } from "react";
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
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const optionIdPrefix = useId();

  useDropdownEscape(open, () => { setOpen(false); setActiveIndex(-1); }, triggerRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Initialize activeIndex to the currently selected option when opening
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, value, options]);

  const handleSelect = (val: T) => {
    onChange(val);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          const next = e.key === "ArrowDown"
            ? Math.min(activeIndex + 1, options.length - 1)
            : Math.max(activeIndex - 1, 0);
          setActiveIndex(next);
        }
        break;
      }
      case "Enter":
      case " ": {
        if (!open) {
          e.preventDefault();
          setOpen(true);
        } else if (activeIndex >= 0 && activeIndex < options.length) {
          e.preventDefault();
          handleSelect(options[activeIndex].value);
        }
        break;
      }
      case "Tab": {
        if (open) {
          setOpen(false);
          setActiveIndex(-1);
        }
        break;
      }
    }
  };

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? value;
  const activeDescendant = open && activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined;

  const triggerPadding = size === "xs" ? "px-2 py-1 text-sm" : "px-2.5 py-1.5 text-sm";

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : undefined}
        aria-label={disabled && disabledReason ? disabledReason : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
        className={`${triggerPadding} bg-surface border rounded outline-none flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken
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
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full mt-1 left-0 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-full max-h-60 overflow-y-auto"
        >
          {options.map((opt, i) => (
            <div key={opt.value}>
              {i > 0 && (
                <div role="separator" className="mx-4">
                  <div className="h-px bg-sunken" />
                  <div className="h-px bg-surface-active/50" />
                </div>
              )}
              <div
                id={`${optionIdPrefix}-${i}`}
                role="option"
                aria-selected={opt.value === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(opt.value)}
                className={`w-full text-left px-3 py-1.5 text-sm transition cursor-pointer hover:bg-surface-hover
                  ${i === activeIndex ? "bg-surface-hover" : ""}
                  ${opt.value === value ? "text-info" : "text-fg-secondary"}`}
              >
                {opt.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
