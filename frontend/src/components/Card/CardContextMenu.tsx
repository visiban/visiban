import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { POPOVER_VIEWPORT_MARGIN, useAnchoredPlacement } from "../../hooks/useAnchoredPlacement";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { PRIORITY_COLORS } from "../../constants/colors";
import { MENU_ITEM_FOCUS_RING, MENU_ITEM_FOCUS_RING_DANGER } from "../Common/menuItemFocusRing";
import type { BoardFull, Column, Priority } from "../../types";
import { userDisplayName } from "../../types";
import { CARD_MENU_GROUPS, PRIORITY_CHOICES, type CardActionEntry, type CardActionId } from "../../utils/cardActions";

/**
 * Escape priority of the card context menu (#2059). The 1.3 UI spec proposed
 * 43 (menu) / 44 (submenu); both are taken in the card-panel list (#2036).
 * 59 sits above every board-page surface that can be open beside the menu
 * (dropdowns 25, the card-face quick-edit popover 32, the block form 42) and
 * below the command palette (60). One entry serves both levels: an open
 * submenu closes first, the same way the palette backs out of its drill-in
 * levels from its single 60. Recorded in frontend/CLAUDE.md § Card context menu.
 */
export const CARD_MENU_ESCAPE_PRIORITY = 59;

/** Viewport point (pointer) or the card's rect (keyboard, `⋯` button). */
export type CardMenuAnchor = { top: number; bottom: number; left: number };

export type CardMenuCloseReason = "escape" | "tab" | "outside" | "action";

type Submenu = "move" | "assign" | "priority";
const SUBMENU_IDS = new Set<CardActionId>(["move", "assign", "priority"]);

interface Props {
  anchor: CardMenuAnchor;
  /** Accessible name, e.g. `Card actions: Fix payout rounding` or `Actions for 3 cards`. */
  label: string;
  /** Shown as the header row for a multi-card target ("3 cards"). */
  header?: string;
  entries: CardActionEntry[];
  columns: Column[];
  members: BoardFull["members"];
  onAction: (action: CardActionId, value?: number | string | null) => void;
  /** Called on every close; `escape`/`tab` mean focus should return to the target card. */
  onClose: (reason: CardMenuCloseReason) => void;
}

interface SubItem { key: string; label: string; value: number | string | null; dot?: string; italic?: boolean }

/**
 * Card context menu (#2059, 1.3 UI spec Part 9 § 2): opened by right-click,
 * `Menu` / `Shift+F10` on a focused card, or the `⋯ More actions` button at
 * coarse pointer. Portaled and placed from a measurement (§ Modals and
 * dialogs, anchored `fixed` popovers): hidden until placed, closed on resize,
 * on a scroll outside it, on Tab and on an outside press.
 *
 * Disabled items stay in the roving order with their reason on a visible
 * second line (never hidden), so a keyboard user can read why; activating one
 * does nothing and re-announces the reason.
 */
