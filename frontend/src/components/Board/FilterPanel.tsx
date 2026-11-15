import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardFull, BoardUser, CustomFieldDefinition, SavedFilter } from "../../types";
import { userDisplayName } from "../../types";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import { POPOVER_VIEWPORT_MARGIN, visibleMaxHeight } from "../../hooks/useAnchoredPlacement";
import { isCardBlocked } from "../../utils/blockedState";
import { formatCustomFieldValue } from "../../utils/customFieldValue";
import { isLaneFilterActive, laneFilterFields, summarizeLaneFilter } from "../../utils/laneFilter";
import Tooltip from "../Common/Tooltip";
import ActiveMark from "../Common/ActiveMark";
import { MENU_ITEM_FOCUS_RING } from "../Common/menuItemFocusRing";
import { DUE_DATE_OPTIONS, PRIORITY_OPTIONS, emptyCustomFieldFilterValue, isCustomFieldFilterActive } from "./filterOptions";
import type { CustomFieldFilterValue, FilterState } from "./FilterBar";

interface Props {
  board: BoardFull;
  filters: FilterState;
  /** The same handler FilterBar gets: every edit clears the active saved-filter preset. */
  onChange: (next: FilterState) => void;
  activeCount: number;
  icon: React.ReactNode;
  savedFilters: SavedFilter[];
  activeFilterId: number | null;
  onLoadSaved: (saved: SavedFilter) => void;
  /** Whether the full filter bar (search, scope, My cards, Lanes) is showing under the toolbar. */
  filterBarShown: boolean;
  onToggleFilterBar: () => void;
  /** Opens the filter bar and then the Lanes popover (#2205). */
  onOpenLaneFilters: () => void;
  userDateFormat?: string;
}

const PANEL_WIDTH = 360;
const FOCUSABLE = 'button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

type RowId = "assignee" | "label" | "priority" | "dueDate" | "blocked" | "lanes" | `cf:${number}`;
interface Row {
  id: RowId;
  label: string;
  /** Current value text, or null when the row is not filtering. */
  value: string | null;
}

/**
 * The board toolbar's Filter button and panel (#2301): a "Find a field" input,
 * one row per filterable field showing its value or "Any", and the saved
 * filters at the bottom. It is a presentation over the same FilterState that
 * FilterBar edits, so URL sync, persistence and saved filters are untouched.
 * A row expands in place to its editor (native checkboxes, radios and inputs,
 * so Tab, arrows and Space need no custom key handling). The Lanes row hands
 * off to the existing Lanes popover (#2205) rather than duplicating it.
 */
