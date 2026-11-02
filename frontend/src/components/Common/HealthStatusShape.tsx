import type { HealthDisplayValue } from "../../constants/healthStatus";

/**
 * The shape that goes with each health state (#1133), so color is never the
 * only signal (WCAG 1.4.1): filled circle, triangle, diamond, hollow circle.
 * Inline SVG on `currentColor`, never a font glyph, so it tracks the theme and
 * keeps a fixed box. Decorative: the word beside it carries the meaning.
 */
export default function HealthStatusShape({ value, className = "w-3 h-3 shrink-0" }: {
  value: HealthDisplayValue;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-health-shape={value}
    >
      {value === "on_track" && <circle cx="6" cy="6" r="5" fill="currentColor" />}
      {value === "at_risk" && <path d="M6 1.2 11 10.5H1z" fill="currentColor" />}
      {value === "off_track" && <path d="M6 .8 11.2 6 6 11.2.8 6z" fill="currentColor" />}
      {value === "none" && (
        <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  );
}
