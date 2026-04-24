import type { RefObject } from "react";
import type { BoardFull, BoardUser, Priority, User } from "../../types";
import { userDisplayName } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import CheckboxDropdown from "../Common/CheckboxDropdown";
import Avatar from "../Common/Avatar";
import FilterChip from "./FilterChip";

export interface FilterState {
  search: string;
  assigneeIds: number[]; // -1 = unassigned
  labelIds: number[];
  priorities: Priority[];
  dueDate: "overdue" | "today" | "this_week" | "none" | null;
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, co-located with the component for cohesion
export const EMPTY_FILTER: FilterState = {
  search: "",
  assigneeIds: [],
  labelIds: [],
  priorities: [],
  dueDate: null,
};

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, co-located with the component for cohesion
export function countActiveFilters(f: FilterState): number {
  return [
    f.search !== "",
    f.assigneeIds.length > 0,
    f.labelIds.length > 0,
    f.priorities.length > 0,
    f.dueDate !== null,
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
      className={`bg-surface border rounded px-2 py-1 text-sm focus:outline-none flex items-center gap-1.5 transition shrink-0 focus-visible:ring-2 focus-visible:ring-primary-emphasis focus-visible:ring-offset-1 focus-visible:ring-offset-sunken ${
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

export default function FilterBar({ board, filters, onChange, searchRef, isSearching, currentUser, hiddenCount = 0, scope = "board", onScopeChange }: Props) {
  const activeCount = countActiveFilters(filters);
  const searchDisabled = scope === "all";

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

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {/* Row 1: filter controls */}
      <div className="flex items-center gap-2 flex-wrap">
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
                className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none inline-block bg-surface-hover text-fg text-[10px] font-mono leading-none px-1 py-0.5 rounded border border-line-strong"
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

        <CheckboxDropdown
          label="Assignee"
          options={[
            { value: -1, label: "Unassigned" },
            ...board.members.map((m) => ({ value: m.user.id, label: userDisplayName(m.user) })),
          ]}
          selected={filters.assigneeIds}
          onChange={(assigneeIds) => onChange({ ...filters, assigneeIds })}
        />

        <CheckboxDropdown
          label="Label"
          options={board.labels.map((l) => ({ value: l.id, label: l.name, color: l.color }))}
          selected={filters.labelIds}
          onChange={(labelIds) => onChange({ ...filters, labelIds })}
        />

        <CheckboxDropdown
          label="Priority"
          options={PRIORITY_OPTIONS}
          selected={filters.priorities}
          onChange={(priorities) => onChange({ ...filters, priorities })}
        />

        <SingleSelectDropdown
          label="Due date"
          options={DUE_DATE_OPTIONS}
          selected={filters.dueDate}
          onChange={(dueDate) => onChange({ ...filters, dueDate: dueDate as FilterState["dueDate"] })}
        />

        {activeCount > 0 && (
          <button
            onClick={() => onChange(EMPTY_FILTER)}
            className="text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover border border-line hover:border-line-emphasis rounded px-2 py-0.5 shrink-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
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