export default function FilterPanel({
  board, filters, onChange, activeCount, icon, savedFilters, activeFilterId, onLoadSaved,
  filterBarShown, onToggleFilterBar, onOpenLaneFilters, userDateFormat = "MM/DD/YYYY",
}: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<RowId | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const close = () => {
    setOpen(false);
    setAnchor(null);
    setQuery("");
    setExpanded(null);
  };
  // Popover tier 25, like the View menu.
  useDropdownEscape(open, close, triggerRef, 25);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // The panel is portaled to <body>: move focus to Find a field on open so Tab from the button does not skip it.
  useEffect(() => {
    if (open && anchor) findRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once per open
  }, [open, anchor !== null]);

  const focusables = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const items = focusables();
    const edge = e.shiftKey ? items[0] : items[items.length - 1];
    if (items.length > 0 && document.activeElement !== edge) return;
    close();
    triggerRef.current?.focus();
    if (e.shiftKey) e.preventDefault();
  };
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      focusables()[0]?.focus();
    }
  };
  const toggle = () => {
    if (open) return close();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        top: rect.bottom + 4,
        right: Math.max(POPOVER_VIEWPORT_MARGIN, Math.min(window.innerWidth - rect.right, window.innerWidth - PANEL_WIDTH - POPOVER_VIEWPORT_MARGIN)),
      });
    }
    setOpen(true);
  };

  // Assignee choices: board members plus any assignee on a card who is not in
  // the member list (same rule as FilterBar, #1714).
  const assigneeUsers = useMemo(() => {
    const m = new Map<number, BoardUser>(board.members.map((mem) => [mem.user.id, mem.user]));
    for (const c of board.cards) if (c.assignee && !m.has(c.assignee.id)) m.set(c.assignee.id, c.assignee);
    return [...m.values()];
  }, [board.members, board.cards]);
  const blockedCount = useMemo(() => board.cards.filter(isCardBlocked).length, [board.cards]);
  const isBoardAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  const laneFields = useMemo(
    () => laneFilterFields(board.swimlane_custom_field_definitions ?? [], isBoardAdmin),
    [board.swimlane_custom_field_definitions, isBoardAdmin],
  );

  const customDefs = useMemo(
    () => [...board.custom_field_definitions].sort((a, b) => a.position - b.position),
    [board.custom_field_definitions],
  );

  const rows: Row[] = [];
  rows.push({
    id: "assignee",
    label: "Assignee",
    value: filters.assigneeIds.length
      ? filters.assigneeIds.map((i) => (i === -1 ? "Unassigned" : assigneeUsers.find((u) => u.id === i) ? userDisplayName(assigneeUsers.find((u) => u.id === i)!) : "")).filter(Boolean).join(", ") || null
      : null,
  });
  rows.push({
    id: "label",
    label: "Label",
    value: filters.labelIds.length
      ? filters.labelIds.map((i) => board.labels.find((l) => l.id === i)?.name ?? "").filter(Boolean).join(", ") || null
      : null,
  });
  rows.push({
    id: "priority",
    label: "Priority",
    value: filters.priorities.length ? PRIORITY_OPTIONS.filter((o) => filters.priorities.includes(o.value)).map((o) => o.label).join(", ") : null,
  });
  rows.push({ id: "dueDate", label: "Due date", value: DUE_DATE_OPTIONS.find((o) => o.value === filters.dueDate)?.label ?? null });
  rows.push({ id: "blocked", label: "Blocked", value: filters.blockedOnly ? "Blocked only" : null });
  if (laneFields.length > 0) {
    const n = summarizeLaneFilter(filters.laneFilter, laneFields, (_f, raw) => raw).completeCount;
    rows.push({ id: "lanes", label: "Lanes", value: isLaneFilterActive(filters.laneFilter) ? `${n} ${n === 1 ? "rule" : "rules"}` : null });
  }
  for (const def of customDefs) {
    const v = filters.customFields[def.id];
    const active = v && isCustomFieldFilterActive(v);
    rows.push({
      id: `cf:${def.id}`,
      label: def.name,
      value: active
        ? v.kind === "choice" || v.kind === "multi_choice" ? v.values.join(", ") : v.kind === "text" ? v.query : formatCustomFieldValue(def, v.equals, userDateFormat)
        : null,
    });
  }

  const needle = query.trim().toLowerCase();
  const visibleRows = needle ? rows.filter((r) => r.label.toLowerCase().includes(needle)) : rows;

  const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const checkbox = (key: string, label: string, checked: boolean, onToggle: () => void, dot?: string) => (
    <label key={key} className={`flex items-center gap-2 px-2 py-1 rounded text-sm text-fg cursor-pointer hover:bg-surface-hover focus-within:ring-2 focus-within:ring-primary-emphasis`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="accent-primary" />
      {dot && <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: dot }} />}
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );

  const setCustom = (defId: number, v: CustomFieldFilterValue) =>
    onChange({ ...filters, customFields: { ...filters.customFields, [defId]: v } });

  const customEditor = (def: CustomFieldDefinition) => {
    const v = filters.customFields[def.id] ?? emptyCustomFieldFilterValue(def);
    const inputClass = "w-full bg-surface border border-line-strong rounded px-2 py-1 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
    if (v.kind === "text") {
      return <input type="text" aria-label={def.name} value={v.query} placeholder={`${def.name} contains…`} onChange={(e) => setCustom(def.id, { kind: "text", query: e.target.value })} className={inputClass} />;
    }
    if (v.kind === "number" || v.kind === "date") {
      return <input type={v.kind === "number" ? "number" : "date"} aria-label={def.name} value={v.equals} onChange={(e) => setCustom(def.id, { kind: v.kind as "number" | "date", equals: e.target.value })} className={inputClass} />;
    }
    if (v.kind !== "choice" && v.kind !== "multi_choice") return null;
    const kind = v.kind;
    const values = v.values;
    const choices = def.field_type === "checkbox" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : def.choices.map((c) => ({ value: c, label: c }));
    return (
      <div role="group" aria-label={def.name}>
        {choices.map((c) => checkbox(c.value, c.label, values.includes(c.value), () => setCustom(def.id, { kind, values: toggleIn(values, c.value) })))}
      </div>
    );
  };

  const editor = (row: Row) => {
    switch (row.id) {
      case "assignee":
        return (
          <div role="group" aria-label="Assignee">
            {checkbox("-1", "Unassigned", filters.assigneeIds.includes(-1), () => onChange({ ...filters, assigneeIds: toggleIn(filters.assigneeIds, -1) }))}
            {assigneeUsers.map((u) => checkbox(String(u.id), userDisplayName(u), filters.assigneeIds.includes(u.id), () => onChange({ ...filters, assigneeIds: toggleIn(filters.assigneeIds, u.id) })))}
          </div>
        );
      case "label":
        return (
          <div role="group" aria-label="Label">
            {board.labels.length === 0 && <p className="px-2 py-1 text-sm text-fg-secondary">No labels on this board.</p>}
            {board.labels.map((l) => checkbox(String(l.id), l.name, filters.labelIds.includes(l.id), () => onChange({ ...filters, labelIds: toggleIn(filters.labelIds, l.id) }), l.color))}
          </div>
        );
      case "priority":
        return (
          <div role="group" aria-label="Priority">
            {PRIORITY_OPTIONS.map((o) => checkbox(o.value, o.label, filters.priorities.includes(o.value), () => onChange({ ...filters, priorities: toggleIn(filters.priorities, o.value) }), o.color))}
          </div>
        );
      case "dueDate":
        return (
          <div role="radiogroup" aria-label="Due date">
            {[{ value: null, label: "Any" }, ...DUE_DATE_OPTIONS].map((o) => (
              <label key={o.value ?? "any"} className="flex items-center gap-2 px-2 py-1 rounded text-sm text-fg cursor-pointer hover:bg-surface-hover focus-within:ring-2 focus-within:ring-primary-emphasis">
                <input type="radio" name={`${id}-due`} checked={filters.dueDate === o.value} onChange={() => onChange({ ...filters, dueDate: o.value })} className="accent-primary" />
                {o.label}
              </label>
            ))}
          </div>
        );
      case "blocked":
        return <div role="group" aria-label="Blocked">{checkbox("blocked", `Blocked only (${blockedCount})`, !!filters.blockedOnly, () => onChange({ ...filters, blockedOnly: !filters.blockedOnly }))}</div>;
      default: {
        const def = customDefs.find((d) => `cf:${d.id}` === row.id);
        return def ? customEditor(def) : null;
      }
    }
  };

  const panel = open && anchor ? (
    <div
      ref={panelRef}
      id={`${id}-panel`}
      role="dialog"
      aria-label="Filter"
      data-testid="filter-panel"
      onKeyDown={onPanelKeyDown}
      style={{ position: "fixed", top: anchor.top, right: anchor.right, width: PANEL_WIDTH, maxWidth: `calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px)`, maxHeight: visibleMaxHeight(2 * POPOVER_VIEWPORT_MARGIN) }}
      className="z-50 bg-surface border border-line-strong rounded-lg shadow-lg p-3 space-y-2 overflow-y-auto"
    >
      <h2 className="text-sm font-semibold text-fg">Filter</h2>
      <input
        ref={findRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a field"
        aria-label="Find a field"
        className="w-full bg-sunken border border-line-strong rounded px-2.5 py-2 text-sm text-fg placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      />
      <ul aria-label="Filterable fields" className="space-y-0.5">
        {visibleRows.map((row) => {
          const active = row.value !== null;
          const isOpen = expanded === row.id;
          const onRow = () => {
            if (row.id === "lanes") {
              close();
              onOpenLaneFilters();
              return;
            }
            setExpanded(isOpen ? null : row.id);
          };
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={onRow}
                aria-expanded={row.id === "lanes" ? undefined : isOpen}
                aria-haspopup={row.id === "lanes" ? "dialog" : undefined}
                className={`w-full flex items-center justify-between gap-3 px-2 py-2 rounded text-sm text-left transition ${MENU_ITEM_FOCUS_RING} ${active ? "bg-info/10 text-info-on-tint font-semibold" : "text-fg hover:bg-surface-hover"}`}
              >
                <span className="flex items-center gap-1.5 shrink-0"><ActiveMark active={active} testId="filter-row-mark" />{row.label}</span>
                <span className={`truncate text-right ${active ? "" : "text-fg-secondary font-normal"}`}>{row.value ?? "Any"}</span>
              </button>
              {isOpen && <div className="pl-2 pr-1 pb-1 max-h-48 overflow-y-auto">{editor(row)}</div>}
            </li>
          );
        })}
      </ul>
      {visibleRows.length === 0 && <p role="status" className="px-2 py-1 text-sm text-fg-secondary">No field matches "{query}".</p>}

      <div className="border-t border-line pt-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-secondary px-2 pb-1">Saved filters</h3>
        {savedFilters.length === 0 ? (
          <p className="px-2 py-1 text-sm text-fg-secondary">No saved filters yet.</p>
        ) : (
          <ul aria-label="Saved filters" className="space-y-0.5">
            {savedFilters.map((sf) => (
              <li key={sf.id}>
                <button
                  type="button"
                  aria-pressed={activeFilterId === sf.id}
                  onClick={() => { onLoadSaved(sf); close(); triggerRef.current?.focus(); }}
                  className={`w-full flex items-center gap-1.5 px-2 py-2 rounded text-sm text-left transition ${MENU_ITEM_FOCUS_RING} ${activeFilterId === sf.id ? "bg-info/10 text-info-on-tint font-semibold" : "text-fg hover:bg-surface-hover"}`}
                >
                  <ActiveMark active={activeFilterId === sf.id} testId="saved-filter-mark" />
                  <span className="truncate">{sf.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line pt-2">
        <button
          type="button"
          onClick={() => { close(); onToggleFilterBar(); }}
          className={`w-full text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded px-2 py-1.5 text-left ${MENU_ITEM_FOCUS_RING}`}
        >
          {filterBarShown ? "Hide filter bar" : "Show filter bar (search, saved filters, Lanes)"}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      {/* Tooltip clones its child and takes over the child's ref, so the trigger ref lives on the button inside this span. */}
      <Tooltip content="Filters">
        <span className="inline-flex shrink-0">
        <button
          ref={triggerRef}
          type="button"
          data-tour-step="filter"
          onClick={toggle}
          onKeyDown={onTriggerKeyDown}
          className={`inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded border transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${open || filterBarShown || activeCount > 0 ? "text-info-on-tint bg-info/10 border-info/40" : "text-fg border-line-strong hover:bg-surface-hover"}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? `${id}-panel` : undefined}
          aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
        >
          {icon}
          Filter
          {activeCount > 0 && (
            <span className="bg-primary text-on-primary rounded-full px-1.5 text-xs font-medium leading-5">{activeCount}</span>
          )}
        </button>
        </span>
      </Tooltip>
      {panel && createPortal(panel, document.body)}
    </>
  );
}