export default function CardContextMenu({ anchor, label, header, entries, columns, members, onAction, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const subItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [submenu, setSubmenu] = useState<{ id: Submenu; anchor: { top: number; bottom: number; left: number; right: number } } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [left, setLeft] = useState(anchor.left);
  const [subLeft, setSubLeft] = useState<number | null>(null);
  const baseId = useId();
  const flat = CARD_MENU_GROUPS.flat()
    .map((id) => entries.find((e) => e.id === id))
    .filter((e): e is CardActionEntry => !!e);

  const dismiss = useCallback(() => onClose("outside"), [onClose]);
  const top = useAnchoredPlacement(panelRef, { anchor, onResize: dismiss, onOutsideScroll: dismiss });
  const subTop = useAnchoredPlacement(subRef, {
    anchor: submenu ? { top: submenu.anchor.top, bottom: submenu.anchor.bottom } : null,
    mode: "side",
  });

  // Clamp horizontally to the viewport once the width is known.
  useLayoutEffect(() => {
    const width = panelRef.current?.offsetWidth ?? 0;
    setLeft(Math.max(POPOVER_VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - POPOVER_VIEWPORT_MARGIN - width)));
  }, [anchor.left]);
  // A submenu opens to the right of its item, or to the left when there is no room.
  useLayoutEffect(() => {
    if (!submenu) { setSubLeft(null); return; }
    const width = subRef.current?.offsetWidth ?? 0;
    const right = submenu.anchor.right + 2;
    setSubLeft(right + width <= window.innerWidth - POPOVER_VIEWPORT_MARGIN ? right : Math.max(POPOVER_VIEWPORT_MARGIN, submenu.anchor.left - 2 - width));
  }, [submenu]);

  // Focus only after placement: browsers ignore focus() on a hidden element.
  useEffect(() => {
    if (top === null) return;
    itemRefs.current[0]?.focus();
  }, [top]);
  useEffect(() => {
    if (subTop === null || subLeft === null) return;
    subItemRefs.current[0]?.focus();
  }, [subTop, subLeft]);

  // Outside press closes. Capture phase, so it runs before whatever was pressed.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      onClose("outside");
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // Focus moving to something outside (the ⌘K palette opening, a click on a
  // focusable control) closes it too; moves between its own items do not.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && !root.contains(next)) onClose("outside");
    };
    root.addEventListener("focusout", onFocusOut);
    return () => root.removeEventListener("focusout", onFocusOut);
  }, [onClose]);

  const parentIndex = (id: Submenu) => flat.findIndex((e) => e.id === id);
  const closeSubmenu = () => {
    if (!submenu) return;
    const idx = parentIndex(submenu.id);
    setSubmenu(null);
    itemRefs.current[idx]?.focus();
  };

  // One entry for both levels: a submenu closes first, then the menu.
  useEscapeStack(() => {
    if (submenu) { closeSubmenu(); return; }
    onClose("escape");
  }, CARD_MENU_ESCAPE_PRIORITY);

  const subItems = (id: Submenu): SubItem[] => {
    if (id === "move") return columns.map((c) => ({ key: `col-${c.id}`, label: c.name, value: c.id, dot: c.color }));
    if (id === "assign") {
      return [
        { key: "unassign", label: "Unassign", value: null, italic: true },
        // Same list as the toolbar's Assign menu: every member who can hold a card.
        ...members.filter((m) => m.role !== "viewer").map((m) => ({ key: `user-${m.user.id}`, label: userDisplayName(m.user), value: m.user.id })),
      ];
    }
    return PRIORITY_CHOICES.map((p: Priority) => ({ key: `prio-${p}`, label: p.charAt(0).toUpperCase() + p.slice(1), value: p, dot: PRIORITY_COLORS[p] }));
  };

  const openSubmenu = (id: Submenu, idx: number) => {
    const rect = itemRefs.current[idx]?.getBoundingClientRect();
    if (!rect) return;
    setSubmenu({ id, anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } });
  };

  const activate = (entry: CardActionEntry, idx: number) => {
    if (!entry.enabled) {
      // Re-announce: a trailing no-break space makes the text differ each time.
      setAnnounce((prev) => (prev === entry.reason ? `${entry.reason}\u00a0` : entry.reason ?? ""));
      return;
    }
    if (SUBMENU_IDS.has(entry.id)) { openSubmenu(entry.id as Submenu, idx); return; }
    onAction(entry.id);
  };

  const roving = (refs: (HTMLButtonElement | null)[], count: number, idx: number, e: React.KeyboardEvent, labels: string[]) => {
    const go = (i: number) => { e.preventDefault(); refs[(i + count) % count]?.focus(); return true; };
    if (e.key === "ArrowDown") return go(idx + 1);
    if (e.key === "ArrowUp") return go(idx - 1);
    if (e.key === "Home") return go(0);
    if (e.key === "End") return go(count - 1);
    if (e.key === "Tab") { onClose("tab"); return true; }
    // Typeahead: letters act only while the menu has focus, never globally.
    if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      for (let step = 1; step <= count; step++) {
        const i = (idx + step) % count;
        if (labels[i]?.toLowerCase().startsWith(ch)) { go(i); break; }
      }
      e.preventDefault();
      return true;
    }
    return false;
  };

  const onItemKeyDown = (e: React.KeyboardEvent, entry: CardActionEntry, idx: number) => {
    if (roving(itemRefs.current, flat.length, idx, e, flat.map((f) => f.label))) return;
    if (e.key === "ArrowRight" && SUBMENU_IDS.has(entry.id)) {
      e.preventDefault();
      if (entry.enabled) openSubmenu(entry.id as Submenu, idx);
      else activate(entry, idx);
    }
  };

  const currentSubItems = submenu ? subItems(submenu.id) : [];
  const onSubKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); closeSubmenu(); return; }
    roving(subItemRefs.current, currentSubItems.length, idx, e, currentSubItems.map((s) => s.label));
  };

  let rendered = 0;
  const groups = CARD_MENU_GROUPS
    .map((ids) => flat.filter((e) => ids.includes(e.id)))
    .filter((g) => g.length > 0);

  return createPortal(
    // Keys pressed inside the menu are the menu's: a typeahead "s" must not
    // also reach BoardView's document-level bare-letter shortcuts (Summary
    // view). Escape stays on the stack's document listener, and modifier
    // chords (⌘K) still reach their owners.
    <div ref={rootRef} onKeyDown={(e) => { if (e.key !== "Escape" && !e.metaKey && !e.ctrlKey) e.stopPropagation(); }}>
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        data-testid="card-context-menu"
        className="fixed z-[45] min-w-[13rem] max-w-[18rem] bg-surface border border-line-strong rounded-lg shadow-lg py-1 overflow-y-auto"
        style={{
          top: top ?? 0, left,
          maxHeight: `calc(100vh - ${POPOVER_VIEWPORT_MARGIN * 2}px)`,
          visibility: top === null ? "hidden" : undefined,
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {header && (
          <div role="presentation" className="px-3 pt-1 pb-1.5 text-xs font-medium text-fg-tertiary select-none">{header}</div>
        )}
        {groups.map((group, gi) => (
          <div key={group[0].id} role="group">
            {gi > 0 && (
              <div role="separator" className="mx-4 my-1">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>
            )}
            {group.map((entry) => {
              const idx = rendered++;
              const danger = entry.id === "delete";
              const hasSub = SUBMENU_IDS.has(entry.id);
              const reasonId = `${baseId}-reason-${entry.id}`;
              return (
                <button
                  key={entry.id}
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={entry.enabled ? undefined : true}
                  aria-describedby={entry.enabled ? undefined : reasonId}
                  aria-haspopup={hasSub ? "menu" : undefined}
                  aria-expanded={hasSub ? submenu?.id === entry.id : undefined}
                  data-action={entry.id}
                  onClick={() => activate(entry, idx)}
                  onKeyDown={(e) => onItemKeyDown(e, entry, idx)}
                  onMouseEnter={() => {
                    // A pointer resting on another item closes an open submenu.
                    if (submenu && submenu.id !== entry.id) setSubmenu(null);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm transition flex flex-col ${
                    entry.enabled ? "hover:bg-surface-hover" : "cursor-not-allowed"
                  } ${danger ? MENU_ITEM_FOCUS_RING_DANGER : MENU_ITEM_FOCUS_RING}`}
                >
                  <span className={`flex items-center gap-3 ${entry.enabled ? (danger ? "text-danger" : "text-fg-secondary") : "text-fg-tertiary opacity-70"}`}>
                    <span className="flex-1 truncate">{entry.label}</span>
                    {entry.id === "open" && (
                      <kbd className="text-xs px-1.5 py-0.5 bg-sunken border border-line rounded text-fg-muted shrink-0">Enter</kbd>
                    )}
                    {hasSub && <span aria-hidden="true" className="text-fg-tertiary shrink-0">▸</span>}
                  </span>
                  {!entry.enabled && entry.reason && (
                    <span id={reasonId} className="text-xs text-fg-tertiary mt-0.5">{entry.reason}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {submenu && (
        <div
          ref={subRef}
          role="menu"
          aria-label={submenu.id === "move" ? "Move to column" : submenu.id === "assign" ? "Assign to" : "Set priority"}
          data-testid="card-context-submenu"
          className="fixed z-[46] min-w-[10rem] max-w-[16rem] bg-surface border border-line-strong rounded-lg shadow-lg py-1 overflow-y-auto"
          style={{
            top: subTop ?? 0, left: subLeft ?? 0,
            maxHeight: `calc(100vh - ${POPOVER_VIEWPORT_MARGIN * 2}px)`,
            visibility: subTop === null || subLeft === null ? "hidden" : undefined,
          }}
        >
          {currentSubItems.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => { subItemRefs.current[i] = el; }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => onAction(submenu.id, item.value)}
              onKeyDown={(e) => onSubKeyDown(e, i)}
              className={`w-full text-left px-3 py-1.5 text-sm transition hover:bg-surface-hover flex items-center gap-2 ${
                item.italic ? "italic text-fg-tertiary" : "text-fg-secondary"
              } ${MENU_ITEM_FOCUS_RING}`}
            >
              {item.dot && <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: item.dot }} />}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Always mounted so a disabled item's re-announced reason is read. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announce}</p>
    </div>,
    document.body,
  );
}
