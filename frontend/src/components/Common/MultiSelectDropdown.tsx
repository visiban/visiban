import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeStack } from "../../hooks/useEscapeStack";

export interface MultiSelectDropdownProps {
  /** Field name: the trigger's and listbox's accessible name, and the search label. */
  label: string;
  /** The current, selectable options, in display order. */
  options: string[];
  /** The committed selection. Entries not in `options` are shown as orphans. */
  selected: string[];
  /**
   * Called once when the menu closes with a changed selection (compared as a
   * set — order is the caller's to canonicalize). Return the save promise to
   * get revert-on-failure plus `saveErrorMessage`; a form surface that only
   * updates local state may return nothing.
   */
  onCommit: (selected: string[]) => void | Promise<void>;
  disabled?: boolean;
  /**
   * Escape stack priority. Must be above whatever surface hosts the control:
   * above 30 inside `CardDetail`, above 40 inside a `ModalWrapper`. See the
   * allocation lists in frontend/CLAUDE.md.
   */
  escapePriority: number;
  /** Heading for selected entries that are not in `options`. */
  orphanLabel?: string;
  /** Shown under the trigger when the promise returned by `onCommit` rejects. */
  saveErrorMessage?: string;
  /** Renders the selection inside the trigger. Defaults to comma-joined text. */
  renderValue?: (selected: string[]) => ReactNode;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `max-h-60` — the menu's height cap, used to decide whether to open upward. */
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;

/**
 * Tab out of the menu: forward moves to the focusable element after `from`
 * (the trigger) in document order, skipping the portaled menu itself;
 * Shift+Tab lands back on the trigger.
 */
function focusSibling(from: HTMLElement, backwards: boolean, skip: HTMLElement | null) {
  if (backwards) { from.focus(); return; }
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !skip?.contains(el),
  );
  const next = all[all.indexOf(from) + 1];
  (next ?? from).focus();
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
}

type Anchor = { left: number; minWidth: number } & ({ top: number } | { bottom: number });

/**
 * A searchable checklist that commits **once, on close** (#1391) — the third
 * `Common` dropdown primitive, next to `SingleSelectDropdown` and
 * `CheckboxDropdown`.
 *
 * Use `CheckboxDropdown` for a filter that applies on every click; use this
 * for a *value editor* where one change is usually several clicks and a save
 * (request, broadcast, change signal) per click would be noise. Closing —
 * Done, Escape, Tab, a click outside, or a scroll/resize of the page — commits
 * the whole set once, and only when it changed.
 *
 * Selected entries missing from `options` ("orphans", e.g. a renamed choice)
 * are listed under `orphanLabel`, checked, so they can be kept or dropped but
 * never silently lost.
 *
 * The menu is portaled to `document.body` and anchored with `position: fixed`
 * (same approach as `SingleSelectDropdown`'s `portalMenu`); it opens upward
 * when there is not room below, is clamped to the viewport horizontally, and
 * closes on any scroll or resize outside itself rather than drifting away
 * from its trigger.
 */
