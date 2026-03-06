import { useEffect, useRef, useState } from "react";
import type { BoardFull, Priority } from "../../types";
import { userDisplayName } from "../../types";

export interface FilterState {
  search: string;
  assigneeId: number | null; // -1 = unassigned
  labelIds: number[];
  priorities: Priority[];
  dueDate: "overdue" | "today" | "this_week" | "none" | null;
}

export const EMPTY_FILTER: FilterState = {
  search: "",
  assigneeId: null,
  labelIds: [],
  priorities: [],
  dueDate: null,
};

export function countActiveFilters(f: FilterState): number {
  return [
    f.search !== "",
    f.assigneeId !== null,
    f.labelIds.length > 0,
    f.priorities.length > 0,
    f.dueDate !== null,
  ].filter(Boolean).length;
}

interface CheckboxDropdownProps<T extends string | number> {
  label: string;
  options: { value: T; label: string; color?: string }[];
  selected: T[];
  onChange: (selected: T[]) => void;
}

function CheckboxDropdown<T extends string | number>({ label, options, selected, onChange }: CheckboxDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = (value: T) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const displayLabel = selected.length === 0
    ? label
    : selected.length === options.length
    ? `${label}: All`
    : `${label}: ${selected.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ")}`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`border rounded px-2 py-1 text-sm bg-white outline-none flex items-center gap-1 ${
          selected.length > 0 ? "border-blue-400 text-blue-700" : "border-gray-300 text-gray-700"
        } hover:border-blue-400 transition`}
      >
        {displayLabel}
        <svg className="w-3 h-3 text-gray-400" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]">
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-sm text-gray-700"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
                className="rounded"
              />
              {opt.color && (
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: opt.color }} />
              )}
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  board: BoardFull;
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: "low", label: "Low", color: "#6B7280" },
  { value: "medium", label: "Medium", color: "#3B82F6" },
  { value: "high", label: "High", color: "#F59E0B" },
  { value: "urgent", label: "Urgent", color: "#EF4444" },
];

export default function FilterBar({ board, filters, onChange }: Props) {
  const activeCount = countActiveFilters(filters);
  const sel = "border border-gray-300 rounded px-2 py-1 text-sm bg-white outline-none focus:border-blue-400";

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-200 text-sm flex-wrap shrink-0">
      <input
        type="text"
        placeholder="Search cards…"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        className="border border-gray-300 rounded px-2 py-1 text-sm w-40 outline-none focus:border-blue-400"
      />

      <select
        value={filters.assigneeId ?? ""}
        onChange={(e) => onChange({ ...filters, assigneeId: e.target.value === "" ? null : Number(e.target.value) })}
        className={sel}
      >
        <option value="">Assignee</option>
        <option value="-1">Unassigned</option>
        {board.members.map((m) => (
          <option key={m.user.id} value={m.user.id}>
            {userDisplayName(m.user)}
          </option>
        ))}
      </select>

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

      <select
        value={filters.dueDate ?? ""}
        onChange={(e) => onChange({ ...filters, dueDate: (e.target.value as FilterState["dueDate"]) || null })}
        className={sel}
      >
        <option value="">Due date</option>
        <option value="overdue">Overdue</option>
        <option value="today">Today</option>
        <option value="this_week">Due this week</option>
        <option value="none">No due date</option>
      </select>

      {activeCount > 0 && (
        <>
          <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
            {activeCount} active
          </span>
          <button
            onClick={() => onChange(EMPTY_FILTER)}
            className="text-xs text-gray-500 hover:text-gray-700 underline"
          >
            Clear all
          </button>
        </>
      )}
    </div>
  );
}
