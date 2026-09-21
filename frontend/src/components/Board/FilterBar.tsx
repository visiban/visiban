import { useRef, useState, type RefObject } from "react";
import type { BoardFull, BoardUser, CustomFieldDefinition, Priority, User } from "../../types";
import { userDisplayName } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import CheckboxDropdown from "../Common/CheckboxDropdown";
import Avatar from "../Common/Avatar";
import FilterChip from "./FilterChip";
import { choiceColor, formatCustomFieldValue } from "../../utils/customFieldValue";

// #371 — one filter value per custom field, keyed by field_definition id in
// FilterState.customFields. Number/date are equality-only (the value is
// stored as TextField server-side, so a range comparison would be
// lexicographic, not numeric — out of scope for this phase, see the ux-design
// spec's explicit non-goal). Dropdown and checkbox share the multi-select
// "choice" shape since a checkbox is just a 2-choice dropdown for filtering
// purposes.
export type CustomFieldFilterValue =
  | { kind: "text"; query: string }
  | { kind: "number" | "date"; equals: string }
  | { kind: "choice"; values: string[] };

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
};

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, co-located with the component for cohesion
export function isCustomFieldFilterActive(v: CustomFieldFilterValue): boolean {
  return v.kind === "choice" ? v.values.length > 0 : v.kind === "text" ? v.query !== "" : v.equals !== "";
}

function emptyCustomFieldFilterValue(def: CustomFieldDefinition): CustomFieldFilterValue {
  switch (def.field_type) {
    case "number":
    case "date":
      return { kind: def.field_type, equals: "" };
    case "dropdown":
    case "checkbox":
      return { kind: "choice", values: [] };
    case "text":
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
}

interface MyCardsButtonProps {
  currentUser: User;
  filters: FilterState;
  onChange: (filters: FilterState) => void;
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
          ? "border-info text-info"
          : "border-line-strong text-fg-secondary hover:border-line-emphasis"
      }`}
    >
      <Avatar user={currentUser} size="xs" />
      My cards
    </button>
  );
}

const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: "low", label: "Low", color: "#6B7280" },
  { value: "medium", label: "Medium", color: "#3B82F6" },
  { value: "high", label: "High", color: "#F59E0B" },
  { value: "urgent", label: "Urgent", color: "#EF4444" },
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
type FacetId = "assignee" | "label" | "priority" | "dueDate";
const FACET_ORDER: FacetId[] = ["assignee", "label", "priority", "dueDate"];
const FACET_OPTIONS: { value: FacetId; label: string }[] = [
  { value: "assignee", label: "Assignee" },
  { value: "label", label: "Label" },
  { value: "priority", label: "Priority" },
  { value: "dueDate", label: "Due date" },
];

export default function FilterBar({ board, filters, onChange, searchRef, isSearching, currentUser, hiddenCount = 0, scope = "board", onScopeChange }: Props) {
  const activeCount = countActiveFilters(filters);
  const searchDisabled = scope === "all";

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

  const handleFacetOpenChange = (id: FacetId, open: boolean) => {
    if (open) return;
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

  for (const assigneeId of filters.assigneeIds) {
    if (assigneeId === -1) {
      chips.push({
        key: "assignee:-1",
        label: "Unassigned",
        onDismiss: () => onChange({ ...filters, assigneeIds: filters.assigneeIds.filter((id) => id !== -1) }),
      });
    } else {
      const member = board.members.find((m) => m.user.id === assigneeId);
      if (member) {
        chips.push({
          key: `assignee:${assigneeId}`,
          label: userDisplayName(member.user),
          avatarUser: member.user,
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

  // #371 — custom field filter chips. Dismissing clears the value but keeps
  // the field in visibleCustomFieldFilterIds so its (now-empty) control
  // doesn't disappear mid-interaction.
  for (const def of board.custom_field_definitions) {
    const v = filters.customFields[def.id];
    if (!v || !isCustomFieldFilterActive(v)) continue;
    const displayValue = v.kind === "choice" ? v.values.join(", ") : v.kind === "text" ? v.query : formatCustomFieldValue(def, v.equals, "MM/DD/YYYY");
    chips.push({
      key: `cf:${def.id}`,
      label: `${def.name}: ${displayValue}`,
      onDismiss: () => onChange({ ...filters, customFields: { ...filters.customFields, [def.id]: emptyCustomFieldFilterValue(def) } }),
    });
  }

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {/* Row 1: filter controls */}
      <div className="flex items-center gap-2 flex-wrap" onKeyDown={handleRow1KeyDown}>
        <span className="w-px h-4 bg-surface-active shrink-0" />

        {currentUser && (
          <MyCardsButton currentUser={currentUser} filters={filters} onChange={onChange} />
        )}

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
              onKeyDown={(e) => { if (e.key === "Escape") { onChange({ ...filters, search: "" }); (e.target as HTMLInputElement).blur(); } }}
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
                    ...board.members.map((m) => ({ value: m.user.id, label: userDisplayName(m.user) })),
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

        {activeCount > 0 && (
          <button
            onClick={() => onChange(EMPTY_FILTER)}
            className="text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover border border-line hover:border-line-emphasis rounded px-2 py-0.5 shrink-0 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-surface"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Row 2: active filter chips (only when at least one chip exists) */}
      {chips.length > 0 && (
        <div role="group" aria-label="Active filters" className="flex items-center gap-1.5 flex-wrap">
          {chips.map((chip) => (
            <FilterChip key={chip.key} label={chip.label} colorDot={chip.colorDot} avatarUser={chip.avatarUser} onDismiss={chip.onDismiss} />
          ))}
          {hiddenCount > 0 && (
            <span role="status" aria-live="polite" aria-atomic="true" className="ml-auto text-xs text-fg-tertiary shrink-0 whitespace-nowrap">
              {hiddenCount} card{hiddenCount !== 1 ? "s" : ""} hidden
            </span>
          )}
        </div>
      )}
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
 * toolbar; `CheckboxDropdown` for dropdown/checkbox, sharing the same
 * deterministic color-dot helper as the card-face chip so a choice reads
 * consistently in both places).
 */
function CustomFieldFilterControl({ definition, value, onChange }: CustomFieldFilterControlProps) {
  if (definition.field_type === "text" && value.kind === "text") {
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

  if ((definition.field_type === "number" || definition.field_type === "date") && value.kind !== "choice" && value.kind !== "text") {
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
      : definition.choices.map((c) => ({ value: c, label: c, color: choiceColor(c) }));
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
