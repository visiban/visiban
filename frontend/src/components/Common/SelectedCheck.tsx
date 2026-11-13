interface SelectedCheckProps {
  /** Whether to draw the check. The slot is rendered either way so selection never shifts text. */
  selected: boolean;
  /** data-testid placed on the svg (only present while selected). */
  testId: string;
  /** Classes for the reserved slot; callers differ in size/alignment/color. Must fix the width (`w-*`) and `shrink-0`: that is the reserved-width guarantee. */
  slotClassName: string;
  /** Classes for the svg itself. */
  iconClassName?: string;
}

/**
 * Non-color selection cue shared by select-like surfaces (#2183, from #2108/#2171).
 * Color alone fails WCAG 1.4.1, so selected rows also get a check. The slot is
 * aria-hidden and always reserves its width, so labels stay aligned.
 */
export default function SelectedCheck({ selected, testId, slotClassName, iconClassName = "w-3 h-3" }: SelectedCheckProps) {
  return (
    <span aria-hidden="true" className={slotClassName}>
      {selected && (
        <svg data-testid={testId} className={iconClassName} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.5 3.5L13 4.5" />
        </svg>
      )}
    </span>
  );
}
