import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useNavigate } from "react-router-dom";
import type { Board } from "../../types";
import { StatusDot } from "../Page";
import { useShellNavData } from "../../contexts/ShellNavContext";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useIsPhoneViewport } from "../../hooks/useIsPhoneViewport";
import { formatShortcut } from "../../utils/platform";
import { buildSwitcherSections } from "./shellNavModel";
import { ChevronDownIcon } from "./shellIcons";

/**
 * The board page's `h1` button and its "Switch board" popover (#2473). The
 * popover is a dialog holding a "Find a board" combobox that controls a
 * listbox; on phones the same list opens as a bottom sheet.
 */
export default function BoardSwitcher({ board }: { board: Pick<Board, "id" | "name" | "group"> & { group_name?: string | null } }) {
  const data = useShellNavData();
  const navigate = useNavigate();
  const isPhone = useIsPhoneViewport();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  // The panel is portaled out of the page's h1 (a heading must not hold a
  // listbox or a field), so it is placed from the trigger's rect on open.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const openPanel = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    setAnchor(r ? { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 368)) } : { top: 56, left: 8 });
    setOpen(true);
  };
  // The phone sheet dims the page, so it is modal: trap Tab, restore to the trigger.
  useFocusTrap(panelRef, open && isPhone, () => triggerRef.current);

  const sections = useMemo(() => buildSwitcherSections(board, data, query), [board, data, query]);
  const flat = sections.flatMap((s) => s.options);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };

  useEscapeStack(() => {
    if (!open) return false;
    close();
  }, 25);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  const go = (id: number) => {
    close(false);
    if (id !== board.id) void navigate(`/boards/${id}`);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = flat[active]; if (o) go(o.id); }
    else if (e.key === "Tab" && !isPhone) { close(false); }
  };

  const palette = formatShortcut({ mod: true, key: "K" });
  // Each section's first index in `flat`, for the active-option highlight.
  const offsets = sections.map((_, si) => sections.slice(0, si).reduce((sum, s) => sum + s.options.length, 0));

  return (
    <span className="relative inline-flex min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openPanel())}
        aria-label={`${board.name}, switch board`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-1 min-w-0 max-w-[18rem] h-9 max-sm:h-11 px-1.5 rounded-md text-sm font-semibold text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        <span className="truncate">{board.name}</span>
        <ChevronDownIcon className="w-4 h-4 text-fg-tertiary" />
      </button>
      {open && createPortal(
        <>
          {isPhone && <div className="fixed inset-0 z-40 bg-backdrop/60" aria-hidden="true" />}
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Switch board"
            aria-modal={isPhone ? true : undefined}
            data-variant={isPhone ? "sheet" : "popover"}
            style={isPhone || !anchor ? undefined : { top: anchor.top, left: anchor.left }}
            className={`z-50 bg-surface border border-line-strong shadow-xl flex flex-col font-normal ${
              isPhone
                ? "fixed inset-x-0 bottom-0 max-h-[80vh] rounded-t-xl pb-[env(safe-area-inset-bottom)]"
                : "fixed w-[360px] max-h-[28rem] rounded-lg"
            }`}
          >
            <div className="p-2 border-b border-line">
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label="Find a board"
                placeholder="Find a board"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={flat[active] ? `${baseId}-opt-${flat[active].id}` : undefined}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                className="w-full h-9 max-sm:h-11 px-3 text-sm rounded-md bg-sunken border border-line-strong text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              />
            </div>
            <div id={listId} role="listbox" aria-label="Boards" className="flex-1 overflow-y-auto py-1">
              {sections.map((s, si) => (
                <div key={s.title} role="group" aria-label={s.title}>
                  <div role="presentation" className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-fg-tertiary">{s.title}</div>
                  {s.options.map((o, oi) => {
                    const i = offsets[si] + oi;
                    const current = o.id === board.id;
                    return (
                      // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- SUPPRESSED-UNTIL(#2526): fixed in sibling MR
                      <div
                        key={o.id}
                        id={`${baseId}-opt-${o.id}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={current}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => go(o.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(o.id); }
                        }}
                        onMouseEnter={() => setActive(i)}
                        className={`flex items-center gap-2.5 min-h-9 max-sm:min-h-11 px-3 mx-1 rounded-md text-sm cursor-pointer ${
                          i === active ? "bg-surface-hover text-fg" : "text-fg-secondary"
                        }`}
                      >
                        <StatusDot tone={o.tone} />
                        <span className={`flex-1 truncate${current ? " font-medium text-fg" : ""}`}>{o.name}</span>
                        {current && <span className="text-xs text-fg-tertiary">Current</span>}
                        {!current && o.ago && <span className="text-xs text-fg-tertiary">{o.ago}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
              {flat.length === 0 && query.trim() === "" && (
                <p className="px-3 py-4 text-sm text-fg-secondary">{data.loading ? "Loading boards…" : "No other boards yet."}</p>
              )}
              {flat.length === 0 && query.trim() !== "" && (
                <p className="px-3 py-4 text-sm text-fg-secondary">
                  No board named &ldquo;{query.trim()}&rdquo;. Press {palette} to search cards and actions too.
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-line text-xs text-fg-tertiary">
              <span className="max-sm:hidden">↑↓ move · Enter open · Esc close</span>
              <span>{palette} for everything</span>
            </div>
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
