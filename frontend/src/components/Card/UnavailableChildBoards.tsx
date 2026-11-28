import type { UnavailableChildBoard } from "../../types";
import { unavailableReasonCopy } from "./childBoardOptionsCap";

interface Props {
  id: string;
  boards: UnavailableChildBoard[];
  className?: string;
}

/**
 * Add child's empty state (#2719): no board can take a child, but these boards could once fixed, each with its reason.
 * Only where there is no select. When any board can be picked, these boards are disabled options inside the select
 * instead (`unavailableOption`), so nothing is listed twice.
 */
export default function UnavailableChildBoards({ id, boards, className = "" }: Props) {
  if (boards.length === 0) return null;
  return (
    <div id={id} className={`text-xs text-fg-muted ${className}`} data-testid="unavailable-child-boards">
      <p>Can't take children yet:</p>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {boards.map((b) => (
          <li key={b.id} className="break-words">
            <span className="font-medium text-fg-secondary">{b.name}</span>: {unavailableReasonCopy(b.reason)}
          </li>
        ))}
      </ul>
    </div>
  );
}
