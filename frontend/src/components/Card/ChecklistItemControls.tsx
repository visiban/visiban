import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardUser, CardChecklistItem } from "../../types";
import Avatar from "../Common/Avatar";
import SelectedCheck from "../Common/SelectedCheck";
import { userDisplayName } from "../../types";

/** The two always-visible trailing controls on a checklist row (#445, design § 5).
 *
 * Always visible rather than hover-revealed so an occasional user finds them
 * (the #371 logic). A user who cannot edit the item sees only the values that
 * are set, as plain text. The assignee button opens a member picker limited to the
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

// Fixed 24px minimum target in both axes (frontend/CLAUDE.md "Checklist item
// trailing controls"). Tone is passed separately so an element never carries
// two competing text-* utilities.
const CONTROL_BASE =
  "shrink-0 inline-flex items-center justify-center gap-1 rounded px-1 h-6 min-w-6 text-xs transition " +
  "focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const NEUTRAL_TONE = "text-fg-tertiary group-hover:text-fg-secondary hover:text-fg hover:bg-surface-hover";
const DANGER_TONE = "text-danger hover:bg-surface-hover";

export default function ChecklistItemControls({ item, members, canEdit, today, onSave }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const assigneeButtonRef = useRef<HTMLButtonElement>(null);
  // Escape unmounts the date input, and some browsers fire blur on unmount;
  // the flag keeps that blur from saving the value the user just abandoned.
  const dateCancelledRef = useRef(false);

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
  const assignedText = assigneeName
    ? `Assigned to ${assigneeName}${notAssignable ? " (no longer a board member)" : ""}`
    : null;
  const assigneeLabel = assignedText ? `${assignedText}. Change assignee for ${item.text}` : `Assign ${item.text}`;

  const overdue = item.due_date != null && !item.is_checked && item.due_date < today;
  const dueText = item.due_date ? `Due ${formatChecklistDue(item.due_date, true)}${overdue ? ", overdue" : ""}` : null;
  const dueLabel = dueText ? `${dueText}. Change due date for ${item.text}` : `Set due date for ${item.text}`;
  const dueTone = overdue ? DANGER_TONE : NEUTRAL_TONE;

  const closePicker = () => {
    setPickerOpen(false);
    assigneeButtonRef.current?.focus();
  };
  // Escape goes through the stack, never an onKeyDown: the document-level stack
  // fires after React's handler, so without an entry the card panel closes too.
  // 34.5 / 34.6 sit above the panel close (30) and clear every integer card tier
  // (frontend/CLAUDE.md, Escape priority inside the card detail panel).
  useEscapeStack(() => {
    if (!pickerOpen) return false;
    closePicker();
  }, 34.5);
  useEscapeStack(() => {
    if (!dateOpen) return false;
    dateCancelledRef.current = true;
    setDateOpen(false);
  }, 34.6);
  const choose = (id: number | null) => {
    closePicker();
    if (id !== (assignee?.id ?? null)) onSave({ assignee_id: id });
  };

  const dueContent = item.due_date ? (
    <span>{overdue && <span aria-hidden="true">⚑ </span>}{formatChecklistDue(item.due_date)}</span>
  ) : null;

  // Read-only users (viewers, or members on an item they did not create) never
  // see a dimmed control they cannot use: an empty value renders nothing, a set
  // value renders as plain text (frontend/CLAUDE.md, #445 ux-review).
  if (!canEdit) {
    return (
      <>
        {assignee && assignedText && (
          <span className="shrink-0 inline-flex items-center justify-center h-6 min-w-6" title={assignedText}>
            <Avatar user={assignee} size="xs" className={notAssignable ? "opacity-60" : ""} />
            <span className="sr-only">{assignedText}</span>
          </span>
        )}
        {dueContent && dueText && (
          <span className={`shrink-0 inline-flex items-center h-6 px-1 text-xs ${overdue ? "text-danger" : "text-fg-tertiary group-hover:text-fg-secondary"}`} title={dueText}>
            <span aria-hidden="true">{dueContent}</span>
            <span className="sr-only">{dueText}</span>
          </span>
        )}
      </>
    );
  }

  // A former member stays selected by name, like the card's assignee picker
  // (#1714), so "Unassigned" is never marked pressed for an assigned item.
  const options = [
    { id: null as number | null, name: "Unassigned" },
    ...members.map((m) => ({ id: m.id as number | null, name: userDisplayName(m) })),
    ...(assignee && notAssignable
      ? [{ id: assignee.id as number | null, name: `${userDisplayName(assignee)} (no longer a board member)` }]
      : []),
  ];
  const selectedIndex = options.findIndex((o) => o.id === (assignee?.id ?? null));

  return (
    <>
      <div className="relative" ref={pickerRef}>
        <button
          ref={assigneeButtonRef}
          type="button"
          className={`${CONTROL_BASE} ${NEUTRAL_TONE}`}
          aria-label={assigneeLabel}
          title={assigneeLabel}
          aria-haspopup="true"
          aria-expanded={pickerOpen}
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
          // A plain list of toggle buttons (aria-pressed), not a listbox: a
          // listbox option may not contain a button (#445 ux-review).
          <ul
            ref={listRef}
            aria-label={`Assignee for ${item.text}`}
            className="absolute right-0 z-20 mt-1 w-48 max-h-60 overflow-auto bg-surface border border-line rounded-md shadow-lg py-1"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const buttons = Array.from(listRef.current?.querySelectorAll("button") ?? []);
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === "ArrowDown" ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1);
              buttons[next]?.focus();
            }}
          >
            {options.map((opt, i) => {
              const selected = i === selectedIndex;
              return (
                <li key={opt.id ?? "none"}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    autoFocus={selected}
                    className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
                    onClick={() => choose(opt.id)}
                  >
                    <SelectedCheck selected={selected} testId="checklist-assignee-check" slotClassName="w-3 shrink-0 inline-flex" />
                    {opt.name}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {dateOpen ? (
        <input
          type="date"
          autoFocus
          aria-label={dueLabel}
          defaultValue={item.due_date ?? ""}
          className="shrink-0 text-xs bg-surface border border-line rounded px-1 h-6 text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            setDateOpen(false);
            if (dateCancelledRef.current) {
              dateCancelledRef.current = false;
              return;
            }
            const next = e.target.value || null;
            if (next !== item.due_date) onSave({ due_date: next });
          }}
        />
      ) : (
        <button
          type="button"
          className={`${CONTROL_BASE} ${dueTone}`}
          aria-label={dueLabel}
          title={dueLabel}
          onClick={() => {
            dateCancelledRef.current = false;
            setDateOpen(true);
          }}
        >
          {dueContent ?? (
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
