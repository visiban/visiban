import { useEffect, useRef } from "react";

interface Props {
  anchorRect: DOMRect;
  choices: string[];
  selected: string;
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

const POPOVER_WIDTH = 190;
const POPOVER_GAP = 4;

/**
 * The dropdown quick-edit popover for a pinned custom-field chip on the card
 * face (#371) — click a dropdown chip, pick a value, never open the card.
 * Positioning technique borrowed from `CardPeekPopover` (anchor rect +
 * viewport-edge flip); the listbox a11y model is a lighter version of
 * `SelectDropdown`'s (role="listbox"/"option" + Escape + click-outside),
 * not a full roving-tabindex fork — this is a small, single-purpose chooser
 * over a chip, not a general-purpose dropdown.
 */
export default function CustomFieldQuickEditPopover({ anchorRect, choices, selected, onSelect, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onDismiss]);

  const wouldOverflowRight = anchorRect.left + POPOVER_WIDTH > window.innerWidth;
  const style: React.CSSProperties = {
    position: "fixed",
    top: anchorRect.bottom + POPOVER_GAP,
    zIndex: 50,
    width: POPOVER_WIDTH,
    ...(wouldOverflowRight
      ? { right: window.innerWidth - anchorRect.right }
      : { left: anchorRect.left }),
  };

  return (
    <div
      ref={ref}
      role="listbox"
      style={style}
      className="bg-surface border border-line-strong rounded-lg shadow-xl py-1.5"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        role="option"
        aria-selected={selected === ""}
        onClick={() => { onSelect(""); onDismiss(); }}
        className={`w-full text-left px-2.5 py-1 text-xs rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${selected === "" ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface-hover"}`}
      >
        — No value —
      </button>
      {choices.map((choice) => (
        <button
          key={choice}
          role="option"
          aria-selected={selected === choice}
          onClick={() => { onSelect(choice); onDismiss(); }}
          className={`w-full text-left px-2.5 py-1 text-xs rounded transition flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${selected === choice ? "bg-surface-hover text-fg" : "text-fg-secondary hover:bg-surface-hover"}`}
        >
          <span className="truncate">{choice}</span>
          {selected === choice && <span className="text-info shrink-0">✓</span>}
        </button>
      ))}
    </div>
  );
}
