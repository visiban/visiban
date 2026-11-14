import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type { BoardFull, BoardUser, CustomFieldDefinition, Priority, User } from "../../types";
import { userDisplayName } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import CheckboxDropdown from "../Common/CheckboxDropdown";
import Avatar from "../Common/Avatar";
import ActiveMark from "../Common/ActiveMark";
import FilterChip from "./FilterChip";
import { choiceColor, explicitChoiceColor, formatCustomFieldValue } from "../../utils/customFieldValue";
import { CHOICE_COLORS } from "../../constants/choiceColors";
import { PRIORITY_COLORS } from "../../constants/colors";
import { isCardBlocked } from "../../utils/blockedState";
import { useInlineEditEscape } from "../../hooks/useInlineEditEscape";
import { LaneFilterControl } from "./LaneFilterPopover";
import {
  isLaneFilterActive,
  laneFilterChipItems,
  laneFilterFields,
  laneTextValueChoices,
  removeLaneItem,
  summarizeLaneFilter,
  type LaneFilter,
  type LaneValueFormatter,
} from "../../utils/laneFilter";

// #371 — one filter value per custom field, keyed by field_definition id in
// FilterState.customFields. Number/date are equality-only (the value is
// stored as TextField server-side, so a range comparison would be
// lexicographic, not numeric — out of scope for this phase, see the ux-design
// spec's explicit non-goal). Dropdown and checkbox share the multi-select
// "choice" shape since a checkbox is just a 2-choice dropdown for filtering
// purposes.
//
// #1391 — a multi-select field gets its own "multi_choice" kind rather than
// reusing "choice": the stored value is a JSON array, so matching must parse
// it and test exact membership, where "choice" compares the whole stored
// string. Same OR-within-the-field semantics as "choice": a card matches when
// it holds any of the picked entries.
export type CustomFieldFilterValue =
  | { kind: "text"; query: string }
  | { kind: "number" | "date"; equals: string }
  | { kind: "choice"; values: string[] }
  | { kind: "multi_choice"; values: string[] };

