import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { POPOVER_VIEWPORT_MARGIN } from "../../hooks/useAnchoredPlacement";
import type { EffectiveBoardMember } from "../../types";
import { userDisplayName } from "../../types";

interface Props {
  value: string;
  onChange: (val: string) => void;
  onSubmit?: () => void;
  members: EffectiveBoardMember[];
  placeholder?: string;
  rows?: number;
  className?: string;
  /** Accessible name; falls back to the placeholder, which is not a reliable name on its own. */
  ariaLabel?: string;
}

interface MentionState {
  active: boolean;
  query: string;
  startIndex: number; // index of the '@' in value
}

/** Whether any part of `r` lies inside the viewport and the nearest scrollable ancestor's visible box. */
function isRectVisible(r: DOMRect, el: HTMLElement): boolean {
  let top = 0;
  let bottom = window.innerHeight;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const oy = getComputedStyle(a).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") {
      const ar = a.getBoundingClientRect();
      top = Math.max(top, ar.top);
      bottom = Math.min(bottom, ar.bottom);
      break;
    }
  }
  return r.bottom > top && r.top < bottom;
}

export default function MentionTextarea({ value, onChange, onSubmit, members, placeholder, rows = 2, className, ariaLabel }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Stable per-instance ids so several MentionTextareas on one page never collide (#2137).
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (userId: number | undefined) => `${baseId}-option-${userId}`;
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionState>({ active: false, query: "", startIndex: -1 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Side chosen on first placement, kept while the list narrows so it never flips across the textarea.
  const sideRef = useRef<"below" | "above" | undefined>(undefined);
  // Textarea rect at the last placement; the follow loop below re-places when it moves.
  const lastRectRef = useRef<{ top: number; bottom: number; left: number } | null>(null);

  const suggestions = mention.active
    ? members
        .map((m) => m.user)
        .filter((u) => {
          const q = mention.query.toLowerCase();
          return u.username.toLowerCase().startsWith(q) || userDisplayName(u).toLowerCase().startsWith(q);
        })
        .slice(0, 6)
    : [];

  const open = mention.active && suggestions.length > 0;
  // selectedIndex is reset in an effect, so it can be stale for one render after the list narrows.
  const activeUser = suggestions[Math.min(selectedIndex, suggestions.length - 1)];

  // The list is `position: fixed` (not `absolute bottom-full`) so the card sheet's scroll region
  // cannot clip it (#2092). It stays in this component's DOM subtree rather than a body portal
  // because the sheet's focus trap and click-outside dismissal treat a portal as outside the
  // dialog. Focus never leaves the textarea: options preventDefault on mousedown.
  const place = () => {
    const ta = textareaRef.current;
    const el = dropdownRef.current;
    if (!ta || !el) return;
    const r = ta.getBoundingClientRect();
    lastRectRef.current = { top: r.top, bottom: r.bottom, left: r.left };
    // Measure the natural height with no inline cap from an earlier placement.
    el.style.maxHeight = "";
    const natural = el.offsetHeight;
    if (natural === 0) return; // not rendered yet / transient empty render: stay hidden or as-is
    const margin = POPOVER_VIEWPORT_MARGIN;
    const gap = 4;
    const spaceBelow = window.innerHeight - margin - (r.bottom + gap);
    const spaceAbove = r.top - gap - margin;
    // Keep the side chosen earlier while the list still fits there (no flip as it narrows); else
    // below, else above, else the larger side with the list capped to it. The list NEVER overlaps
    // the textarea (the user is typing in it) and is never pinned: the side and cap are recomputed
    // on every re-measure, so a list that shrinks leaves the capped side as soon as it fits.
    let side: "below" | "above";
    if (sideRef.current === "below" && natural <= spaceBelow) side = "below";
    else if (sideRef.current === "above" && natural <= spaceAbove) side = "above";
    else if (natural <= spaceBelow) side = "below";
    else if (natural <= spaceAbove) side = "above";
    else side = spaceBelow >= spaceAbove ? "below" : "above";
    const space = Math.max(0, side === "below" ? spaceBelow : spaceAbove);
    const height = Math.min(natural, space);
    if (natural > space) el.style.maxHeight = `${space}px`;
    sideRef.current = side;
    el.style.top = `${side === "below" ? r.bottom + gap : r.top - gap - height}px`;
    el.style.left = `${Math.max(
      margin,
      Math.min(r.left, window.innerWidth - el.offsetWidth - margin),
    )}px`;
    // Re-anchoring (not dismissing) means the textarea can scroll out of view while the list is
    // open: out of the viewport, or under the card sheet's header/footer, which clip it inside the
    // nearest scrollable ancestor. Hide the list then rather than leave it attached to an invisible field.
    el.style.visibility = isRectVisible(r, ta) ? "" : "hidden";
  };

  // Re-measure when the visible options change height. Keyed on the ids, not the count: an option
  // is two lines only when its display name differs from its username, so a same-length list can
  // change height (frontend/CLAUDE.md: never estimate height from an item count).
  const suggestionKey = suggestions.map((u) => u.id).join(",");
  useLayoutEffect(() => {
    if (!open) {
      sideRef.current = undefined;
      return;
    }
    place();
  }, [open, suggestionKey]);

  // Follow the textarea while the list is open. The card sheet re-places itself about 150ms after a
  // resize or board scroll-end, with a slide, and no scroll/resize event fires for that; a per-frame
  // rect comparison (cheap, only while open) is the least invasive way to stay attached to it.
  useEffect(() => {
    if (!open) return;
    let id = requestAnimationFrame(function tick() {
      const r = textareaRef.current?.getBoundingClientRect();
      const l = lastRectRef.current;
      if (r && (!l || r.top !== l.top || r.bottom !== l.bottom || r.left !== l.left)) place();
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Re-anchor (never dismiss) on scroll and resize: typing makes the browser scroll the caret into
  // view, so closing on scroll would end the list mid-word. Capture catches inner scroll regions.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Keep the keyboard-selected option visible when the list is capped to a short viewport.
  useEffect(() => {
    if (!open) return;
    dropdownRef.current?.children[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, selectedIndex]);

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [mention.query]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value;
    const cursor = e.target.selectionStart ?? newVal.length;

    // Find the @-word before the cursor
    const textBeforeCursor = newVal.slice(0, cursor);
    const match = textBeforeCursor.match(/@([\w.]*)$/);

    if (match) {
      setMention({ active: true, query: match[1], startIndex: cursor - match[0].length });
    } else {
      setMention({ active: false, query: "", startIndex: -1 });
    }

    onChange(newVal);
  };

  const insertMention = (username: string) => {
    const before = value.slice(0, mention.startIndex);
    const after = value.slice(mention.startIndex + 1 + mention.query.length);
    const newVal = `${before}@${username} ${after}`;
    onChange(newVal);
    setMention({ active: false, query: "", startIndex: -1 });

    // Restore focus and move cursor after the inserted mention
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = before.length + username.length + 2; // '@' + username + ' '
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    });
  };

  // Escape closes the open suggestion popup (priority 43, above the card panel's 30) rather than
  // also closing the panel; returns false with no popup so Escape still reaches the panel (#2036).
  useEscapeStack(() => {
    if (!mention.active || suggestions.length === 0) return false;
    setMention({ active: false, query: "", startIndex: -1 });
  }, 43);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter without Shift submits the comment (when mention dropdown is not active)
    if (e.key === "Enter" && !e.shiftKey && (!mention.active || suggestions.length === 0)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }

    if (!mention.active || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertMention(suggestions[selectedIndex].username);
    }
    // Escape is handled by the useEscapeStack registration above (#2036).
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        className={className}
        // ARIA 1.2 combobox: focus stays here while arrow keys move the active option (#2137).
        role="combobox"
        aria-multiline="true"
        aria-label={ariaLabel ?? placeholder}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? optionId(activeUser?.id) : undefined}
      />
      {open && (
        <div
          ref={dropdownRef}
          id={listboxId}
          role="listbox"
          aria-label="Mention suggestions"
          // Hidden until the layout effect measures and places it (no flash at 0,0).
          style={{ position: "fixed", visibility: "hidden", top: 0, left: 0 }}
          className="z-[60] w-56 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] bg-surface border border-line-strong rounded-lg shadow-lg overflow-y-auto"
        >
          {suggestions.map((u, i) => (
            <div
              key={u.id}
              id={optionId(u.id)}
              role="option"
              aria-selected={i === selectedIndex}
              onMouseDown={(e) => { e.preventDefault(); insertMention(u.username); }}
              className={`w-full text-left px-3 py-2 text-sm flex flex-col cursor-pointer hover:bg-surface-hover transition ${
                i === selectedIndex ? "bg-surface-hover" : ""
              }`}
            >
              <span className="font-medium text-fg truncate">@{u.username}</span>
              {userDisplayName(u) !== u.username && (
                <span className="text-xs text-fg-tertiary truncate">{userDisplayName(u)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
