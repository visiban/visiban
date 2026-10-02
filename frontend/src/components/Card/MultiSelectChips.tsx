interface Props {
  entries: string[];
  /** How many entries render as chips before the rest fold into `+N`. Omit for all. */
  max?: number;
  /** Let the chips wrap onto further lines (row header, detail) instead of one line (card face). */
  wrap?: boolean;
}

/**
 * The entries of one multi-select value (#1391), as small neutral chips.
 *
 * Read-only and colorless on purpose: the value sits inside the existing
 * neutral bordered custom-field chip (frontend/CLAUDE.md § Badges and labels),
 * and per-choice color is a later change. An orphaned entry (no longer a
 * choice) renders exactly like the others — the stored value is still the
 * truth for this card. Each chip truncates with its full text in `title`; the
 * `+N` overflow pill's `title` lists every entry, so nothing is reachable
 * only by opening the card.
 */
export default function MultiSelectChips({ entries, max, wrap = false }: Props) {
  if (entries.length === 0) return null;
  const shown = max === undefined ? entries : entries.slice(0, max);
  const hidden = entries.length - shown.length;
  return (
    <span className={`inline-flex items-center gap-1 min-w-0 ${wrap ? "flex-wrap" : ""}`}>
      {shown.map((entry) => (
        <span
          key={entry}
          // Wrapping surfaces (row header, detail, editor trigger) give a
          // chip the full line; the one-line card face caps it at 6rem.
          className={`text-xs px-1.5 py-0.5 rounded truncate bg-surface-hover text-fg-secondary ${wrap ? "max-w-full" : "max-w-[6rem]"}`}
          title={entry}
        >
          {entry}
        </span>
      ))}
      {hidden > 0 && (
        <span className="text-fg-muted text-xs shrink-0" title={entries.join(", ")}>
          +{hidden}
        </span>
      )}
    </span>
  );
}
