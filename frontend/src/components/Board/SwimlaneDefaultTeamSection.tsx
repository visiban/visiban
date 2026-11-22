import { useEffect, useId, useRef, useState } from "react";
import type { EffectiveBoardMember, SwimlaneDefaultTeamAccess } from "../../types";
import Avatar from "../Common/Avatar";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import { assignableMembers } from "../../utils/swimlaneDefaultTeam";

/** Shown in Edit swimlane and checked by tests; one text on desktop and phone (#2211). */
export const DEFAULT_TEAM_HELP =
  "Pre-assigned to new cards and new children created in this lane. Existing cards don't change. " +
  "A person who can't open a child board used by this lane's parents is skipped when a child is " +
  "created there; remove them or give them access to clear this warning.";

/** The warning on a member who can't be assigned on a child board this lane feeds (#2211). */
export function noAccessText(entry: SwimlaneDefaultTeamAccess["members"][number]): string {
  const names = entry.boards.map((b) => b.name);
  if (entry.hidden_count > 0) {
    names.push(`${entry.hidden_count} ${entry.hidden_count === 1 ? "board" : "boards"} you can't open`);
  }
  return `No access to ${names.join(", ")}: skipped on new children`;
}

interface Props {
  members: EffectiveBoardMember[];
  value: number[];
  onChange: (ids: number[]) => void;
  /** Deactivated team members (`default_team_members`): shown, never offered, removed before a save. */
  inactiveIds?: Set<number>;
  /** Who is skipped on which child board; null while loading or when it failed to load. */
  access?: SwimlaneDefaultTeamAccess | null;
}

/** The Default team section of Edit swimlane (#2211): rows, Remove, Add a member. */
export default function SwimlaneDefaultTeamSection({ members, value, onChange, inactiveIds, access }: Props) {
  const headingId = useId();
  const warnPrefix = useId();
  // A Remove button removes its own row, so focus moves to the next row's Remove (else the
  // previous, else the section); adding the last candidate unmounts Add a member, so focus moves
  // to the new row's Remove. A status line announces both; focus never drops to <body>.
  const removeRefs = useRef(new Map<number, HTMLButtonElement>());
  const sectionRef = useRef<HTMLElement>(null);
  const focusAfter = useRef<number | null | undefined>(undefined);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    if (focusAfter.current === undefined) return;
    const target = focusAfter.current;
    focusAfter.current = undefined;
    const next = target != null ? removeRefs.current.get(target) : undefined;
    (next ?? sectionRef.current)?.focus();
  }, [value]);
  const remove = (id: number, name: string) => {
    const i = value.indexOf(id);
    focusAfter.current = value[i + 1] ?? value[i - 1] ?? null;
    setAnnounce(`Removed ${name} from default team.`);
    onChange(value.filter((v) => v !== id));
  };
  const byId = new Map(members.map((m) => [m.user.id, m.user]));
  const candidates = assignableMembers(members).filter((m) => !value.includes(m.user.id) && !inactiveIds?.has(m.user.id));
  const accessById = new Map((access?.members ?? []).map((m) => [m.id, m]));
  const count = `${value.length} ${value.length === 1 ? "person" : "people"}`;

  return (
    <section ref={sectionRef} tabIndex={-1} aria-labelledby={headingId} className="outline-none">
      <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">
        Default team <span className="ml-1.5 normal-case font-normal text-fg-muted">{count}</span>
      </h3>
      {value.length > 0 && (
        // role="group" on a wrapper, never on the <ul>: it would replace the list's semantics.
        <div role="group" aria-label="Default team members">
          <ul className="flex flex-col mb-2">
            {value.map((id) => {
              const user = byId.get(id);
              if (!user) return null;
              const name = user.display_name || user.username;
              const inactive = inactiveIds?.has(id) ?? false;
              const noAccess = accessById.get(id);
              const warning = inactive ? "Deactivated: remove to save the team" : noAccess ? noAccessText(noAccess) : null;
              const warningId = `${warnPrefix}-${id}`;
              return (
                <li
                  key={id}
                  className={`flex items-center gap-2 min-h-11 ${warning ? "border border-dashed border-warning rounded px-1.5 my-0.5" : ""}`}
                >
                  {/* Full opacity even on a warning row: the canvas's 60% avatar measured 1.6-4.0:1
                      initials and 1.8-2.5:1 disc (#2211 Playwright), below 4.5:1 and 3:1. The dashed
                      border and the warning line carry the state. */}
                  <Avatar user={user} size="sm" />
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="truncate text-sm text-fg">{name}</span>
                    {warning && <span id={warningId} className="text-xs text-warning">{warning}</span>}
                  </span>
                  <button
                    type="button"
                    ref={(el) => { if (el) removeRefs.current.set(id, el); else removeRefs.current.delete(id); }}
                    aria-label={`Remove ${name} from default team`}
                    aria-describedby={warning ? warningId : undefined}
                    data-inactive-remove={inactive || undefined}
                    onClick={() => remove(id, name)}
                    className="min-h-11 min-w-11 inline-flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
      {candidates.length > 0 ? (
        <SingleSelectDropdown<number>
          label="Add a member"
          options={candidates.map((m) => ({ value: m.user.id, label: m.user.display_name || m.user.username }))}
          selected={null}
          onChange={(id) => {
            if (id === null) return;
            const added = byId.get(id);
            // The last candidate empties (and unmounts) this dropdown: land on the new row instead.
            if (candidates.length === 1) focusAfter.current = id;
            if (added) setAnnounce(`Added ${added.display_name || added.username} to default team.`);
            onChange([...value, id]);
          }}
          // Inside ModalWrapper (priority 40): Escape closes the menu, not the form.
          escapePriority={45}
          // The modal body scrolls; a portaled menu is not clipped by it.
          portalMenu
        />
      ) : (
        <p className="text-xs text-fg-muted">
          {value.length > 0
            ? "Everyone who can be assigned cards is on the team."
            : "No one on this board can be assigned cards."}
        </p>
      )}
      <p className="text-xs text-fg-muted mt-2">{DEFAULT_TEAM_HELP}</p>
    </section>
  );
}
