import { useEffect, useRef, useState } from "react";
import type { BoardUser, CardChecklistItem } from "../../types";
import Avatar from "../Common/Avatar";
import { userDisplayName } from "../../types";

/** The two always-visible trailing controls on a checklist row (#445, design § 5).
 *
 * Always visible rather than hover-revealed so an occasional user finds them
 * (the #371 logic). The assignee button opens a member picker limited to the
 * board's assignable members (the server enforces the same set); the due
 * button opens today's native date input until #243 ships the styled picker.
 */
interface Props {
  item: CardChecklistItem;
  /** Assignable members only (`isAssignableMember`). */
  members: BoardUser[];
  /** False for viewers and for items the user may not modify (creator-only gate). */
  canEdit: boolean;
  /** `YYYY-MM-DD` in the viewer's timezone. */
  today: string;
  onSave: (patch: { assignee_id?: number | null; due_date?: string | null }) => void;
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));

function dayParts(iso: string): [number, number] {
  const [, m, d] = iso.split("-").map(Number);
  return [m - 1, d];
}

export function formatChecklistDue(iso: string, long = false): string {
  const [m, d] = dayParts(iso);
  return `${(long ? MONTHS_LONG : MONTHS_SHORT)[m]} ${d}`;
}

const ICON_BUTTON =
  "shrink-0 inline-flex items-center gap-1 rounded px-1 h-6 text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover transition " +
  "focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:cursor-default disabled:hover:bg-transparent";

export default function ChecklistItemControls({ item, members, canEdit, today, onSave }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const assigneeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  const assignee = item.assignee;
  const assigneeName = assignee ? userDisplayName(assignee) : null;
  // A former member keeps the assignment (same rule as a card's assignee);
  // the row says so instead of silently showing them as assignable.
  const notAssignable = assignee != null && !members.some((m) => m.id === assignee.id);
  const assigneeLabel = assigneeName
    ? `Assigned to ${assigneeName}${notAssignable ? " (no longer a board member)" : ""}. Change assignee for ${item.text}`
    : `Assign ${item.text}`;

  const overdue = item.due_date != null && !item.is_checked && item.due_date < today;
  const dueLabel = item.due_date
    ? `Due ${formatChecklistDue(item.due_date, true)}${overdue ? ", overdue" : ""}. Change due date for ${item.text}`
    : `Set due date for ${item.text}`;

  const closePicker = () => {
    setPickerOpen(false);
    assigneeButtonRef.current?.focus();
  };
  const choose = (id: number | null) => {
    closePicker();
    if (id !== (assignee?.id ?? null)) onSave({ assignee_id: id });
  };

  return (
    <>
      <div className="relative" ref={pickerRef}>
        <button
          ref={assigneeButtonRef}
          type="button"
          className={ICON_BUTTON}
          aria-label={assigneeLabel}
          title={canEdit ? assigneeLabel : assigneeName ? `Assigned to ${assigneeName}` : undefined}
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          disabled={!canEdit}
          onClick={() => setPickerOpen((o) => !o)}
        >
          {assignee ? (
            <Avatar user={assignee} size="xs" className={notAssignable ? "opacity-60" : ""} />
          ) : (
            <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <circle cx="10" cy="7" r="3" />
              <path d="M4 17c0-3.3 2.7-5 6-5s6 1.7 6 5" strokeLinecap="round" />
            </svg>
          )}
        </button>
        {pickerOpen && (
          <ul
            role="listbox"
            aria-label={`Assignee for ${item.text}`}
            className="absolute right-0 z-20 mt-1 w-48 max-h-60 overflow-auto bg-surface border border-line rounded-md shadow-lg py-1"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closePicker();
              }
            }}
          >
            {[{ id: null as number | null, name: "Unassigned" }, ...members.map((m) => ({ id: m.id as number | null, name: userDisplayName(m) }))].map((opt, i) => (
              <li key={opt.id ?? "none"} role="option" aria-selected={(assignee?.id ?? null) === opt.id}>
                <button
                  type="button"
                  autoFocus={i === 0}
                  className="w-full text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  onClick={() => choose(opt.id)}
                >
                  {opt.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {dateOpen && canEdit ? (
        <input
          type="date"
          autoFocus
          aria-label={dueLabel}
          defaultValue={item.due_date ?? ""}
          className="shrink-0 text-xs bg-surface border border-line rounded px-1 h-6 text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDateOpen(false);
            }
          }}
          onBlur={(e) => {
            setDateOpen(false);
            const next = e.target.value || null;
            if (next !== item.due_date) onSave({ due_date: next });
          }}
        />
      ) : (
        <button
          type="button"
          className={`${ICON_BUTTON} ${overdue ? "text-danger hover:text-danger" : ""}`}
          aria-label={dueLabel}
          title={canEdit ? dueLabel : undefined}
          disabled={!canEdit}
          onClick={() => setDateOpen(true)}
        >
          {item.due_date ? (
            <span>{overdue && <span aria-hidden="true">⚑ </span>}{formatChecklistDue(item.due_date)}</span>
          ) : (
            <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <rect x="3.5" y="4.5" width="13" height="12" rx="1.5" />
              <path d="M3.5 8.5h13M7 3v3M13 3v3" strokeLinecap="round" />
            </svg>
          )}
        </button>
      )}
    </>
  );
}
