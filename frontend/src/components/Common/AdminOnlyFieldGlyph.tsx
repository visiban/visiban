/**
 * The padlock that marks an `is_admin_only` swimlane custom field (#1140).
 *
 * One component, one accessible name, every surface: the row chip, the Board
 * Settings field list, the value popover, and the edit row. It shipped as four
 * hand-rolled inline copies first, and they had already drifted — one
 * announced "Admin only" while the other three said "Admin-only field" — which
 * is precisely the split the design rule ("one glyph, one meaning") exists to
 * prevent. Same guard the codebase already applies to `toolbarIcons.tsx`.
 *
 * Inline SVG on `currentColor`, never a 🔒 emoji: an emoji paints in its own
 * fixed color and stops tracking the theme.
 */
export default function AdminOnlyFieldGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "w-3 h-3 text-fg-faint shrink-0"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      role="img"
      aria-label="Admin-only field"
    >
      <rect x="3.5" y="7" width="9" height="6" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </svg>
  );
}
