import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardFull, BoardUser, CustomFieldDefinition, SavedFilter } from "../../types";
import { userDisplayName } from "../../types";
import { POPOVER_VIEWPORT_MARGIN, visibleMaxHeight } from "../../hooks/useAnchoredPlacement";
import { isCardBlocked } from "../../utils/blockedState";
import { parentFilterAvailable, parentFilterLabel, parentFilterOptions, type ParentFilter } from "../../utils/parentFilter";
import { choiceColor, explicitChoiceColor, formatCustomFieldValue } from "../../utils/customFieldValue";
import { choiceColorBase } from "../../constants/choiceColors";
import { isLaneBuiltinField, isLaneFilterActive, laneFilterAvailable, laneFilterFields, summarizeLaneFilter } from "../../utils/laneFilter";
import Tooltip from "../Common/Tooltip";
import ActiveMark from "../Common/ActiveMark";
import { MENU_ITEM_FOCUS_RING } from "../Common/menuItemFocusRing";
import { stageSubColumns } from "../../utils/stages";
import { DUE_DATE_OPTIONS, TRACK_STATE_OPTIONS, PRIORITY_OPTIONS, emptyCustomFieldFilterValue, isCustomFieldFilterActive } from "./filterOptions";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { resolveLaneTiers } from "../../utils/laneBand";
import { DEFAULT_LANE_DETAILS_CAP } from "../../utils/laneBand";
import { applyValueHit, matchRange, searchFields, type SearchScope, type ValueHit, type NameHit } from "../../utils/filterFieldSearch";
import { isImeComposing } from "../../utils/imeComposition";
import { removeLaneItem, laneFilterChipItems } from "../../utils/laneFilter";
import FilterChip from "./FilterChip";
import NumberFilterEditor from "./NumberFilterEditor";
import { numberFilterDisplay } from "../../utils/numberFilter";
import { buildFilterChips, makeLaneValueFormatter } from "./filterChips";
import { EMPTY_FILTER, type CustomFieldFilterValue, type FilterState } from "./FilterBar";

interface Props {
  board: BoardFull;
  filters: FilterState;
  /** The same handler FilterBar gets: every edit clears the active saved-filter preset. */
  onChange: (next: FilterState) => void;
  activeCount: number;
  icon: React.ReactNode;
  savedFilters: SavedFilter[];
  /** True while the saved filters are still being fetched, so the list does not read as empty. */
  savedFiltersLoading?: boolean;
  activeFilterId: number | null;
  onLoadSaved: (saved: SavedFilter) => void;
  /** Whether the full filter bar (search, scope, My cards, Lanes) is showing under the toolbar. */
  filterBarShown: boolean;
  onToggleFilterBar: () => void;
  /** Opens the filter bar and then the Lanes popover (#2205). */
  onOpenLaneFilters: () => void;
  /** The same save handler the filter bar's Saved dropdown uses; resolves with an error message on failure. */
  onSaveFilter?: (name: string) => Promise<{ error?: string }>;
  userDateFormat?: string;
  /**
   * Phones only (#2340): the Filter button also opens the View options, through a
   * "View options" button in this panel's heading row. Called with the Filter trigger,
   * which the View panel anchors to and returns focus to.
   */
  onOpenViewOptions?: (trigger: HTMLButtonElement) => void;
}

const PANEL_WIDTH = 520;
const FOCUSABLE = 'button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

type RowId = "search" | "assignee" | "label" | "priority" | "dueDate" | "blocked" | "parent" | "subColumn" | "trackState" | "lanes" | `cf:${number}`;
interface Row {
  id: RowId;
  label: string;
  /** Current value text, or null when the row is not filtering. */
  value: string | null;
}