export interface FilterState {
  search: string;
  assigneeIds: number[]; // -1 = unassigned
  labelIds: number[];
  priorities: Priority[];
  dueDate: "overdue" | "today" | "this_week" | "none" | null;
  /** #371 — keyed by CustomFieldDefinition.id. */
  customFields: Record<number, CustomFieldFilterValue>;
  /**
   * #371 — which custom fields have an open control in the toolbar row. Not
   * itself a filter (an empty/open control filters nothing) — this is UI
   * state so an admin can open a control before typing into it without it
   * disappearing. Seeded to the board's pinned field ids on first load per
   * board; see usePersistedFilters' self-heal fallback.
   */
  visibleCustomFieldFilterIds: number[];
  /**
   * #1149 — show only blocked cards (manual or relation blocks, the union
   * `isCardBlocked` computes). Optional so every filter persisted or saved
   * before this field existed still loads; absent reads as false.
   */
  blockedOnly?: boolean;
  /**
   * #2205 — rules that hide swimlanes by their own custom field values.
   * Optional and absent from EMPTY_FILTER, so every filter persisted or saved
   * before lane filters existed still loads, and Clear all drops it. Card
   * filters are unaffected; the two are AND-ed on the board.
   */
  laneFilter?: LaneFilter;
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, co-located with the component for cohesion
export const EMPTY_FILTER: FilterState = {
  search: "",
  assigneeIds: [],
  labelIds: [],
  priorities: [],
  dueDate: null,
  customFields: {},
  visibleCustomFieldFilterIds: [],
  blockedOnly: false,
};

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, co-located with the component for cohesion
export function isCustomFieldFilterActive(v: CustomFieldFilterValue): boolean {
  return v.kind === "choice" || v.kind === "multi_choice"
    ? v.values.length > 0
    : v.kind === "text" ? v.query !== "" : v.equals !== "";
}

function emptyCustomFieldFilterValue(def: CustomFieldDefinition): CustomFieldFilterValue {
  switch (def.field_type) {
    case "number":
    case "date":
      return { kind: def.field_type, equals: "" };
    case "dropdown":
    case "checkbox":
      return { kind: "choice", values: [] };
    case "multi_select":
      return { kind: "multi_choice", values: [] };
    case "text":
    case "url": // #1390 — a URL is matched as text ("contains"), like a text field
    default:
      return { kind: "text", query: "" };
  }
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, co-located with the component for cohesion
export function countActiveFilters(f: FilterState): number {
  return [
    f.search !== "",
    f.assigneeIds.length > 0,
    f.labelIds.length > 0,
    f.priorities.length > 0,
    f.dueDate !== null,
    Object.values(f.customFields).some(isCustomFieldFilterActive),
    !!f.blockedOnly,
    // #2205 — all lane rules count as one dimension; the per-rule count is on the Lanes trigger.
    isLaneFilterActive(f.laneFilter),
  ].filter(Boolean).length;
}


interface Props {
  board: BoardFull;
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  isSearching?: boolean;
  currentUser?: User | null;
  hiddenCount?: number;
  /**
   * Search scope — "board" searches card fields on this board, "all" signals
   * a palette-driven cross-board search. Persisted to the URL via ?scope=all
   * (absent ⇒ "board"). Controlled by BoardView.
   */
  scope?: "board" | "all";
  onScopeChange?: (scope: "board" | "all") => void;
  /** The user's `date_format` preference, for date custom-field chips (#1993). */
  userDateFormat?: string;
  /** #2205 — lanes the lane filter hides (excludes the focused lane, which always shows). */
  hiddenLaneCount?: number;
  /** #2205 — the Lanes trigger, so BoardView can open the popover from its notices. */
  lanesTriggerRef?: RefObject<HTMLButtonElement | null>;
}

interface MyCardsButtonProps {
  currentUser: User;
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

interface BlockedOnlyButtonProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  /** Blocked cards on the board, manual and relation (#1149). */
  blockedCount: number;
}

/**
 * "Blocked only" toggle (#1149). A single filter, so it shows its active
 * state the way My cards does (aria-pressed + `border-primary-soft text-info`); the
 * count says how many cards the filter would keep, and is part of the
 * accessible name because the visible number alone has no label.
 */
function BlockedOnlyButton({ filters, onChange, blockedCount }: BlockedOnlyButtonProps) {
  const isActive = !!filters.blockedOnly;
  const name = `Blocked only, ${blockedCount} ${blockedCount === 1 ? "blocked card" : "blocked cards"}`;
  return (
    <button
      type="button"
      onClick={() => onChange({ ...filters, blockedOnly: !isActive })}
      aria-pressed={isActive}
      aria-label={name}
      title={isActive ? "Remove Blocked only filter" : "Show only blocked cards"}
      className={`bg-surface border rounded px-2 py-1 text-sm focus:outline-none flex items-center gap-1.5 transition shrink-0 focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
        isActive
          ? "border-primary-soft text-info"
          : "border-line-strong text-fg-secondary hover:border-line-emphasis"
      }`}
    >
      <ActiveMark active={isActive} />
      <svg className="w-3 h-3 shrink-0 text-danger" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 000 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
      </svg>
      Blocked only
      <span aria-hidden="true" className="text-xs text-fg-tertiary tabular-nums">{blockedCount}</span>
    </button>
  );
}

function MyCardsButton({ currentUser, filters, onChange }: MyCardsButtonProps) {
  const isActive =
    filters.assigneeIds.length === 1 && filters.assigneeIds[0] === currentUser.id;

  return (
    <button
      onClick={() => onChange({ ...filters, assigneeIds: isActive ? [] : [currentUser.id] })}
      aria-pressed={isActive}
      title={isActive ? "Remove My cards filter" : "Show only cards assigned to me"}
      className={`bg-surface border rounded px-2 py-1 text-sm focus:outline-none flex items-center gap-1.5 transition shrink-0 focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
        isActive
          ? "border-primary-soft text-info"
          : "border-line-strong text-fg-secondary hover:border-line-emphasis"
      }`}
    >
      <ActiveMark active={isActive} />
      <Avatar user={currentUser} size="xs" />
      My cards
    </button>
  );
}

const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: "low", label: "Low", color: PRIORITY_COLORS.low },
  { value: "medium", label: "Medium", color: PRIORITY_COLORS.medium },
  { value: "high", label: "High", color: PRIORITY_COLORS.high },
  { value: "urgent", label: "Urgent", color: PRIORITY_COLORS.urgent },
];

