/**
 * The seven button variants of the shared look (#2475, frontend/CLAUDE.md § Buttons;
 * `danger-outline` added in #2504).
 *
 * Kept as plain class strings (not only a `<Button>` component) because many call sites render
 * a `<Link>`, an `<a>` or a native `<button>` with its own handlers; they all take the same
 * classes. `quiet` is the variant that was called "Secondary" before #2475 (bare text with a
 * hover fill) and is the one every Cancel uses; `secondary` is now the bordered board-toolbar
 * style. The class strings are pinned by `src/test/pageParts.test.tsx` and the Cancel scan in
 * `src/test/cancelButtonHover.test.ts` reads `BUTTON_VARIANT_CLASSES.quiet` from here.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "danger-outline" | "warning" | "icon";

/** `md` is the default 36px control (44px on phones); `lg` is the Centered layout's 48px phone control. */
export type ButtonSize = "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded text-sm transition focus:outline-none focus:ring-2 disabled:opacity-40 disabled:cursor-not-allowed";

const SIZE: Record<ButtonSize, string> = {
  md: "h-9 max-sm:h-11",
  lg: "h-9 max-sm:h-12",
};

export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "px-3 bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium focus:ring-primary-emphasis",
  // Rests on the panel color so the page never shows through it (§ Color tokens, #2311).
  secondary: "px-3 bg-surface border border-line-strong text-fg font-medium hover:bg-surface-hover focus:ring-primary-emphasis",
  quiet: "px-3 text-fg-secondary hover:text-fg hover:bg-surface-hover focus:ring-primary-emphasis",
  danger: "px-3 bg-danger-bg hover:bg-danger-bg-hover text-on-danger font-medium focus:ring-danger-emphasis",
  // #2504: a destructive trigger that opens a confirm (Transfer ownership, Delete group). The
  // filled Danger is kept for the confirm's own action, so the trigger reads lower than the
  // commit. The classes are the ones the group page spelled out on `secondary` before #2504.
  "danger-outline": "px-3 bg-surface border border-danger/40 text-danger font-medium hover:bg-danger/20 hover:text-danger-on-tint focus:ring-danger-emphasis",
  warning: "px-3 bg-warning-bg hover:bg-warning-bg-hover text-on-warning font-medium focus:ring-warning-emphasis",
  icon: "shrink-0 text-fg-secondary hover:text-fg hover:bg-surface-hover focus:ring-primary-emphasis",
};

const ICON_SIZE: Record<ButtonSize, string> = {
  md: "w-9 max-sm:w-11",
  lg: "w-9 max-sm:w-12",
};

export interface ButtonClassOptions {
  size?: ButtonSize;
  /** Stretch to the container width (the Centered layout's stacked actions). */
  fullWidth?: boolean;
  className?: string;
}

/** Full class string for a button of `variant`. */
export function buttonClasses(variant: ButtonVariant, { size = "md", fullWidth = false, className = "" }: ButtonClassOptions = {}): string {
  return [
    BASE,
    SIZE[size],
    variant === "icon" ? ICON_SIZE[size] : "",
    BUTTON_VARIANT_CLASSES[variant],
    fullWidth ? "w-full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}
