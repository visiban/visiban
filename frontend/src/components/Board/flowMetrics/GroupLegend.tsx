import type { FlowGroupBase } from "../../../types";
import ActiveMark from "../../Common/ActiveMark";
import { colorOfGroup, groupName } from "./breakdown";

interface Props {
  groups: readonly FlowGroupBase[];
  /** "swimlane", "label" or the field's name. */
  noun: string;
  note: string | null;
  isolated: number | null;
  onIsolate: (index: number | null) => void;
}

/**
 * Under the filter bar while a breakdown is on (#2268): what the color means
 * and one chip per group. Selecting a chip isolates that group (the rest drop
 * to 20%); selecting it again shows every group. Color is never the only
 * carrier: the chip names the group and carries `ActiveMark` when isolated.
 */
export default function GroupLegend({ groups, noun, note, isolated, onIsolate }: Props) {
  return (
    <div
      role="group"
      aria-label={`Colored by ${noun}`}
      data-testid="group-legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2 min-w-0"
    >
      <span className="text-xs text-fg-secondary">Colored by {noun}</span>
      <ul className="flex flex-wrap items-center gap-2 min-w-0">
        {groups.map((group, index) => {
          const active = isolated === index;
          return (
            <li key={group.key ?? "other"}>
              <button
                type="button"
                aria-pressed={active}
                data-testid="group-chip"
                onClick={() => onIsolate(active ? null : index)}
                className={`inline-flex items-center gap-1.5 rounded-full border py-1 text-xs text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                  active ? "px-2.5 border-primary-emphasis bg-surface-hover font-semibold" : "px-[1.1875rem] border-line-strong hover:bg-surface-hover"
                }`}
              >
                {active && <ActiveMark active />}
                <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorOfGroup(groups, index) }} />
                <span className="truncate max-w-[12rem]">{groupName(group)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <span className="text-xs text-fg-tertiary">
        {isolated === null ? "Select a group to isolate it." : "Select it again to show every group."}
        {note ? ` ${note}` : ""}
      </span>
    </div>
  );
}