const DUE_DATE_OPTIONS: { value: NonNullable<FilterState["dueDate"]>; label: string }[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "this_week", label: "Due this week" },
  { value: "none", label: "No due date" },
];

// #964 — the four built-in facets that used to render as always-visible
// dropdowns in Row 1. They now stay collapsed until picked from the
// "+ Filter" menu. FACET_ORDER is the canonical render order regardless of
// pick order, matching the order the dropdowns appeared in before this
// change.
// #1149 adds "blocked": the same filter as the Blocked only toggle, offered
// here too so every built-in facet is reachable from one menu (UI spec).
type FacetId = "assignee" | "label" | "priority" | "dueDate" | "blocked";
const FACET_ORDER: FacetId[] = ["assignee", "label", "priority", "dueDate", "blocked"];
const FACET_OPTIONS: { value: FacetId; label: string }[] = [
  { value: "assignee", label: "Assignee" },
  { value: "label", label: "Label" },
  { value: "priority", label: "Priority" },
  { value: "dueDate", label: "Due date" },
  { value: "blocked", label: "Blocked" },
];

export default function FilterBar({ board, filters, onChange, searchRef, isSearching, currentUser, hiddenCount = 0, scope = "board", onScopeChange, userDateFormat = "MM/DD/YYYY", hiddenLaneCount = 0, lanesTriggerRef }: Props) {
  const activeCount = countActiveFilters(filters);
  // #2205 — the swimlane fields this viewer may rule on. Admin-only fields are
  // offered to admins only: their values are never sent to other roles.
  const isBoardAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  const swimlaneDefs = board.swimlane_custom_field_definitions;
  const laneFields = useMemo(() => laneFilterFields(swimlaneDefs ?? [], isBoardAdmin), [swimlaneDefs, isBoardAdmin]);
  const laneFmt: LaneValueFormatter = useCallback(
    (field, raw) => {
      const def = (swimlaneDefs ?? []).find((d) => d.id === field.id);
      if (!def) return raw;
      const shown = formatCustomFieldValue(def, raw, userDateFormat);
      // A number with no display format comes back as typed; group its
      // thousands so "Deal value 50,000 or more" reads at a glance.
      if (def.field_type === "number" && shown === raw && Number.isFinite(Number(raw))) {
        return Number(raw).toLocaleString("en-US", { maximumFractionDigits: 10 });
      }
      return shown;
    },
    [swimlaneDefs, userDateFormat],
  );
  // Memoized: chips and the summary are pure in these inputs, and the filter
  // strip re-renders on every keystroke in the search box (#2205 perf-check).
  const laneChips = useMemo(
    () => laneFilterChipItems(filters.laneFilter, laneFields, laneFmt),
    [filters.laneFilter, laneFields, laneFmt],
  );
  const laneRuleCount = useMemo(
    () => summarizeLaneFilter(filters.laneFilter, laneFields, laneFmt).completeCount,
    [filters.laneFilter, laneFields, laneFmt],
  );
  // #2226 — the values text `is` / `is not` lane rules choose from.
  const laneTextChoices = useMemo(() => laneTextValueChoices(board.swimlanes, laneFields), [board.swimlanes, laneFields]);
  const ownLanesTriggerRef = useRef<HTMLButtonElement>(null);
  const lanesTrigger = lanesTriggerRef ?? ownLanesTriggerRef;
  const chipGroupRef = useRef<HTMLDivElement>(null);
  const searchDisabled = scope === "all";
  const blockedCount = useMemo(() => board.cards.filter(isCardBlocked).length, [board.cards]);

  // #964 — which built-in facet controls are currently expanded in Row 1.
  // Deliberately local, ephemeral UI state, NOT a FilterState field: it is
  // not persisted (usePersistedFilters), not serialized into a saved filter
  // (useSavedFilters' state_json goes through the backend's allow-list, which
  // already doesn't know about #371's visibleCustomFieldFilterIds — adding a
  // second UI-only array here would compound that pre-existing gap rather
  // than fix it). A board switch/reload always starts with every facet
  // collapsed, mirroring "+ Custom fields" starting empty for a fresh visit.
  const [openFacetIds, setOpenFacetIds] = useState<FacetId[]>([]);
  const filterMenuTriggerRef = useRef<HTMLButtonElement>(null);

  const activeBuiltInFacetCount = [
    filters.assigneeIds.length > 0,
    filters.labelIds.length > 0,
    filters.priorities.length > 0,
    filters.dueDate !== null,
    !!filters.blockedOnly,
  ].filter(Boolean).length;

  // #964 — a facet's control auto-collapses out of Row 1 the moment the user
  // closes it (Escape, outside click, or re-toggling), unlike custom fields
  // (which stay open once revealed — see the comment on the custom-field
  // chip dismiss handler below for why that's the right call there but not
  // here). On Escape, useDropdownEscape refocuses the facet's own trigger
  // button before it unmounts, which then strands focus on <body> once React
  // removes that node — that's the one case worth recovering from by
  // refocusing "+ Filter"'s trigger. An *outside click* must NOT get the same
  // recovery: the click already moved focus (or intentionally landed on a
  // non-focusable part of the page, which also reads as document.body) to
  // wherever the user meant to go, so grabbing focus back would be a bug, not
  // a fix. document.activeElement alone can't tell these two cases apart —
  // both can legitimately observe <body> — so escapeCloseRef records whether
  // the close now being processed was actually triggered by Escape.
  const escapeCloseRef = useRef(false);

  // Escape in the focused search box clears it and drops focus, through the stack so it does not also
  // clear the card selection (#1860). Keyed on the focused element, not the ref: searchRef is optional.
  useInlineEditEscape(
    () => document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.boardSearch === "true",
    () => {
      onChange({ ...filters, search: "" });
      (document.activeElement as HTMLInputElement).blur();
    },
  );

  const handleRow1KeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Row 1's own onKeyDown (React's synthetic bubble phase, delegated at the
    // app root) fires before useEscapeStack's document-level listener, so
    // this flag is already set by the time a facet's onOpenChange(false)
    // — triggered by the very same Escape keypress — runs and consumes it.
    // Self-resetting on the next tick means an Escape that closes something
    // other than a built-in facet (e.g. "+ Filter" itself, which has no
    // onOpenChange wired here) never leaves a stale true behind to
    // mis-attribute a later, unrelated outside-click close.
    escapeCloseRef.current = true;
    setTimeout(() => {
      escapeCloseRef.current = false;
    }, 0);
  };

  // Tab off a portaled facet menu closes it and refocuses the facet's trigger
  // (AnchoredMenuPanel, #1482). Collapsing the facet on that close would unmount
  // the trigger that just took focus and drop it to <body>, so a Tab-out keeps
  // the facet mounted. Capture phase: the panel's own handler (which triggers
  // the close) runs before Row 1's bubble handler.
  const tabCloseRef = useRef(false);
  const handleRow1KeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !(e.target instanceof Element) || !e.target.closest("[data-anchored-menu]")) return;
    tabCloseRef.current = true;
    setTimeout(() => {
      tabCloseRef.current = false;
    }, 0);
  };

  const handleFacetOpenChange = (id: FacetId, open: boolean) => {
    if (open) return;
    if (tabCloseRef.current) return;
    setOpenFacetIds((prev) => prev.filter((f) => f !== id));
    if (!escapeCloseRef.current) return;
    escapeCloseRef.current = false;
    setTimeout(() => {
      if (!document.body.contains(document.activeElement) || document.activeElement === document.body) {
        filterMenuTriggerRef.current?.focus();
      }
    }, 0);
  };

  // Derive chips from active filter state (search is excluded — the input already communicates state)
  const chips: { key: string; label: string; colorDot?: string; avatarUser?: BoardUser; onDismiss: () => void }[] = [];

  // Assignee choices: the board's members, then any assignee on a card who is
  // not in the member list. The list omits users with all-content access for
  // readers who are not site admins (#1714), and their cards stay filterable.
  const assigneeUsers = new Map<number, BoardUser>(board.members.map((m) => [m.user.id, m.user]));
  for (const card of board.cards) {
    if (card.assignee && !assigneeUsers.has(card.assignee.id)) assigneeUsers.set(card.assignee.id, card.assignee);
  }

  for (const assigneeId of filters.assigneeIds) {
    if (assigneeId === -1) {
      chips.push({
        key: "assignee:-1",
        label: "Unassigned",
        onDismiss: () => onChange({ ...filters, assigneeIds: filters.assigneeIds.filter((id) => id !== -1) }),
      });
    } else {
      const assignee = assigneeUsers.get(assigneeId);
      if (assignee) {
        chips.push({
          key: `assignee:${assigneeId}`,
          label: userDisplayName(assignee),
          avatarUser: assignee,
          onDismiss: () => onChange({ ...filters, assigneeIds: filters.assigneeIds.filter((id) => id !== assigneeId) }),
        });
      }
    }
  }

  for (const labelId of filters.labelIds) {
    const label = board.labels.find((l) => l.id === labelId);
    if (label) {
      chips.push({
        key: `label:${labelId}`,
        label: label.name,
        colorDot: label.color,
        onDismiss: () => onChange({ ...filters, labelIds: filters.labelIds.filter((id) => id !== labelId) }),
      });
    }
  }

  for (const priority of filters.priorities) {
    const option = PRIORITY_OPTIONS.find((o) => o.value === priority);
    if (option) {
      chips.push({
        key: `priority:${priority}`,
        label: option.label,
        colorDot: option.color,
        onDismiss: () => onChange({ ...filters, priorities: filters.priorities.filter((p) => p !== priority) }),
      });
    }
  }

  if (filters.dueDate !== null) {
    const option = DUE_DATE_OPTIONS.find((o) => o.value === filters.dueDate);
    if (option) {
      chips.push({
        key: `due:${filters.dueDate}`,
        label: option.label,
        onDismiss: () => onChange({ ...filters, dueDate: null }),
      });
    }
  }

  if (filters.blockedOnly) {
    chips.push({
      key: "blocked-only",
      label: "Blocked only",
      onDismiss: () => onChange({ ...filters, blockedOnly: false }),
    });
  }

  // #371 — custom field filter chips. Dismissing clears the value but keeps
  // the field in visibleCustomFieldFilterIds so its (now-empty) control
  // doesn't disappear mid-interaction.
  for (const def of board.custom_field_definitions) {
    const v = filters.customFields[def.id];
    if (!v || !isCustomFieldFilterActive(v)) continue;
    const displayValue = v.kind === "choice" || v.kind === "multi_choice" ? v.values.join(", ") : v.kind === "text" ? v.query : formatCustomFieldValue(def, v.equals, userDateFormat);
    chips.push({
      key: `cf:${def.id}`,
      label: `${def.name}: ${displayValue}`,
      onDismiss: () => onChange({ ...filters, customFields: { ...filters.customFields, [def.id]: emptyCustomFieldFilterValue(def) } }),
    });
  }

  const statusText = [
    hiddenLaneCount > 0 ? `${hiddenLaneCount} lane${hiddenLaneCount !== 1 ? "s" : ""} hidden` : "",
    hiddenCount > 0 ? `${hiddenCount} card${hiddenCount !== 1 ? "s" : ""} hidden` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col w-full">
      {/* Row 1: filter controls */}
      <div className="flex items-center gap-2 flex-wrap" onKeyDown={handleRow1KeyDown} onKeyDownCapture={handleRow1KeyDownCapture}>
        <span className="w-px h-4 bg-surface-active shrink-0" />

        {currentUser && (
          <MyCardsButton currentUser={currentUser} filters={filters} onChange={onChange} />
        )}

        <BlockedOnlyButton filters={filters} onChange={onChange} blockedCount={blockedCount} />

        {/* #852 — scope toggle sits to the left of the search input. Selecting
            "Everywhere" sets ?scope=all AND opens the command palette (until
            #191 ships a dedicated global search surface). While scope=all, the
            board search input is disabled but retains its value, so flipping
            back to "This board" restores the user's search. */}
        {onScopeChange && (
          <SingleSelectDropdown
            label="This board"
            triggerPrefix={<span>🔍</span>}
            options={[
              { value: "board", label: "This board" },
              { value: "all", label: "Everywhere" },
            ]}
            // Pass null when scope is the default "board" so the trigger renders
            // in the neutral (non-active-filter) color. Selecting "Everywhere"
            // flips it to the active-filter styling, which is the correct signal
            // that the user has diverted from the default scope.
            selected={scope === "all" ? "all" : null}
            onChange={(next) => {
              const resolved: "board" | "all" = next === "all" ? "all" : "board";
              onScopeChange(resolved);
              if (resolved === "all") {
                window.dispatchEvent(new CustomEvent("visiban:open-palette"));
              }
            }}
          />
        )}

        <div className="flex flex-col shrink-0">
          <div className="relative shrink-0">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search cards on this board…"
              value={filters.search}
              disabled={searchDisabled}
              title={searchDisabled ? "Switch scope to \"This board\" to search here" : undefined}
              aria-describedby={searchDisabled ? "filterbar-search-helper" : undefined}
              onChange={(e) => onChange({ ...filters, search: e.target.value })}
              data-board-search="true"
              aria-keyshortcuts="/"
              className="bg-surface border border-line rounded px-2 py-1 pr-12 text-sm text-fg-secondary placeholder-fg-muted w-36 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent disabled:opacity-40 disabled:cursor-not-allowed"
            />
            {/* `/` chip — makes the shortcut discoverable without needing to
                open the shortcuts overlay. Hidden while typing (filter has
                content), while searching (spinner takes the slot), and while
                the search is disabled (cross-board scope). Always pointer-
                events-none so it can't eat clicks intended for the input. */}
            {filters.search === "" && !isSearching && !searchDisabled && (
              <kbd
                aria-hidden="true"
                className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none inline-block bg-surface-hover text-fg text-xs font-mono leading-none px-1 py-0.5 rounded border border-line-strong"
              >
                /
              </kbd>
            )}
            {isSearching && !searchDisabled && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            )}
          </div>
          {searchDisabled && (
            <span id="filterbar-search-helper" className="text-xs text-fg-muted mt-0.5">
              Searching across all your boards
            </span>
          )}
        </div>

        {/* #964 — "+ Filter" replaces the four always-visible built-in facet
            dropdowns (Assignee/Label/Priority/Due date). Picking a facet here
            reveals its own control below (two-click flow, matching
            "+ Custom fields": pick, then open) — auto-opening the just-picked
            facet's menu would yank focus away from this still-open menu
            while the user may still be checking more facets. The badge
            counts facets with an active VALUE (independent of which are
            currently expanded) so it tracks the same signal as the chip row,
            not the toolbar's open/closed state. hideSelectionSummary keeps
            the trigger's own text pinned to "+ Filter" — without it,
            CheckboxDropdown's default label logic would render "+ Filter:
            Assignee, Label" once facets are picked, a second (and, once the
            badge is present, a conflicting) signal on top of the badge and
            the active border color. */}
        <CheckboxDropdown
          ref={filterMenuTriggerRef}
          label="+ Filter"
          hideSelectionSummary
          badge={activeBuiltInFacetCount || undefined}
          options={FACET_OPTIONS}
          selected={openFacetIds}
          onChange={setOpenFacetIds}
        />

        {FACET_ORDER.filter((id) => openFacetIds.includes(id)).map((id) => {
          switch (id) {
            case "assignee":
              return (
                <CheckboxDropdown
                  key="assignee"
                  label="Assignee"
                  options={[
                    { value: -1, label: "Unassigned" },
                    ...[...assigneeUsers.values()].map((u) => ({ value: u.id, label: userDisplayName(u) })),
                  ]}
                  selected={filters.assigneeIds}
                  onChange={(assigneeIds) => onChange({ ...filters, assigneeIds })}
                  onOpenChange={(open) => handleFacetOpenChange("assignee", open)}
                />
              );
            case "label":
              return (
                <CheckboxDropdown
                  key="label"
                  label="Label"
                  options={board.labels.map((l) => ({ value: l.id, label: l.name, color: l.color }))}
                  selected={filters.labelIds}
                  onChange={(labelIds) => onChange({ ...filters, labelIds })}
                  onOpenChange={(open) => handleFacetOpenChange("label", open)}
                />
              );
            case "priority":
              return (
                <CheckboxDropdown
                  key="priority"
                  label="Priority"
                  options={PRIORITY_OPTIONS}
                  selected={filters.priorities}
                  onChange={(priorities) => onChange({ ...filters, priorities })}
                  onOpenChange={(open) => handleFacetOpenChange("priority", open)}
                />
              );
            case "dueDate":
              return (
                <SingleSelectDropdown
                  key="dueDate"
                  label="Due date"
                  options={DUE_DATE_OPTIONS}
                  selected={filters.dueDate}
                  onChange={(dueDate) => onChange({ ...filters, dueDate: dueDate as FilterState["dueDate"] })}
                  onOpenChange={(open) => handleFacetOpenChange("dueDate", open)}
                />
              );
            case "blocked":
              return (
                <SingleSelectDropdown
                  key="blocked"
                  label="Blocked"
                  options={[{ value: "blocked" as const, label: `Blocked only (${blockedCount})` }]}
                  selected={filters.blockedOnly ? "blocked" : null}
                  onChange={(v) => onChange({ ...filters, blockedOnly: v === "blocked" })}
                  onOpenChange={(open) => handleFacetOpenChange("blocked", open)}
                />
              );
            default:
              return null;
          }
        })}

        {/* #371 — one control per field in visibleCustomFieldFilterIds (seeded
            to the board's pinned fields on first load; see
            usePersistedFilters). All 30 possible fields never get a
            permanent toolbar slot — the "+ Custom fields" picker below adds
            more on demand, matching Maya's "what I filter aligns with what I
            see on the card" mental model for the default set. */}
        {board.custom_field_definitions
          .filter((d) => filters.visibleCustomFieldFilterIds.includes(d.id))
          .sort((a, b) => a.position - b.position)
          .map((def) => (
            <CustomFieldFilterControl
              key={def.id}
              definition={def}
              value={filters.customFields[def.id] ?? emptyCustomFieldFilterValue(def)}
              onChange={(v) => onChange({ ...filters, customFields: { ...filters.customFields, [def.id]: v } })}
            />
          ))}

        {board.custom_field_definitions.length > 0 && (
          <CheckboxDropdown
            label="+ Custom fields"
            options={[...board.custom_field_definitions]
              .sort((a, b) => a.position - b.position)
              .map((d) => ({ value: d.id, label: d.name }))}
            selected={filters.visibleCustomFieldFilterIds}
            // Toggling a field here only shows/hides its control — it does not
            // itself filter anything until that control gets a value, so this
            // never touches `customFields`.
            onChange={(visibleCustomFieldFilterIds) => onChange({ ...filters, visibleCustomFieldFilterIds })}
          />
        )}

        {/* #2205 — hidden when this viewer has no swimlane field to rule on. */}
        {laneFields.length > 0 && (
          <LaneFilterControl
            filter={filters.laneFilter}
            fields={laneFields}
            onChange={(laneFilter) => {
              const next = { ...filters, laneFilter };
              if (!laneFilter) delete next.laneFilter;
              onChange(next);
            }}
            fmt={laneFmt}
            activeRuleCount={laneRuleCount}
            triggerRef={lanesTrigger}
            textChoices={laneTextChoices}
          />
        )}

        {activeCount > 0 && (
          <button
            onClick={() => onChange(EMPTY_FILTER)}
            className="text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover border border-line hover:border-line-emphasis rounded px-2 py-0.5 shrink-0 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-surface"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Row 2: active filter chips (only when at least one chip exists). The
          status beside them is always mounted so its text is announced (#2205). */}
      <div className={`flex items-center gap-1.5 ${chips.length + laneChips.length > 0 || statusText ? "mt-1.5" : ""}`}>
        {chips.length + laneChips.length > 0 && (
          <div ref={chipGroupRef} role="group" aria-label="Active filters" className="flex items-center gap-1.5 flex-wrap min-w-0">
            {chips.map((chip) => (
              <FilterChip key={chip.key} label={chip.label} colorDot={chip.colorDot} avatarUser={chip.avatarUser} onDismiss={chip.onDismiss} />
            ))}
            {laneChips.map((chip, i) => (
              <span key={`lane:${chip.id}`} className="contents">
                {i > 0 && <span className="text-xs text-fg-tertiary">{chip.join}</span>}
                <FilterChip
                  tag="Lanes"
                  label={chip.label}
                  dataLaneChip
                  onDismiss={() => {
                    if (!filters.laneFilter) return;
                    const laneFilter = removeLaneItem(filters.laneFilter, chip.id);
                    const next = { ...filters, laneFilter };
                    if (!laneFilter) delete next.laneFilter;
                    onChange(next);
                    // Focus the chip that takes this one's place, else the Lanes trigger.
                    setTimeout(() => {
                      const remaining = chipGroupRef.current?.querySelectorAll<HTMLElement>("[data-lane-chip]");
                      const target = remaining?.[i] ?? remaining?.[i - 1];
                      (target ?? lanesTrigger.current)?.focus();
                    }, 0);
                  }}
                />
              </span>
            ))}
          </div>
        )}
        <span role="status" aria-live="polite" aria-atomic="true" className="ml-auto text-xs text-fg-tertiary shrink-0 whitespace-nowrap">
          {statusText}
        </span>
      </div>
    </div>
  );
}

interface CustomFieldFilterControlProps {
  definition: CustomFieldDefinition;
  value: CustomFieldFilterValue;
  onChange: (value: CustomFieldFilterValue) => void;
}

/**
 * One toolbar control for one custom field (#371), styling matched to the
 * existing dimension controls (plain `<input>` for text/number/date — the
 * board search input already establishes that inline-input pattern in this
 * toolbar; `CheckboxDropdown` for dropdown/checkbox). A dropdown option's
 * dot matches the card face: the choice's explicit palette color (#1391) as
 * its `base` swatch when one is set, else the same deterministic hash dot as
 * the card-face chip. Multi-select options carry no dot.
 */
function CustomFieldFilterControl({ definition, value, onChange }: CustomFieldFilterControlProps) {
  // URL fields (#1390) filter exactly like text — a "contains" match on the
  // stored address — rather than falling through to the choice dropdown,
  // which would render with no options.
  if ((definition.field_type === "text" || definition.field_type === "url") && value.kind === "text") {
    return (
      <input
        type="text"
        value={value.query}
        onChange={(e) => onChange({ kind: "text", query: e.target.value })}
        placeholder={`${definition.name} contains…`}
        className="bg-surface border border-line rounded px-2 py-1 text-sm text-fg-secondary placeholder-fg-muted w-32 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent shrink-0"
      />
    );
  }

  if (definition.field_type === "multi_select") {
    // #1391 — the same CheckboxDropdown as a dropdown field; only the
    // matching in filterCards differs (exact membership in the stored array).
    return (
      <CheckboxDropdown
        label={definition.name}
        // No color dot: a multi-select entry never shows a dot anywhere (an
        // explicitly colored one is a tinted chip, an uncolored one neutral).
        options={definition.choices.map((c) => ({ value: c, label: c }))}
        selected={value.kind === "multi_choice" ? value.values : []}
        onChange={(values) => onChange({ kind: "multi_choice", values })}
      />
    );
  }

  if ((definition.field_type === "number" || definition.field_type === "date") && (value.kind === "number" || value.kind === "date")) {
    return (
      <input
        type={definition.field_type === "number" ? "number" : "date"}
        value={value.equals}
        onChange={(e) => onChange({ kind: definition.field_type as "number" | "date", equals: e.target.value })}
        title={definition.name}
        className={`bg-surface border border-line rounded px-2 py-1 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent shrink-0 ${
          definition.field_type === "number" ? "w-24" : "w-32"
        }`}
      />
    );
  }

  // dropdown / checkbox — both use the "choice" multi-select shape.
  const options =
    definition.field_type === "checkbox"
      ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
      : definition.choices.map((c) => {
          const key = explicitChoiceColor(definition, c);
          return { value: c, label: c, color: key ? CHOICE_COLORS[key].base : choiceColor(c) };
        });
  const selected = value.kind === "choice" ? value.values : [];

  return (
    <CheckboxDropdown
      label={definition.name}
      options={options}
      selected={selected}
      onChange={(values) => onChange({ kind: "choice", values })}
    />
  );
}
