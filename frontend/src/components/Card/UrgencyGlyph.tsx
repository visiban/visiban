/**
 * Urgency glyphs for the card face (#871): a flag for overdue and, on the #2272
 * status line, for due soon (`due-soon-flag`), and a clock for stale. Inline SVG on `currentColor`, never the ⚑ text character, which
 * render as emoji or fall back to another font on some platforms, ignore the
 * badge's tone token, and read aloud as "black flag". Decorative:
 * the adjacent visible text (plus a screen-reader-only prefix where the glyph
 * carries meaning the text lacks) is the accessible name.
 */
export type UrgencyGlyphKind = "overdue" | "due-soon-flag" | "stale";

export default function UrgencyGlyph({
  kind,
  className = "w-3 h-3 shrink-0",
}: {
  kind: UrgencyGlyphKind;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid={`urgency-glyph-${kind}`}
    >
      {kind === "stale" ? (
        // Clock: face plus hands (#2272). Distinct from the flag.
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.25 1.5" />
        </>
      ) : (
        // Flag: pole plus a filled pennant.
        <>
          <path d="M3.5 14V2" />
          <path d="M3.5 2.75h8.5l-2 3 2 3H3.5" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
