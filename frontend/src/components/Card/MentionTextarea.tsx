import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { POPOVER_VIEWPORT_MARGIN, placeFixedElement, type AnchoredSide } from "../../hooks/useAnchoredPlacement";
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
}

interface MentionState {
  active: boolean;
  query: string;
  startIndex: number; // index of the '@' in value
}

export default function MentionTextarea({ value, onChange, onSubmit, members, placeholder, rows = 2, className }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionState>({ active: false, query: "", startIndex: -1 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Side chosen on first placement, kept while the list narrows so it never flips across the textarea.
  const sideRef = useRef<AnchoredSide | undefined>(undefined);

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

  // The list is `position: fixed` (not `absolute bottom-full`) so the card sheet's scroll region
  // cannot clip it (#2092). It stays in this component's DOM subtree rather than a body portal
  // because the sheet's focus trap and click-outside dismissal treat a portal as outside the
  // dialog. Focus never leaves the textarea: options preventDefault on mousedown.
  const place = () => {
    const ta = textareaRef.current;
    const el = dropdownRef.current;
    if (!ta || !el) return;
    const r = ta.getBoundingClientRect();
    const left = Math.max(
      POPOVER_VIEWPORT_MARGIN,
      Math.min(r.left, window.innerWidth - el.offsetWidth - POPOVER_VIEWPORT_MARGIN),
    );
    sideRef.current = placeFixedElement(el, { top: r.top, bottom: r.bottom, left }, sideRef.current) ?? sideRef.current;
    // Re-anchoring (not dismissing) on scroll means the textarea can scroll out of view while the
    // list is open; hide it rather than leave it pinned to the viewport edge, detached from its field.
    if (r.bottom < 0 || r.top > window.innerHeight) el.style.visibility = "hidden";
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
      />
      {open && (
        <div
          ref={dropdownRef}
          // Hidden until the layout effect measures and places it (no flash at 0,0).
          style={{ position: "fixed", visibility: "hidden", top: 0, left: 0 }}
          className="z-[60] w-56 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] bg-surface border border-line-strong rounded-lg shadow-lg overflow-y-auto"
        >
          {suggestions.map((u, i) => (
            <button
              key={u.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insertMention(u.username); }}
              className={`w-full text-left px-3 py-2 text-sm flex flex-col hover:bg-surface-hover transition ${
                i === selectedIndex ? "bg-surface-hover" : ""
              }`}
            >
              <span className="font-medium text-fg truncate">@{u.username}</span>
              {userDisplayName(u) !== u.username && (
                <span className="text-xs text-fg-tertiary truncate">{userDisplayName(u)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
