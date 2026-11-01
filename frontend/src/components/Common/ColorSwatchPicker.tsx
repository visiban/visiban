import { colorName } from "../../constants/colors";

interface Props {
  /** Palette to render, one swatch per entry (hex strings). */
  colors: readonly string[];
  /** Currently selected hex, or null/undefined when nothing is selected. */
  value: string | null | undefined;
  onChange: (color: string) => void;
  /** "md" = 28px (modals), "sm" = 20px (inline popovers). Default "md". */
  size?: "sm" | "md";
  /** Override the accessible name; defaults to "Select color {Name}". Never put hex in it. */
  getAriaLabel?: (color: string, name: string) => string;
  /** Classes for the wrapping row (default "flex gap-2 flex-wrap"). */
  className?: string;
  /** Accessible name for the group. */
  groupLabel?: string;
}

/**
 * The one swatch row (#1893). Selection is a themed ring (`border-fg` plus an offset
 * `ring-fg` ring) that reads on both the light and dark `bg-surface`; a white border
 * vanishes in the light theme. The scale bump is an extra cue, never the only one.
 * The focus ring is a separate `focus:ring-primary-emphasis`, and the selected
 * `border-fg` stays visible while focused.
 */
export default function ColorSwatchPicker({
  colors,
  value,
  onChange,
  size = "md",
  getAriaLabel,
  className = "flex gap-2 flex-wrap",
  groupLabel = "Color",
}: Props) {
  const dim = size === "sm" ? "w-5 h-5" : "w-7 h-7";
  return (
    <div className={className} role="group" aria-label={groupLabel}>
      {colors.map((c) => {
        const selected = value === c;
        const name = colorName(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={getAriaLabel ? getAriaLabel(c, name) : `Select color ${name}`}
            aria-pressed={selected}
            title={name}
            className={`${dim} rounded-full border-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              selected
                ? "border-fg scale-110 ring-2 ring-fg ring-offset-2 ring-offset-surface"
                : "border-transparent"
            }`}
            style={{ backgroundColor: c }}
          />
        );
      })}
    </div>
  );
}
