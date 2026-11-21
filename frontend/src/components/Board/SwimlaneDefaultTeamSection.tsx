import { useId } from "react";
import type { EffectiveBoardMember } from "../../types";
import Avatar from "../Common/Avatar";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import { assignableMembers } from "../../utils/swimlaneDefaultTeam";

/** Shown in Edit swimlane and checked by tests; one text on desktop and phone (#2211). */
export const DEFAULT_TEAM_HELP =
  "Pre-assigned to new cards and new children created in this lane. Existing cards don't change. " +
  "A person who can't open a child board used by this lane's parents is skipped when a child is " +
  "created there; remove them or give them access to clear this warning.";

interface Props {
  members: EffectiveBoardMember[];
  value: number[];
  onChange: (ids: number[]) => void;
}

/** The Default team section of Edit swimlane (#2211): rows, Remove, Add a member. */
export default function SwimlaneDefaultTeamSection({ members, value, onChange }: Props) {
  const headingId = useId();
  const byId = new Map(members.map((m) => [m.user.id, m.user]));
  const candidates = assignableMembers(members).filter((m) => !value.includes(m.user.id));
  const count = `${value.length} ${value.length === 1 ? "person" : "people"}`;

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">
        Default team <span className="ml-1.5 normal-case font-normal text-fg-muted">{count}</span>
      </h3>
      {value.length > 0 && (
        <ul role="group" aria-label="Default team" className="flex flex-col mb-2">
          {value.map((id) => {
            const user = byId.get(id);
            if (!user) return null;
            const name = user.display_name || user.username;
            return (
              <li key={id} className="flex items-center gap-2 min-h-11">
                <Avatar user={user} size="sm" />
                <span className="flex-1 min-w-0 truncate text-sm text-fg">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name} from default team`}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                  className="min-h-11 min-w-11 inline-flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {candidates.length > 0 ? (
        <SingleSelectDropdown<number>
          label="Add a member"
          options={candidates.map((m) => ({ value: m.user.id, label: m.user.display_name || m.user.username }))}
          selected={null}
          onChange={(id) => { if (id !== null) onChange([...value, id]); }}
          // Inside ModalWrapper (priority 40): Escape closes the menu, not the form.
          escapePriority={45}
        />
      ) : (
        <p className="text-xs text-fg-muted">Everyone who can be assigned cards is on the team.</p>
      )}
      <p className="text-xs text-fg-muted mt-2">{DEFAULT_TEAM_HELP}</p>
    </section>
  );
}
