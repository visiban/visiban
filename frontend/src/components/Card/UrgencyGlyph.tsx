/**
 * Urgency glyphs for the card face (#871): a flag for overdue, a stopwatch for
 * due soon. Inline SVG on `currentColor`, never the ⚑/⏱ text characters, which
 * render as emoji or fall back to another font on some platforms, ignore the
 * badge's tone token, and read aloud as "black flag" / "stopwatch". Decorative:
 * the adjacent visible text (plus a screen-reader-only prefix where the glyph
 * carries meaning the text lacks) is the accessible name.
 */
export type UrgencyGlyphKind = "overdue" | "due-soon";

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
      {kind === "overdue" ? (
        // Flag: pole plus a filled pennant.
        <>
          <path d="M3.5 14V2" />
          <path d="M3.5 2.75h8.5l-2 3 2 3H3.5" fill="currentColor" />
        </>
      ) : (
        // Stopwatch: crown, body and a hand.
        <>
          <path d="M6 1.5h4" />
          <circle cx="8" cy="9" r="5" />
          <path d="M8 9V6.25" />
        </>
      )}
    </svg>
  );
}
