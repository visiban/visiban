/**
 * "Showing 100 of 240 boards" (#2449): the child board options lists are capped at 100 by name, and the
 * server says how many qualify in all. Null when the list is complete, or from a server that sends no total.
 */
export function boardsCapLine(shown: number, total: number | undefined): string | null {
  if (typeof total !== "number" || total <= shown) return null;
  return `Showing ${shown} of ${total} boards, by name.`;
}

/**
 * Why a board the viewer may add cards to cannot take a child yet (#2719), in plain words. The server's rule
 * (`_child_rule_failure`): a board with no columns, a board with no swimlanes (a card needs one), or a first column
 * that doesn't allow new cards (Add child puts the card there). An unknown reason from a newer server still reads.
 */
export function unavailableReasonCopy(reason: string): string {
  switch (reason) {
    case "no_swimlane":
      return "add a swimlane first";
    case "first_column_closed":
      return "its first column doesn't allow new cards";
    case "no_column":
      return "add a column first";
    default:
      return "it can't take children yet";
  }
}
