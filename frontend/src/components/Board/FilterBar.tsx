import type { RefObject } from "react";
import type { BoardFull, Priority } from "../../types";
import { userDisplayName } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import CheckboxDropdown from "../Common/CheckboxDropdown";

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

export default function FilterBar({ board, filters, onChange, searchRef, isSearching }: Props) {
  const activeCount = countActiveFilters(filters);

  return (
    <>
      <span className="w-px h-4 bg-slate-600 shrink-0" />

      <div className="relative shrink-0">
        <input
          ref={searchRef}
          type="text"
          placeholder="Search cards…"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onChange({ ...filters, search: "" }); (e.target as HTMLInputElement).blur(); } }}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 pr-7 text-sm text-slate-300 placeholder-slate-500 w-36 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        {isSearching && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
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
          className="text-xs text-slate-500 hover:text-slate-300 underline shrink-0 transition"
        >
          Clear all
        </button>
      )}
    </>
  );
}
