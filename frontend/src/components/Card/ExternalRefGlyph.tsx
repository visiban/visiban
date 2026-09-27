/**
 * Generic pull/merge request glyph (#352). One glyph for every provider — no
 * brand logos, which would add trademark and asset burden and would not track
 * the theme color. Decorative: callers provide the accessible name.
 */
export default function ExternalRefGlyph({ className = "w-3 h-3 shrink-0" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="8" r="1.75" />
      <path d="M4 5.25v5.5M10.25 8H8.5C6 8 4 7 4 5.25" />
    </svg>
  );
}
