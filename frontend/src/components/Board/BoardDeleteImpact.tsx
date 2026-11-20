import { useEffect, useState } from "react";
import { getBoardDeleteImpact } from "../../api/boards";
import type { BoardDeleteImpact } from "../../types";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What deleting a board does to parent/child card links on other boards (#2208). Shown in every board-delete
 * confirm. Parent boards are named only when the deleter can open them; the server never sends the others,
 * so the copy falls back to "another board you can't open". Renders nothing while loading, on a failed read
 * (the delete itself is unaffected), and when no link is involved.
 */
export default function BoardDeleteImpactNotice({ boardId }: { boardId: number }) {
  const [impact, setImpact] = useState<BoardDeleteImpact | null>(null);

  useEffect(() => {
    let live = true;
    getBoardDeleteImpact(boardId).then((i) => { if (live) setImpact(i); }).catch(() => { if (live) setImpact(null); });
    return () => { live = false; };
  }, [boardId]);

  if (!impact || (impact.child_cards === 0 && impact.parent_cards === 0)) return null;

  const where = [
    ...(impact.parent_boards.length > 0 ? [joinNames(impact.parent_boards.map((b) => b.name))] : []),
    ...(impact.hidden_parent_boards ? ["another board you can't open"] : []),
  ];

  return (
    <div role="note" data-testid="board-delete-impact" className="mb-3 flex flex-col gap-1 text-xs text-fg-secondary">
      {impact.child_cards > 0 && (
        <p>
          <span className="text-danger font-medium">
            {plural(impact.child_cards, "card here is a child", "cards here are children")}
          </span>
          {" "}of cards on {joinNames(where) || "another board"}. Those parents lose {impact.child_cards === 1 ? "it" : "them"} from their rollups and Children tabs.
        </p>
      )}
      {impact.parent_cards > 0 && (
        <p>
          {plural(impact.parent_cards, "card here has children", "cards here have children")} on other boards. They stay there as ordinary cards.
        </p>
      )}
    </div>
  );
}
