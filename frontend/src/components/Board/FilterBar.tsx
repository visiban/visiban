import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { BoardFull, Priority } from "../../types";
import { userDisplayName } from "../../types";

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

interface SingleSelectDropdownProps<T extends string | number> {
  label: string;
  options: { value: T; label: string }[];
  selected: T | null;
  onChange: (selected: T | null) => void;
}

function SingleSelectDropdown<T extends string | number>({ label, options, selected, onChange }: SingleSelectDropdownProps<T>) {
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

  const displayLabel = selected === null
    ? label
    : options.find((o) => o.value === selected)?.label ?? label;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`bg-slate-800 border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition ${
          selected !== null ? "border-blue-400 text-blue-400" : "border-slate-600 text-slate-300 hover:border-slate-400"
        }`}
      >
        {displayLabel}
        <svg className="w-3 h-3 text-slate-500" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 min-w-[140px]">
          {options.map((opt, i) => (
            <div key={opt.value}>
              {i > 0 && (
                <div role="separator" className="mx-4">
                  <div className="h-px bg-slate-900" />
                  <div className="h-px bg-slate-600/50" />
                </div>
              )}
              <button
                onClick={() => { onChange(selected === opt.value ? null : opt.value); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-slate-700 text-sm transition ${
                  selected === opt.value ? "text-blue-400" : "text-slate-300"
                }`}
              >
                {opt.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
        className={`bg-slate-800 border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition ${
          selected.length > 0 ? "border-blue-400 text-blue-400" : "border-slate-600 text-slate-300 hover:border-slate-400"
        }`}
      >
        {displayLabel}
        <svg className="w-3 h-3 text-slate-500" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 min-w-[140px]">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500 italic">No labels on this board</p>
          ) : options.map((opt, i) => (
            <div key={opt.value}>
              {i > 0 && (
                <div role="separator" className="mx-4">
                  <div className="h-px bg-slate-900" />
                  <div className="h-px bg-slate-600/50" />
                </div>
              )}
              <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700 cursor-pointer text-sm text-slate-300">
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
            </div>
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
  searchRef?: RefObject<HTMLInputElement | null>;
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

export default function FilterBar({ board, filters, onChange, searchRef }: Props) {
  const activeCount = countActiveFilters(filters);

  return (
    <>
      <span className="w-px h-4 bg-slate-600 shrink-0" />

      <input
        ref={searchRef}
        type="text"
        placeholder="Search cards…"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-300 placeholder-slate-500 w-36 outline-none focus:border-blue-400 shrink-0"
      />

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
