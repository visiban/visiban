interface Props {
  active: boolean;
  testId?: string;
}

/**
 * Non-color cue for the active state of a toggle or segmented control (#2185,
 * WCAG 1.4.1; same visual language as the select check from #2108/#2171).
 * A fill, tint, border or text color is never the only cue. The slot is always
 * rendered at a fixed width, so toggling never shifts the label. Decorative:
 * the state itself is carried by `aria-pressed` on the host button.
 */
export default function ActiveMark({ active, testId = "active-mark" }: Props) {
  return (
    <span aria-hidden="true" className="inline-flex w-3 h-3 shrink-0 items-center justify-center">
      {active && (
        <svg data-testid={testId} className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.5 3.5L13 4.5" />
        </svg>
      )}
    </span>
  );
}
