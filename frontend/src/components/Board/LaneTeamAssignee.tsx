import { useEffect, useId, useRef, useState } from "react";
import Avatar from "../Common/Avatar";
import type { User } from "../../types";
import { memberName } from "../../utils/swimlaneDefaultTeam";

type Person = Pick<User, "id" | "username" | "display_name" | "avatar_url">;

interface Props {
  /** The lane team's pre-assigned person (shown as a chip while assigned). */
  assignee: Person;
  /** False once "Unassign NAME" was used: the card is then created unassigned. */
  assigned: boolean;
  /** Other team members: named in the caption, not assigned (#2206 decision G). */
  others: string[];
  /** The surface's caption: where the pre-assignment came from. Kept after Unassign. */
  caption: string;
  onUnassign: () => void;
  /** The "+ Add" pill: assigns the pre-assigned person again. */
  onReassign: () => void;
  /** Phone surfaces use 14px text and 44px targets; desktop cells 12px. */
  size?: "sm" | "md";
}

/**
 * The Assignees group on a card create surface (#2211): the lane team's pre-assigned member as a
 * removable chip, then a "+ Add" pill, and a caption naming the source. Pre-assignment is never
 * silent. A card has one assignee (#2206 decision G), so "+ Add" appears once the chip is removed
 * and puts the same person back; picking anyone else is card detail's job.
 *
 * Unassign and "+ Add" each remove the control that was used, so focus moves to the control that
 * replaces it (the pill, or the chip's Unassign) and a polite status line announces the change;
 * otherwise focus would fall to <body> (ux-review, frontend/CLAUDE.md "a control that removes itself").
 */
export default function LaneTeamAssignee({
  assignee, assigned, others, caption, onUnassign, onReassign, size = "sm",
}: Props) {
  const text = size === "md" ? "text-sm" : "text-xs";
  // 44px targets at the phone/dialog size; the 12px desktop cell keeps a 24px target so the chip
  // does not overflow its pill (WCAG 2.5.8 minimum).
  const target = size === "md" ? "min-h-11 min-w-11" : "h-6 w-6";
  const name = memberName(assignee);
  const notAssigned = others.length > 0 ? ` Also on the team, not assigned: ${others.join(", ")}.` : "";
  const labelId = useId();
  const captionId = useId();
  const unassignRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [announce, setAnnounce] = useState("");
  // Set by a click, so the first render (and a parent reset) never steals focus.
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (assigned ? unassignRef : addRef).current?.focus();
  }, [assigned]);

  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={captionId} className="flex flex-col gap-1 mt-1.5">
      <span id={labelId} className={`${text} text-fg-secondary`}>Assignees</span>
      <div className="flex flex-wrap items-center gap-1">
        {assigned ? (
          <span className={`inline-flex items-center gap-1.5 pl-1 rounded-full border border-line bg-surface ${text} text-fg`}>
            <Avatar user={assignee} size="sm" />
            <span className="truncate max-w-40">{name}</span>
            <button
              ref={unassignRef}
              type="button"
              aria-label={`Unassign ${name}`}
              onClick={() => { moveFocus.current = true; setAnnounce(`${name} unassigned.`); onUnassign(); }}
              className={`${target} inline-flex items-center justify-center rounded-full text-fg-muted hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        ) : (
          <>
            <span className={`${text} text-fg-muted`}>No one assigned.</span>
            <button
              ref={addRef}
              type="button"
              aria-label={`Add ${name}`}
              onClick={() => { moveFocus.current = true; setAnnounce(`${name} assigned.`); onReassign(); }}
              className={`${size === "md" ? "min-h-11" : "min-h-6"} px-2.5 inline-flex items-center rounded-full border border-dashed border-line-strong ${text} text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
            >
              <span aria-hidden="true">+ Add</span>
            </button>
          </>
        )}
      </div>
      <p id={captionId} className="text-xs text-fg-muted">{caption}{notAssigned}</p>
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
    </div>
  );
}
