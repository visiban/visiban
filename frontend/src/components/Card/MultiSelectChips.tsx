import type { FieldDefinitionShape } from "../../types";
import { explicitChoiceColor } from "../../utils/customFieldValue";
import { ChoiceBadge } from "./ChoiceValue";

interface Props {
  entries: string[];
  /**
   * The field the entries belong to — read only for its per-choice colors
   * (#1391). Omit and every chip renders neutral.
   */
  definition?: FieldDefinitionShape;
  /** How many entries render as chips before the rest fold into `+N`. Omit for all. */
  max?: number;
  /** Let the chips wrap onto further lines (row header, detail) instead of one line (card face). */
  wrap?: boolean;
}

/**
 * The entries of one multi-select value (#1391), as small chips inside the
 * neutral bordered custom-field chip (frontend/CLAUDE.md § Badges and labels).
 *
 * An entry whose choice has an explicit color renders as a tinted
 * `ChoiceBadge`; every other entry — no color set, an orphan (no longer a
 * choice), or a color key this client does not know — is the neutral
 * `bg-surface-hover` chip. The label is always the text. Each chip truncates
 * with its full text in `title`; the `+N` overflow pill's `title` lists every
 * entry, so nothing is reachable only by opening the card.
 */
export default function MultiSelectChips({ entries, definition, max, wrap = false }: Props) {
  if (entries.length === 0) return null;
  const shown = max === undefined ? entries : entries.slice(0, max);
  const hidden = entries.length - shown.length;
  return (
    <span className={`inline-flex items-center gap-1 min-w-0 ${wrap ? "flex-wrap" : ""}`}>
      {shown.map((entry) => {
        // Wrapping surfaces (row header, detail, editor trigger) give a
        // chip the full line; the one-line card face caps it at 6rem.
        const width = wrap ? "max-w-full" : "max-w-[6rem]";
        const colorKey = definition ? explicitChoiceColor(definition, entry) : null;
        if (colorKey) {
          return (
            <ChoiceBadge key={entry} colorKey={colorKey} className={width} title={entry}>
              {entry}
            </ChoiceBadge>
          );
        }
        return (
          <span
            key={entry}
            className={`text-xs px-1.5 py-0.5 rounded truncate bg-surface-hover text-fg-secondary min-w-0 ${width}`}
            title={entry}
          >
            {entry}
          </span>
        );
      })}
      {hidden > 0 && (
        <span className="text-fg-muted text-xs shrink-0" title={entries.join(", ")}>
          +{hidden}
        </span>
      )}
    </span>
  );
}
