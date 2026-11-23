/** The confirm's body; `n` parent cards keep their children after the flip (#2446). */
export function turnOffBody(n: number): string {
  return n === 1
    ? "1 card here has children. It keeps them and stays linked, and the tab and rollup stay on that card. It can still Add child; no other card can get children."
    : `${n} cards here have children. They keep them and stay linked, and the tab and rollup stay on those ${n} cards. The ${n} can still Add child; no other card can get children.`;
}