/** "Card" or "Swimlane" tag on a result row; text, not color, tells them apart. */
function ScopeTag({ scope }: { scope: "card" | "lane" }) {
  return <span className="shrink-0 text-xs font-medium text-fg-secondary border border-line rounded px-1.5 leading-4">{scope === "lane" ? "Swimlane" : "Card"}</span>;
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
  board, filters, onChange, activeCount, icon, savedFilters, savedFiltersLoading = false, activeFilterId, onLoadSaved,
  filterBarShown, onToggleFilterBar, onOpenLaneFilters, onSaveFilter, userDateFormat = "MM/DD/YYYY", onOpenViewOptions,
}: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [expanded, setExpanded] = useState<RowId | null>(null);
  const [saveMode, setSaveMode] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const clearAllRef = useRef<HTMLButtonElement>(null);
  const chipGroupRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const close = () => {
    setOpen(false);
    setAnchor(null);
    setQuery("");
    setScope("all");
    setExpanded(null);
    setSaveMode(false);
    setSaveError(null);
  };
  // Priority 27, above the panel's own Escape (25): Escape cancels the name input first, a second one closes the panel.
  useEscapeStack(() => {
    if (!saveMode) return false;
    setSaveMode(false);
    setSaveError(null);
  }, 27);
  useEffect(() => {
    if (saveMode) saveInputRef.current?.focus();
  }, [saveMode]);
  // Popover tier 25, like the View menu. Escape clears a typed query first (#2437), then closes.
  useEscapeStack(() => {
    if (!open) return false;
    if (query !== "") {
      setQuery("");
      findRef.current?.focus();
      return;
    }
    close();
    triggerRef.current?.focus();
  }, 25);

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
    // A soft keyboard resizes the viewport (height only) when the Find input
    // takes focus; closing on that would shut the panel as it opens. Ignore a
    // height-only resize while focus is inside the panel.
    let lastWidth = window.innerWidth;
    const onResize = () => {
      const widthChanged = window.innerWidth !== lastWidth;
      lastWidth = window.innerWidth;
      if (!widthChanged && panelRef.current?.contains(document.activeElement)) return;
      close();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
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
  const subColumnOptions = useMemo(
    () => board.columns.flatMap((c) => stageSubColumns(c).map((s) => ({ id: s.id, label: `${c.name}: ${s.name}` }))),
    [board.columns],
  );
  const hasSubColumns = subColumnOptions.length > 0;
  const hasTracks = board.columns.some((c) => (c.tracks?.length ?? 0) > 0);
  const blockedCount = useMemo(() => board.cards.filter(isCardBlocked).length, [board.cards]);
  const parentOptions = useMemo(() => parentFilterOptions(board.cards), [board.cards]);
  const isBoardAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  const laneFields = useMemo(
    () => laneFilterFields(board.swimlane_custom_field_definitions ?? [], isBoardAdmin),
    [board.swimlane_custom_field_definitions, isBoardAdmin],
  );

  const customDefs = useMemo(
    () => [...board.custom_field_definitions].sort((a, b) => a.position - b.position),
    [board.custom_field_definitions],
  );

  // An id that no longer resolves (a removed user or label, e.g. from a shared URL) still
  // filters cards, so the row must still read as active: fall back to a count.
  const namesOrCount = (names: string[]) => {
    const known = names.filter(Boolean);
    return known.length === names.length ? known.join(", ") : `${names.length} selected`;
  };

  const rows: Row[] = [];
  rows.push({ id: "search", label: "Search", value: filters.search !== "" ? filters.search : null });
  rows.push({
    id: "assignee",
    label: "Assignee",
    value: filters.assigneeIds.length
      ? namesOrCount(filters.assigneeIds.map((i) => (i === -1 ? "Unassigned" : assigneeUsers.find((u) => u.id === i) ? userDisplayName(assigneeUsers.find((u) => u.id === i)!) : "")))
      : null,
  });
  rows.push({
    id: "label",
    label: "Label",
    value: filters.labelIds.length ? namesOrCount(filters.labelIds.map((i) => board.labels.find((l) => l.id === i)?.name ?? "")) : null,
  });
  rows.push({
    id: "priority",
    label: "Priority",
    value: filters.priorities.length ? PRIORITY_OPTIONS.filter((o) => filters.priorities.includes(o.value)).map((o) => o.label).join(", ") : null,
  });
  rows.push({ id: "dueDate", label: "Due date", value: DUE_DATE_OPTIONS.find((o) => o.value === filters.dueDate)?.label ?? null });
  rows.push({ id: "blocked", label: "Blocked", value: filters.blockedOnly ? "Blocked only" : null });
  // #2209 — the Parent row, on a child-tier board with linked cards (or while the filter is active).
  if (parentFilterAvailable(board, filters.parentFilter)) {
    rows.push({ id: "parent", label: "Parent", value: parentFilterLabel(filters.parentFilter, board.cards) });
  }
  // #2367 — sub-column and Track state rows exist only when the board has a split stage / tracks.
  if (hasSubColumns) {
    const picked = filters.subColumnIds ?? [];
    rows.push({ id: "subColumn", label: "Sub-column", value: picked.length ? subColumnOptions.filter((o) => picked.includes(o.id)).map((o) => o.label).join(", ") || `${picked.length} selected` : null });
  }
  if (hasTracks) {
    const picked = filters.trackStates ?? [];
    rows.push({ id: "trackState", label: "Track state", value: picked.length ? TRACK_STATE_OPTIONS.filter((o) => picked.includes(o.value)).map((o) => o.label).join(", ") : null });
  }
  // #2336 — the same gate as the filter bar's Lanes trigger.
  if (laneFilterAvailable(laneFields.filter((f) => !isLaneBuiltinField(f.id)).length, board.swimlanes.length, filters.laneFilter)) {
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
        ? v.kind === "choice" || v.kind === "multi_choice" ? (def.field_type === "checkbox" ? v.values.map((x) => (x === "true" ? "Yes" : "No")) : v.values).join(", ") : v.kind === "text" ? v.query : v.kind === "number" ? numberFilterDisplay(v, (raw) => formatCustomFieldValue(def, raw, userDateFormat)) : formatCustomFieldValue(def, v.equals, userDateFormat)
        : null,
    });
  }

  // "Filtered by" row (#2315): the same chips and dismissals as the filter bar's chip row.
  const chips = buildFilterChips(board, filters, onChange, userDateFormat);
  const laneChips = useMemo(
    () => laneFilterChipItems(filters.laneFilter, laneFields, makeLaneValueFormatter(board.swimlane_custom_field_definitions, userDateFormat)),
    [filters.laneFilter, laneFields, board.swimlane_custom_field_definitions, userDateFormat],
  );
  // A search-only filter has no chip (search is the bar's input) but still needs Clear all and Save filter.
  // An id that resolves to nobody (a removed assignee) counts toward activeCount but has no chip, so
  // the row also follows activeCount, matching the bar's Clear all and the Saved dropdown's Save.
  const hasChips = activeCount > 0 || chips.length + laneChips.length > 0 || filters.search.trim() !== "";
  // Removing a chip unmounts the focused element; keep focus in the panel: the chip that takes its
  // place, else the one before it, else Clear all, else Find a field (like the bar's lane chips).
  const dismissChip = (index: number, dismiss: () => void) => {
    dismiss();
    setTimeout(() => {
      const remaining = chipGroupRef.current?.querySelectorAll<HTMLElement>('span[role="button"]');
      const target = remaining?.[index] ?? remaining?.[index - 1];
      (target ?? clearAllRef.current ?? findRef.current)?.focus();
    }, 0);
  };
  // The chip row and the name input unmount from under focus (Clear all, last chip, Escape, a saved
  // name); without a landing spot focus drops to <body> and Tab skips the panel's trap.
  useEffect(() => {
    if (!open || !anchor) return;
    const el = document.activeElement;
    if (el && el !== document.body && panelRef.current?.contains(el)) return;
    (saveBtnRef.current ?? findRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the row or the form toggles
  }, [hasChips, saveMode]);
  const submitSave = async () => {
    if (!onSaveFilter) return;
    const trimmed = saveName.trim();
    if (!trimmed) {
      setSaveError("Filter name is required.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await onSaveFilter(trimmed);
    setSaving(false);
    if (result.error) {
      setSaveError(result.error);
    } else {
      setSaveName("");
      setSaveMode(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const tiers = useMemo(
    () => resolveLaneTiers(board.swimlane_custom_field_definitions ?? [], board.lane_details_cap ?? DEFAULT_LANE_DETAILS_CAP),
    [board.swimlane_custom_field_definitions, board.lane_details_cap],
  );
  // Lane fields come from laneFilterFields (admin-only ones already dropped for a non-admin), never the raw definitions.
  const result = useMemo(
    () => searchFields(query, scope, {
      cardFields: customDefs,
      laneFields: laneFields as { id: number | "name" | "contact_email" | "health_status"; name: string; field_type: string; is_admin_only: boolean; position: number; choices?: string[] }[],
      cards: board.cards,
      lanes: board.swimlanes,
      isAdmin: isBoardAdmin,
      tiers,
      format: (sc, f, raw) => {
        const def = sc === "card" ? customDefs.find((d) => d.id === f.id) : (board.swimlane_custom_field_definitions ?? []).find((d) => d.id === f.id);
        return def ? formatCustomFieldValue(def, raw, userDateFormat) : raw;
      },
    }),
    [query, scope, customDefs, laneFields, board.cards, board.swimlanes, board.swimlane_custom_field_definitions, isBoardAdmin, tiers, userDateFormat],
  );
  // The built-in and card-field rows narrow by name exactly as before; lane fields come from the search.
  const showNames = !result.shorthand || result.shorthand.value === "";
  const nameNeedle = result.shorthand ? result.shorthand.field : needle;
  const rowScope = (r: Row): "card" | "lane" => (r.id === "lanes" ? "lane" : "card");
  const visibleRows = needle
    ? showNames ? rows.filter((r) => (scope === "all" || scope === rowScope(r)) && matchRange(r.label, nameNeedle) !== null) : []
    : rows;
  const laneNameHits = needle && showNames ? result.names.filter((h) => h.scope === "lane" && !isLaneBuiltinField(h.fieldId)) : [];
  const valueHits = result.values;
  const laneHitValue = (h: NameHit): string | null => {
    const vals = (filters.laneFilter?.items ?? []).flatMap((it) => (it.kind === "rule" ? [it] : it.rules)).filter((r) => r.field === h.fieldId)
      .map((r) => (r.op === "between" ? [r.min, r.max].filter(Boolean).join(" to ") : r.value ?? ""));
    return vals.length ? vals.join(", ") : null;
  };
  const addTitle = () => onChange({ ...filters, search: query.trim() });
  const addValue = (h: ValueHit) => { onChange(applyValueHit(filters, h)); };
  const resultButtons = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-fp-result]") ?? []);
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      const first = resultButtons()[0];
      if (first) { e.preventDefault(); first.focus(); }
    } else if (e.key === "Enter" && needle && !isImeComposing(e)) {
      // Enter adds the first value (so `tier:gold` jumps and applies). With only name hits it opens the
      // first matching field's editor, as selecting that row does; with neither, the card-text fallback.
      e.preventDefault();
      if (valueHits[0]) addValue(valueHits[0]);
      else if (visibleRows[0]) {
        if (visibleRows[0].id === "lanes") { close(); onOpenLaneFilters(); }
        else setExpanded(visibleRows[0].id);
      } else if (laneNameHits[0]) { close(); onOpenLaneFilters(); }
      else if (result.titleQuery) addTitle();
    }
  };
  const onResultKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = resultButtons();
    const at = list.indexOf(e.currentTarget);
    const next = e.key === "ArrowDown" ? list[at + 1] : list[at - 1];
    if (next) next.focus();
    else if (e.key === "ArrowUp") findRef.current?.focus();
  };
  const hl = (text: string, q: string) => {
    const r = matchRange(text, q);
    if (!r) return text;
    // The marked copy is aria-hidden and the plain text is read instead: a <mark> splits the accessible name ("Lab el").
    return (
      <>
        <span aria-hidden="true">{text.slice(0, r[0])}<mark className="bg-primary-emphasis/10 text-info-on-tint font-semibold underline decoration-1 underline-offset-2 rounded-sm">{text.slice(r[0], r[1])}</mark>{text.slice(r[1])}</span>
        <span className="sr-only">{text}</span>
      </>
    );
  };
  const valueNeedle = result.shorthand ? result.shorthand.value : needle;

  const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const checkbox = (key: string, label: string, checked: boolean, onToggle: () => void, dot?: string) => (
    <label key={key} className={`flex items-center gap-2 px-2 py-1 max-sm:min-h-11 rounded text-sm text-fg cursor-pointer hover:bg-surface-hover focus-within:ring-2 focus-within:ring-primary-emphasis`}>
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
    if (v.kind === "number") {
      return <NumberFilterEditor definition={def} value={v} onChange={(next) => setCustom(def.id, next)} inputClass={inputClass} />;
    }
    if (v.kind === "date") {
      return <input type="date" aria-label={def.name} value={v.equals} onChange={(e) => setCustom(def.id, { kind: "date", equals: e.target.value })} className={inputClass} />;
    }
    if (v.kind !== "choice" && v.kind !== "multi_choice") return null;
    const kind = v.kind;
    const values = v.values;
    const choices = def.field_type === "checkbox" ? [{ value: "true", label: "Yes", color: undefined as string | undefined }, { value: "false", label: "No", color: undefined as string | undefined }] : def.choices.map((c) => {
      // Same dot as the filter bar's dropdown filter; multi-select entries carry none there.
      if (def.field_type === "multi_select") return { value: c, label: c, color: undefined };
      const key = explicitChoiceColor(def, c);
      return { value: c, label: c, color: key ? choiceColorBase(key) : choiceColor(c) };
    });
    return (
      <div role="group" aria-label={def.name}>
        {choices.map((c) => checkbox(c.value, c.label, values.includes(c.value), () => setCustom(def.id, { kind, values: toggleIn(values, c.value) }), c.color))}
      </div>
    );
  };

  const editor = (row: Row) => {
    switch (row.id) {
      case "search":
        // Same binding as the filter bar's search box: filters.search, which FilterBar/URL sync already persist.
        return (
          <input
            type="text"
            aria-label="Search cards"
            value={filters.search}
            placeholder="Search cards"
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            className="w-full bg-surface border border-line-strong rounded px-2 py-1 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          />
        );
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
              <label key={o.value ?? "any"} className="flex items-center gap-2 px-2 py-1 max-sm:min-h-11 rounded text-sm text-fg cursor-pointer hover:bg-surface-hover focus-within:ring-2 focus-within:ring-primary-emphasis">
                <input type="radio" name={`${id}-due`} checked={filters.dueDate === o.value} onChange={() => onChange({ ...filters, dueDate: o.value })} className="accent-primary" />
                {o.label}
              </label>
            ))}
          </div>
        );
      case "subColumn":
        return (
          <div role="group" aria-label="Sub-column">
            {subColumnOptions.map((o) => checkbox(`sub-${o.id}`, o.label, (filters.subColumnIds ?? []).includes(o.id), () => {
              const next = toggleIn(filters.subColumnIds ?? [], o.id);
              onChange({ ...filters, subColumnIds: next.length > 0 ? next : undefined });
            }))}
          </div>
        );
      case "trackState":
        return (
          <div role="group" aria-label="Track state" aria-describedby={`${id}-track-hint`}>
            <p id={`${id}-track-hint`} className="px-2 py-1 text-xs text-fg-tertiary">Cards with at least one track in a chosen state</p>
            {TRACK_STATE_OPTIONS.map((o) => checkbox(`track-${o.value}`, o.label, (filters.trackStates ?? []).includes(o.value), () => {
              const next = toggleIn(filters.trackStates ?? [], o.value);
              onChange({ ...filters, trackStates: next.length > 0 ? next : undefined });
            }))}
          </div>
        );
      case "parent": {
        // The standard single-select (as Due date): Any, Any parent, No parent, then each parent the viewer
        // can open, read from the cards' own `parent`; a parent on a board they cannot open is never offered.
        const setParent = (v: ParentFilter | undefined) => {
          const { parentFilter: _dropped, ...rest } = filters;
          onChange(v === undefined ? rest : { ...rest, parentFilter: v });
        };
        const options: { key: string; value: ParentFilter | undefined; label: string }[] = [
          { key: "any-value", value: undefined, label: "Any" },
          { key: "any", value: "any", label: "Any parent" },
          { key: "none", value: "none", label: "No parent" },
          ...parentOptions.map((o) => ({ key: `p-${o.id}`, value: o.id as ParentFilter, label: o.label })),
        ];
        return (
          <div role="radiogroup" aria-label="Parent" className="max-h-64 overflow-y-auto">
            {options.map((o) => (
              <label key={o.key} className="flex items-center gap-2 px-2 py-1 max-sm:min-h-11 rounded text-sm text-fg cursor-pointer hover:bg-surface-hover focus-within:ring-2 focus-within:ring-primary-emphasis">
                <input type="radio" name={`${id}-parent`} checked={filters.parentFilter === o.value} onChange={() => setParent(o.value)} className="accent-primary" />
                <span className="min-w-0 break-words">{o.label}</span>
              </label>
            ))}
          </div>
        );
      }
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
      data-shortcut-scope="popover"
      onKeyDown={onPanelKeyDown}
      style={{ position: "fixed", top: anchor.top, right: anchor.right, width: PANEL_WIDTH, maxWidth: `calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px)`, maxHeight: visibleMaxHeight(anchor.top + POPOVER_VIEWPORT_MARGIN) }}
      className="z-50 bg-surface border border-line-strong rounded-lg shadow-lg p-3 space-y-2 overflow-y-auto max-sm:[&_button]:min-h-11 max-sm:[&_input[type=text]]:min-h-11 max-sm:[&_input[type=number]]:min-h-11 max-sm:[&_input[type=date]]:min-h-11"
    >
      {onOpenViewOptions ? (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">Filter</h2>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => { const t = triggerRef.current; close(); if (t) onOpenViewOptions(t); }}
            className={`inline-flex items-center gap-1 text-sm text-fg border border-line-strong rounded px-3 hover:bg-surface-hover transition ${MENU_ITEM_FOCUS_RING}`}
          >
            View options
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : (
        <h2 className="text-sm font-semibold text-fg">Filter</h2>
      )}
      <div className="relative">
        <input
          ref={findRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search fields and values to filter"
          aria-label="Search fields and values to filter"
          className="w-full bg-sunken border border-line-strong rounded px-2.5 py-2 pr-12 text-sm text-fg placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        />
        <kbd aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fg-secondary border border-line-strong rounded px-1 leading-4 max-sm:hidden">Esc</kbd>
      </div>
      <div role="group" aria-label="Search scope" className="flex items-center gap-1.5">
        {([["all", "All fields"], ["card", "Card fields"], ["lane", "Swimlane fields"]] as const).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={scope === v}
            onClick={() => setScope(v)}
            className={`text-xs rounded-full border px-2.5 py-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${scope === v ? "bg-primary-emphasis/10 text-info-on-tint border-info/40 font-semibold" : "text-fg-secondary border-line hover:bg-surface-hover"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {hasChips && (
        <div data-testid="filter-panel-chips" className="flex flex-col gap-1.5 pb-1">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-secondary">Filtered by</h3>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                ref={clearAllRef}
                type="button"
                onClick={() => { setSaveMode(false); setSaveName(""); setSaveError(null); onChange(EMPTY_FILTER); }}
                className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover border border-line hover:border-line-emphasis rounded px-2 py-0.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Clear all
              </button>
              {onSaveFilter && (
                <button
                  ref={saveBtnRef}
                  type="button"
                  aria-expanded={saveMode}
                  onClick={() => { setSaveMode((v) => !v); setSaveError(null); setSaveName(""); }}
                  className="text-xs text-fg hover:bg-surface-hover border border-line-strong rounded px-2 py-0.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Save filter
                </button>
              )}
            </div>
          </div>
          {chips.length + laneChips.length > 0 && (
          <div ref={chipGroupRef} role="group" aria-label="Filtered by" className="flex items-center gap-1.5 flex-wrap">
            {chips.map((chip, ci) => (
              <FilterChip key={chip.key} label={chip.label} colorDot={chip.colorDot} avatarUser={chip.avatarUser} onDismiss={() => dismissChip(ci, chip.onDismiss)} />
            ))}
            {laneChips.map((chip, i) => (
              <span key={`lane:${chip.id}`} className="contents">
                {i > 0 && <span className="text-xs text-fg-tertiary">{chip.join}</span>}
                <FilterChip
                  tag="Lanes"
                  label={chip.label}
                  onDismiss={() => dismissChip(chips.length + i, () => {
                    if (!filters.laneFilter) return;
                    const laneFilter = removeLaneItem(filters.laneFilter, chip.id);
                    const next = { ...filters, laneFilter };
                    if (!laneFilter) delete next.laneFilter;
                    onChange(next);
                  })}
                />
              </span>
            ))}
          </div>
          )}
          {saveMode && (
            <div className="px-0.5">
              <label className="block text-xs text-fg-secondary mb-1" htmlFor={`${id}-save-name`}>Save current filters as:</label>
              <div className="flex items-center gap-1.5">
                <input
                  ref={saveInputRef}
                  id={`${id}-save-name`}
                  type="text"
                  value={saveName}
                  placeholder="Filter name"
                  maxLength={100}
                  aria-invalid={saveError ? true : undefined}
                  aria-describedby={saveError ? `${id}-save-error` : undefined}
                  onChange={(e) => { setSaveName(e.target.value); setSaveError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) { e.preventDefault(); void submitSave(); } }}
                  className="min-w-0 flex-1 bg-surface border border-line-strong rounded px-2 py-1 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                />
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void submitSave()}
                  className="text-xs bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium rounded px-2 py-1 max-sm:min-w-11 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-surface"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              {saveError && <p id={`${id}-save-error`} role="alert" className="text-xs text-danger mt-1">{saveError}</p>}
            </div>
          )}
        </div>
      )}
      {needle && showNames && <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-secondary px-2">Fields matching &ldquo;{query.trim()}&rdquo;</h3>}
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
                onKeyDown={needle ? onResultKeyDown : undefined}
                data-fp-result={needle ? "" : undefined}
                aria-expanded={row.id === "lanes" ? undefined : isOpen}
                aria-haspopup={row.id === "lanes" ? "dialog" : undefined}
                className={`w-full flex items-center justify-between gap-3 px-2 py-2 rounded text-sm text-left transition ${MENU_ITEM_FOCUS_RING} ${active ? "bg-primary-emphasis/10 text-info-on-tint font-semibold" : "text-fg hover:bg-surface-hover"}`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <ActiveMark active={active} testId="filter-row-mark" />
                  {needle && <ScopeTag scope={rowScope(row)} />}
                  <span className={needle ? "truncate" : "shrink-0"}>{needle ? hl(row.label, nameNeedle) : row.label}</span>
                  {needle && row.id.startsWith("cf:") && <span className="shrink-0 text-xs font-normal text-fg-secondary">{customDefs.find((d) => `cf:${d.id}` === row.id)?.field_type.replace("_", "-")}</span>}
                </span>
                <span className={`truncate text-right ${active ? "" : "text-fg-secondary font-normal"}`}>{row.value ?? "Any"}</span>
              </button>
              {isOpen && <div className="pl-2 pr-1 pb-1 max-h-48 overflow-y-auto">{editor(row)}</div>}
            </li>
          );
        })}
        {laneNameHits.map((h) => {
          const cur = laneHitValue(h);
          return (
            <li key={`lane-field:${h.fieldId}`}>
              <button
                type="button"
                onClick={() => { close(); onOpenLaneFilters(); }}
                onKeyDown={onResultKeyDown}
                data-fp-result=""
                aria-haspopup="dialog"
                className={`w-full flex items-center justify-between gap-3 px-2 py-2 rounded text-sm text-left transition ${MENU_ITEM_FOCUS_RING} ${cur ? "bg-primary-emphasis/10 text-info-on-tint font-semibold" : "text-fg hover:bg-surface-hover"}`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <ActiveMark active={!!cur} testId="filter-row-mark" />
                  <ScopeTag scope="lane" />
                  <span className="truncate">{hl(h.name, nameNeedle)}</span>
                  <span className="shrink-0 text-xs font-normal text-fg-secondary">{h.fieldType.replace("_", "-")}</span>
                  {h.hiddenOnBand && <span className="shrink-0 text-xs font-normal text-fg-secondary">(hidden on band)</span>}
                </span>
                <span className={`truncate text-right ${cur ? "" : "text-fg-secondary font-normal"}`}>{cur ?? "Any"}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {needle && showNames && visibleRows.length + laneNameHits.length === 0 && <p role="status" className="px-2 py-1 text-sm text-fg-secondary">No field matches "{query}".</p>}

      {needle && (valueHits.length > 0 || result.titleQuery) && (
        <>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-secondary px-2">Values matching &ldquo;{result.shorthand ? result.shorthand.value : query.trim()}&rdquo;</h3>
          <ul aria-label="Matching values" className="space-y-0.5">
            {valueHits.map((h) => (
              <li key={`${h.scope}:${h.fieldId}:${h.raw}`}>
                <button
                  type="button"
                  onClick={() => addValue(h)}
                  onKeyDown={onResultKeyDown}
                  data-fp-result=""
                  className={`w-full flex items-center justify-between gap-3 px-2 py-2 rounded text-sm text-left text-fg hover:bg-surface-hover transition ${MENU_ITEM_FOCUS_RING}`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <ScopeTag scope={h.scope} />
                    <span className="truncate">{h.fieldName} is <span className="font-semibold">{hl(h.label, valueNeedle)}</span></span>
                    {h.hiddenOnBand && <span className="shrink-0 text-xs text-fg-secondary">(hidden on band)</span>}
                  </span>
                  <span className="shrink-0 text-xs text-fg-secondary">{h.count} {h.scope === "lane" ? (h.count === 1 ? "lane" : "lanes") : (h.count === 1 ? "card" : "cards")}</span>
                </button>
              </li>
            ))}
            {result.titleQuery && (
              <li>
                <button
                  type="button"
                  onClick={addTitle}
                  onKeyDown={onResultKeyDown}
                  data-fp-result=""
                  className={`w-full flex items-center gap-1.5 px-2 py-2 rounded text-sm text-left text-fg hover:bg-surface-hover transition ${MENU_ITEM_FOCUS_RING}`}
                >
                  <ScopeTag scope="card" />
                  <span className="truncate">Title contains &lsquo;{result.titleQuery}&rsquo;</span>
                </button>
              </li>
            )}
          </ul>
        </>
      )}

      <div className="border-t border-line pt-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-secondary px-2 pb-1">Saved filters</h3>
        {savedFiltersLoading ? (
          <p role="status" className="px-2 py-1 text-xs text-fg-muted italic">Loading…</p>
        ) : savedFilters.length === 0 ? (
          <p className="px-2 py-1 text-sm text-fg-secondary">No saved filters yet.</p>
        ) : (
          <ul aria-label="Saved filters" className="space-y-0.5">
            {savedFilters.map((sf) => (
              <li key={sf.id}>
                <button
                  type="button"
                  aria-pressed={activeFilterId === sf.id}
                  onClick={() => { onLoadSaved(sf); close(); triggerRef.current?.focus(); }}
                  className={`w-full flex items-center gap-1.5 px-2 py-2 rounded text-sm text-left transition ${MENU_ITEM_FOCUS_RING} ${activeFilterId === sf.id ? "bg-primary-emphasis/10 text-info-on-tint font-semibold" : "text-fg hover:bg-surface-hover"}`}
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
        <p className="px-2 pb-1 text-xs text-fg-secondary">&uarr;&darr; to move &middot; Enter to add or open &middot; field:value to jump</p>
        <button
          type="button"
          onClick={() => { close(); onToggleFilterBar(); }}
          className={`w-full text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded px-2 py-1.5 text-left ${MENU_ITEM_FOCUS_RING}`}
        >
          {filterBarShown ? "Hide filter bar (F)" : "Show filter bar (search, saved filters, Lanes)"}
        </button>
      </div>
    </div>
  ) : null;

  // The bar's visibility no longer tints the button; when filters keep applying behind a hidden bar, say so (#2459).
  const tooltipText = !filterBarShown && activeCount > 0
    ? `${activeCount} filter${activeCount === 1 ? "" : "s"} active (bar hidden)`
    : onOpenViewOptions ? "Filters and view options" : "Filters";

  return (
    <>
      {/* Tooltip clones its child and takes over the child's ref, so the trigger ref lives on the button inside this span. */}
      <Tooltip content={tooltipText} disabled={open}>
        <span className="inline-flex shrink-0">
        <button
          ref={triggerRef}
          type="button"
          data-tour-step="filter"
          data-filters-trigger
          aria-pressed={filterBarShown}
          onClick={toggle}
          onKeyDown={onTriggerKeyDown}
          className={`inline-flex items-center justify-center gap-1.5 h-9 px-3 max-sm:h-11 max-sm:min-w-11 max-sm:px-0 text-sm rounded border transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${open || activeCount > 0 ? "text-info-on-tint bg-info/10 border-info/40" : "text-fg border-line-strong hover:bg-surface-hover"}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? `${id}-panel` : undefined}
          aria-label={`${onOpenViewOptions ? "Filters and view options" : "Filters"}${activeCount > 0 ? `, ${activeCount} active` : ""}`}
        >
          {icon}
          {/* Icon-only on phones (#2333); the count badge stays. aria-label above names the button. */}
          <span className="max-sm:sr-only">Filters</span>
          {activeCount > 0 && " "}
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
