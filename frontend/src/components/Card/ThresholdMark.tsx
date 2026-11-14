import type { ThresholdDirection } from "../../types";
import type { ThresholdLevel } from "../../utils/customFieldValue";

interface Props {
  level: ThresholdLevel;
  direction: ThresholdDirection;
}

/**
 * The threshold chevron for a custom-field value (#1122): `›` at warning,
 * `»` at alert, pointing left for a "below" threshold. A 12px inline SVG on
 * `currentColor`, never a font glyph and never a hue (frontend/CLAUDE.md §
 * Threshold marks): red and amber on the card face mean urgency and
 * priority. Always `aria-hidden` — the words travel in the surrounding
 * text, `title` or `sr-only` suffix.
 */
export default function ThresholdMark({ level, direction }: Props) {
  if (level === "none" || direction === "") return null;
  const flip = direction === "below" ? "scale(-1 1) translate(-12 0)" : undefined;
  return (
    <svg
      viewBox="0 0 12 12"
      className="w-3 h-3 shrink-0"
      aria-hidden="true"
      focusable="false"
      data-threshold-mark={level}
    >
      <g transform={flip} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        {level === "alert" ? (
          <>
            <path d="M2.5 3 5.5 6 2.5 9" />
            <path d="M6.5 3 9.5 6 6.5 9" />
          </>
        ) : (
          <path d="M4.5 3 7.5 6 4.5 9" />
        )}
      </g>
    </svg>
  );
}
