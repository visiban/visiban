import type { UnavailableChildBoard } from "../../types";
import { unavailableReasonCopy } from "./childBoardOptionsCap";

interface Props {
  id: string;
  boards: UnavailableChildBoard[];
  className?: string;
}

/**
 * The boards a child-board select leaves out because they fail the child-board rule, each with its reason (#2719).
 * Plain text, never options: a board here can't be chosen until it is fixed, and a list keeps every reason readable
 * on a phone, where a disabled option's reason would be cut off. Wire `id` into the select's `aria-describedby`.
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