export default function MultiSelectDropdown({
  label, options, selected, onCommit, disabled, escapePriority,
  orphanLabel = "No longer a choice",
  saveErrorMessage = "Couldn't save. Try again.",
  renderValue,
  placeholder = "— No value —",
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // The last selection handed to onCommit, shown until `selected` catches up
  // (or the save fails), so the trigger does not flash the old selection.
  const [pending, setPending] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const listboxId = `${id}-listbox`;

  // `selected` is usually a freshly parsed array each render; key the reset
  // on its content, not its identity.
  const selectedKey = selected.join("\u0000");
  useEffect(() => { setPending(null); }, [selectedKey]);

  const current = pending ?? selected;

  const q = query.trim().toLowerCase();
  const matches = (entry: string) => q === "" || entry.toLowerCase().includes(q);
  const visibleOptions = options.filter(matches);
  const visibleOrphans = orphans.filter(matches);
  const all = [...visibleOptions, ...visibleOrphans];
  const optionId = (i: number) => `${id}-opt-${i}`;

  const openMenu = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const minWidth = Math.max(rect.width, 200);
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - minWidth - VIEWPORT_MARGIN),
      );
      const below = window.innerHeight - rect.bottom;
      const flip = below < MENU_MAX_HEIGHT + VIEWPORT_MARGIN && rect.top > below;
      setAnchor(
        flip
          ? { left, minWidth, bottom: window.innerHeight - rect.top + 4 }
          : { left, minWidth, top: rect.bottom + 4 },
      );
    }
    setDraft(current);
    setOrphans(current.filter((entry) => !options.includes(entry)));
    setQuery("");
    setActive(0);
    setError(null);
    setOpen(true);
  };

  const closeMenu = () => {
    setOpen(false);
    setAnchor(null);
    if (sameSet(draft, current)) return;
    setPending(draft);
    const result = onCommit(draft);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {
        setPending(null);
        setError(saveErrorMessage);
      });
    }
  };

  // Listeners below always call this render's closeMenu (it reads `draft`).
  const closeRef = useRef(closeMenu);
  closeRef.current = closeMenu;
  const closeFromOutside = useCallback((e: Event) => {
    const target = e.target as Node | null;
    if (target && (menuRef.current?.contains(target) || wrapperRef.current?.contains(target))) return;
    closeRef.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 0);
    const onResize = () => closeRef.current();
    document.addEventListener("mousedown", closeFromOutside);
    // Capture phase: a scroll of any ancestor (not just the window) moves the
    // trigger out from under the fixed-position menu. Scrolling the menu's own
    // list is ignored by closeFromOutside.
    document.addEventListener("scroll", closeFromOutside, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("scroll", closeFromOutside, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, closeFromOutside]);

  // Keep the keyboard-highlighted option visible as the arrows move it.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId derives only from the stable useId value
  }, [open, active]);

  useEscapeStack(() => {
    if (!open) return false;
    // A first Escape with a search typed clears the search; the next closes.
    if (query !== "") { setQuery(""); setActive(0); return; }
    closeMenu();
    triggerRef.current?.focus();
  }, escapePriority);

  const toggle = (entry: string) => {
    setDraft((d) => (d.includes(entry) ? d.filter((x) => x !== entry) : [...d, entry]));
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(all.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || (e.key === " " && query === "")) {
      // Space types into a non-empty search; with no search it toggles.
      // Enter never submits an enclosing form.
      e.preventDefault();
      const entry = all[active];
      if (entry !== undefined) toggle(entry);
    } else if (e.key === "Tab") {
      e.preventDefault();
      closeMenu();
      if (triggerRef.current) focusSibling(triggerRef.current, e.shiftKey, menuRef.current);
    }
  };

  const renderOption = (entry: string, i: number, orphan: boolean) => {
    const isSelected = draft.includes(entry);
    const isActive = i === active;
    return (
      <div
        key={`${orphan ? "o" : "c"}:${entry}`}
        id={optionId(i)}
        role="option"
        aria-selected={isSelected}
        // mousedown, not click, with preventDefault: focus stays in the search
        // input so the keyboard map keeps working after a mouse toggle.
        onMouseDown={(e) => { e.preventDefault(); setActive(i); toggle(entry); }}
        // scroll-m*: keep a scrolled-to row clear of the sticky search and footer.
        className={[
          "flex items-center gap-2 px-3 py-2 text-sm cursor-pointer scroll-mt-14 scroll-mb-12",
          isSelected ? "bg-primary-emphasis/20" : "hover:bg-surface-hover",
          isActive ? "ring-2 ring-inset ring-primary-emphasis" : "",
          orphan ? "text-fg-muted" : "text-fg-secondary",
        ].join(" ")}
      >
        <input
          type="checkbox"
          checked={isSelected}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          className="rounded accent-primary pointer-events-none shrink-0"
        />
        <span className="truncate" title={entry}>{entry}</span>
      </div>
    );
  };

  const menu = (
    <div
      ref={menuRef}
      style={anchor ? { position: "fixed", ...anchor } : undefined}
      className="z-50 bg-surface shadow-xl border border-line rounded max-h-60 overflow-y-auto flex flex-col"
    >
      <div className="sticky top-0 z-10 bg-surface p-1.5 border-b border-line">
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          value={query}
          placeholder="Type to filter"
          aria-label={`Filter ${label} choices`}
          aria-controls={listboxId}
          aria-activedescendant={all.length > 0 ? optionId(active) : undefined}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onSearchKeyDown}
          className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary placeholder-fg-muted w-full focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
        />
      </div>
      {all.length === 0 && (
        <p className="px-3 py-2 text-sm text-fg-muted italic">No matching choices</p>
      )}
      <div id={listboxId} role="listbox" aria-multiselectable="true" aria-label={label} className="py-1 flex-1">
        {visibleOptions.map((entry, i) => renderOption(entry, i, false))}
        {visibleOrphans.length > 0 && (
          <div role="group" aria-label={orphanLabel}>
            <div role="presentation" className="mx-3 mt-1 pt-1.5 pb-1 border-t border-line text-xs text-fg-muted">
              {orphanLabel}
            </div>
            {visibleOrphans.map((entry, j) => renderOption(entry, visibleOptions.length + j, true))}
          </div>
        )}
      </div>
      <div className="sticky bottom-0 z-10 bg-surface border-t border-line px-3 py-1.5 flex items-center justify-between gap-3">
        <span role="status" className="text-xs text-fg-muted">{draft.length} selected</span>
        <button
          type="button"
          onClick={() => { closeMenu(); triggerRef.current?.focus(); }}
          className="text-sm text-info hover:underline rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Done
        </button>
      </div>
    </div>
  );

  return (
    <div ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") { e.preventDefault(); openMenu(); }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`${label}: ${current.length > 0 ? current.join(", ") : "No value"}`}
        className={`bg-surface border rounded px-2 py-1 text-sm w-full flex items-center justify-between gap-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-60 ${
          open ? "border-primary-soft" : "border-line-strong hover:border-line-emphasis"
        }`}
      >
        {current.length > 0 ? (
          renderValue ? renderValue(current) : <span className="text-fg-secondary truncate">{current.join(", ")}</span>
        ) : (
          <span className="text-fg-muted">{placeholder}</span>
        )}
        <svg className="w-3 h-3 text-fg-muted shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger mt-1">{error}</p>
      )}
      {open && createPortal(menu, document.body)}
    </div>
  );
}
