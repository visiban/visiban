/**
 * "Showing 100 of 240 boards" (#2449): the child board options lists are capped at 100 by name, and the
 * server says how many qualify in all. Null when the list is complete, or from a server that sends no total.
 */
export function boardsCapLine(shown: number, total: number | undefined): string | null {
  if (typeof total !== "number" || total <= shown) return null;
  return `Showing ${shown} of ${total} boards, by name.`;
}
