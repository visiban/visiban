import Avatar from "../Common/Avatar";
import type { User } from "../../types";
import { memberName } from "../../utils/swimlaneDefaultTeam";

interface Props {
  /** The pre-assigned person, or null once removed. */
  assignee: Pick<User, "id" | "username" | "display_name" | "avatar_url"> | null;
  /** Other team members: named in the caption, not assigned (#2206 decision G). */
  others: string[];
  /** The surface's caption: where the pre-assignment came from. */
  caption: string;
  onUnassign: () => void;
  /** Phone surfaces use 14px text; desktop cells 12px. */
  size?: "sm" | "md";
}

/**
 * The Assignees group on a card create surface (#2211): the lane team's pre-assigned member as a
 * removable chip, and a caption naming the source. Pre-assignment is never silent. The remove
 * target is 44px ("Unassign NAME"); once removed, the card is created unassigned.
 */
export default function LaneTeamAssignee({ assignee, others, caption, onUnassign, size = "sm" }: Props) {
  const text = size === "md" ? "text-sm" : "text-xs";
  const notAssigned = others.length > 0 ? ` Also on the team, not assigned: ${others.join(", ")}.` : "";
  return (
    <div role="group" aria-label="Assignees" className="flex flex-col gap-1 mt-1.5">
      <span className={`${text} text-fg-secondary`}>Assignees</span>
      {assignee ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className={`inline-flex items-center gap-1.5 pl-1 rounded-full border border-line bg-surface ${text} text-fg`}>
            <Avatar user={assignee} size="sm" />
            <span className="truncate max-w-40">{memberName(assignee)}</span>
            <button
              type="button"
              aria-label={`Unassign ${memberName(assignee)}`}
              onClick={onUnassign}
              className="min-h-11 min-w-11 -my-2.5 inline-flex items-center justify-center rounded-full text-fg-muted hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        </div>
      ) : (
        <span className={`${text} text-fg-muted`}>No one. You can assign someone in card detail afterward.</span>
      )}
      {assignee && <p className="text-xs text-fg-muted">{caption}{notAssigned}</p>}
    </div>
  );
}
