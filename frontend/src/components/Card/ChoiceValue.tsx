import type { ReactNode } from "react";
import { choiceBadgeStyle, type ChoiceColorKey } from "../../constants/choiceColors";
import { choiceColor } from "../../utils/customFieldValue";

/**
 * The automatic (hash-colored) dot in front of a dropdown value chip — the
 * pre-#1391 rendering, kept for every choice without an explicit color. One
 * copy for the card face (`CardItem`) and the read-only renderer
 * (`CustomFieldValueDisplay`), which each had their own until #1391.
 */
export function ChoiceDot({ choice }: { choice: string }) {
  return (
    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: choiceColor(choice) }} aria-hidden="true" />
  );
}

interface BadgeProps {
  colorKey: ChoiceColorKey;
  children: ReactNode;
  className?: string;
  title?: string;
}

/**
 * A choice value with an explicit color (#1391): a tinted badge that always
 * carries its text label — color never stands alone. Rendered *inside* the
 * neutral bordered field chip, never as the chip itself. The fg/bg pair comes
 * from `CHOICE_COLORS` through the `cf-choice-badge` class (index.css), which
 * switches it with the theme. See frontend/CLAUDE.md § Badges and labels.
 */
export function ChoiceBadge({ colorKey, children, className, title }: BadgeProps) {
  return (
    <span
      // min-w-0 baked in here (not left to call sites) — #1411: a `truncate`
      // span's ellipsis never engages inside a flex container without an
      // explicit min-width override, so every caller needs it, not just the
      // ones that happened to add it.
      className={`cf-choice-badge rounded px-1.5 py-0.5 text-xs truncate min-w-0 ${className ?? ""}`}
      style={choiceBadgeStyle(colorKey)}
      data-choice-color={colorKey}
      title={title}
    >
      {children}
    </span>
  );
}
