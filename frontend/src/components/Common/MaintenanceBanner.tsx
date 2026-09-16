interface MaintenanceBannerProps {
  /** The operator's notice. The server guarantees this is non-empty whenever
   *  maintenance mode is active, substituting its own default for a blank
   *  message, so there is no client-side fallback string to keep in sync. */
  message: string;
  isSiteAdmin: boolean;
}

/**
 * Non-dismissible notice shown to every signed-in user while the instance is in
 * maintenance mode (#783).
 *
 * Amber rather than the `bg-primary/15` mode-indicator treatment: that token set
 * is reserved for a mode the viewer opted into and can leave (focus mode). This
 * is an operator-imposed degraded state the viewer did not choose and cannot
 * exit, which is the same semantic ConnectionStatus already encodes in amber.
 * See "Degraded-state site banners" in frontend/CLAUDE.md.
 *
 * `message` is admin-supplied text and is rendered as a React text node, which
 * escapes it. Never switch this to dangerouslySetInnerHTML.
 */
export function MaintenanceBanner({ message, isSiteAdmin }: MaintenanceBannerProps) {
  return (
    <div
      // role="status" + polite, not role="alert": the viewer did not cause this
      // and has nothing to act on, so it must not interrupt what they are doing.
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="bg-warning/10 border-b border-warning/30 px-4 py-2 flex items-center gap-3 text-sm text-warning shrink-0"
    >
      {/* The canonical amber-severity glyph, same as ColumnHeader,
          MoveBlockedToast and LensProvenanceBanner. A bespoke SVG triangle
          here would give the app two different renderings of one meaning. */}
      <span aria-hidden="true" className="text-base leading-none shrink-0">⚠</span>
      <span className="font-medium shrink-0">Maintenance mode is active.</span>
      {/* truncate is CSS-only, so the full notice stays in the DOM for screen
          readers even when it is visually clipped; title exposes it on hover. */}
      <span className="truncate min-w-0 flex-1" title={message}>
        {message}
      </span>
      {isSiteAdmin && (
        // Dropped first at narrow widths — it is the least critical text here,
        // and an admin who loses it still has their working write access as the
        // stronger signal.
        <span className="hidden sm:inline text-xs text-fg-muted shrink-0">
          You have full access as a site admin.
        </span>
      )}
    </div>
  );
}

export default MaintenanceBanner;
