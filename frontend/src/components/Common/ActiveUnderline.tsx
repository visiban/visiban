interface Props {
  active: boolean;
  /**
   * `inset` (default) sits 1px above the host's bottom edge, inside its padding with a gap
   * below the line box (so descenders and count badges never touch it), for padded buttons
   * (`p-1.5`, `px-2 py-1`). `below` hangs just under a host with no padding (a bare
   * glyph button such as the swimlane focus toggle), so the bar never covers the icon.
   */
  placement?: "inset" | "below";
  testId?: string;
}

const PLACEMENT = {
  inset: "bottom-px",
  below: "-bottom-1",
} as const;

/**
 * Non-color cue for the active state of an icon-only toggle (#2188, WCAG 1.4.1).
 * The #2185 `ActiveMark` check needs a label to sit beside, so an icon button
 * shows a short 2px `bg-fg` bar centered under its icon instead: a shape that
 * reads in both themes whatever tint the active state also uses. It is absolutely
 * positioned, so the host must be `relative`, and toggling never shifts layout.
 * Decorative: the state itself is carried by `aria-pressed` on the host button.
 */
export default function ActiveUnderline({ active, placement = "inset", testId = "active-underline" }: Props) {
  if (!active) return null;
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${PLACEMENT[placement]} h-0.5 w-3 rounded-full bg-fg`}
    />
  );
}
