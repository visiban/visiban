import { useEffect, useRef, useState } from "react";
import {
  CHOICE_COLOR_KEYS,
  CHOICE_COLORS,
  choiceColorName,
  isChoiceColorKey,
  type ChoiceColorKey,
} from "../../constants/choiceColors";
import { useEscapeStack } from "../../hooks/useEscapeStack";

/**
 * Escape priority for the open swatch popover. The picker lives in the Board
 * Settings field editors, inside `ModalWrapper` (40), so it must sit above 40
 * or Escape would close the whole settings modal. 45 and 46 are the swimlane
 * value editors; see the allocation list in frontend/CLAUDE.md.
 */
export const CHOICE_COLOR_ESCAPE_PRIORITY = 47;

/**
 * Space the popover needs below its trigger (two swatch rows, the header and
 * the reset button, plus margin). With less than this left in the viewport it
 * opens upward instead — the last choice row sits at the bottom of the
 * scrolling settings panel.
 */
const POPOVER_FLIP_THRESHOLD = 200;

interface Props {
  /** The choice's text as currently typed in the editor draft. */
  choice: string;
  /** The draft's palette key for this choice; anything unknown reads as automatic. */
  colorKey: string | undefined;
  /** `null` = reset to automatic. */
  onChange: (key: ChoiceColorKey | null) => void;
  /** Escape priority override — only tests use this, to prove the ordering. */
  escapePriority?: number;
}

/**
 * Per-choice color control in the Board Settings field editors (#1391).
 *
 * A round swatch button showing the choice's explicit color, or — when none
 * is set — a hollow dashed circle labelled "Automatic" (deliberately not the
 * hash color: a filled circle would read as a picked color, and a multi-select
 * chip with no color has no dot at all), that opens a small popover of the 8 palette swatches plus "Reset to
 * automatic". The pick only changes the editor draft; it is saved with the
 * field by the existing "Save field" button, never on its own.
 *
 * Keyboard: the swatches are a `radiogroup` with a roving tab stop — arrows
 * move focus, Space/Enter select (and close). Escape closes only this popover
 * (priority 47, above the modal's 40) and returns focus to the swatch button.
 * Tabbing out of the popover, or a click outside, closes it without a change.
 * It opens upward when the viewport has little room below the trigger, and
 * scrolls itself into view inside the settings panel.
 */
export default function ChoiceColorPicker({ choice, colorKey, onChange, escapePriority = CHOICE_COLOR_ESCAPE_PRIORITY }: Props) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = isChoiceColorKey(colorKey) ? colorKey : null;
  const disabled = choice.trim() === "";
  const label = current ? choiceColorName(current) : "Automatic";

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const toggle = () => {
    if (!open && triggerRef.current) {
      // Measured on open only: the popover does not chase a scrolling panel.
      const below = window.innerHeight - triggerRef.current.getBoundingClientRect().bottom;
      setAbove(below < POPOVER_FLIP_THRESHOLD);
    }
    setOpen((o) => !o);
  };

  return (
    <div
      ref={wrapperRef}
      className="relative shrink-0"
      // focusout bubbles: Tab (or any focus move) leaving the wrapper closes
      // the popover without pulling focus back to the trigger. No focus trap.
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={disabled ? "Color: type a choice first" : `Color for ${choice.trim()}: ${label}`}
        title={disabled ? undefined : label}
        // p-0.5 makes a 24px hit area around the 20px swatch.
        className="block p-0.5 rounded-full disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        {current ? (
          <span
            className="block w-5 h-5 rounded-full border border-line-strong"
            style={{ backgroundColor: CHOICE_COLORS[current].base }}
            data-swatch={current}
          />
        ) : (
          <span className="block w-5 h-5 rounded-full border border-dashed border-line-strong" data-swatch="automatic" />
        )}
      </button>
      {open && !disabled && (
        <SwatchPopover
          choice={choice.trim()}
          current={current}
          above={above}
          wrapperRef={wrapperRef}
          escapePriority={escapePriority}
          onPick={(key) => { onChange(key); close(true); }}
          onClose={close}
        />
      )}
    </div>
  );
}

interface PopoverProps {
  choice: string;
  current: ChoiceColorKey | null;
  /** Open upward (`bottom-full`) rather than below the trigger. */
  above: boolean;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  escapePriority: number;
  onPick: (key: ChoiceColorKey | null) => void;
  onClose: (refocus: boolean) => void;
}

/** Mounted only while open, so its Escape handler is registered only then. */
function SwatchPopover({ choice, current, above, wrapperRef, escapePriority, onPick, onClose }: PopoverProps) {
  const startIndex = current ? CHOICE_COLOR_KEYS.indexOf(current) : 0;
  const [focusIndex, setFocusIndex] = useState(startIndex);
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEscapeStack(() => { onClose(true); }, escapePriority);

  useEffect(() => {
    // Keep a popover opened on the last row inside the scrolling panel.
    // Optional call: jsdom (tests) has no scrollIntoView.
    popoverRef.current?.scrollIntoView?.({ block: "nearest" });
    swatchRefs.current[startIndex]?.focus();
    // Scroll into view and focus the selected (or first) swatch once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time focus only; startIndex is fixed for the popover's lifetime
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [wrapperRef, onClose]);

  const move = (to: number) => {
    const n = CHOICE_COLOR_KEYS.length;
    const next = (to + n) % n;
    setFocusIndex(next);
    swatchRefs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(e.key === "ArrowDown" ? i + 4 : i + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(e.key === "ArrowUp" ? i - 4 : i - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(CHOICE_COLOR_KEYS.length - 1);
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        onPick(CHOICE_COLOR_KEYS[i]);
        break;
    }
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Color for ${choice}`}
      className={`absolute left-0 ${above ? "bottom-full mb-1" : "top-full mt-1"} z-20 w-max bg-surface border border-line-strong rounded-lg shadow-xl p-2`}
    >
      <p className="text-xs text-fg-muted mb-1.5">{current ? choiceColorName(current) : "Automatic"}</p>
      <div role="radiogroup" aria-label="Palette" className="grid grid-cols-4 gap-2">
        {CHOICE_COLOR_KEYS.map((key, i) => {
          const checked = key === current;
          return (
            <button
              key={key}
              ref={(el) => { swatchRefs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={choiceColorName(key)}
              title={choiceColorName(key)}
              tabIndex={i === focusIndex ? 0 : -1}
              onClick={() => onPick(key)}
              onKeyDown={(e) => onKeyDown(e, i)}
              // The selected swatch carries a ring as well as the check: the
              // white check alone is under 3:1 on amber, green and teal.
              className={`w-6 h-6 rounded-full border border-line-strong flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-surface ${checked ? "ring-2 ring-fg ring-offset-1 ring-offset-surface" : ""}`}
              style={{ backgroundColor: CHOICE_COLORS[key].base }}
            >
              {checked && (
                <svg className="w-3.5 h-3.5 text-on-primary drop-shadow" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M2 6l3 3 5-5" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onPick(null)}
        className="mt-2 text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-1.5 py-0.5 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        Reset to automatic
      </button>
    </div>
  );
}
