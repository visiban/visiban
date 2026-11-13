/**
 * The `style` values the description sanitizer admits on a `<span>` (#2097): the one
 * `color:` declaration Tiptap's Color extension writes. Kept in its own module so the
 * component and its test share one pattern.
 *
 * Alternatives: a hex of 3-6 digits, a lowercase named color, or the exact
 * `rgb(r, g, b)` form (integers only, no alpha, no nesting, no `var()`/`url()`): real
 * browsers serialize the hex Tiptap sets to that form when the description is saved, so
 * without it every stored color was stripped in view mode. Do not loosen further, and
 * do not tighten: spans already stored in descriptions would be stripped on render.
 */
export const COLOR_STYLE_PATTERN =
  /^color:\s*(#[0-9a-fA-F]{3,6}|[a-z]+|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))\s*;?$/;
