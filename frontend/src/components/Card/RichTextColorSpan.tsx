import type { ComponentPropsWithoutRef } from "react";
import { cssColorToHex, textColorStyle } from "../../utils/colorContrast";

/**
 * View-mode span override (#2097). A stored color is whatever hex the author picked,
 * so it may be unreadable on the current theme (the White preset is 1.1:1 on light).
 * A hex the helper can normalize renders through `.rt-color` with a per-theme legible
 * pair (a browser writes the stored hex back as `rgb(r, g, b)`, which is read too);
 * anything else (named colors, 4-5 digit hex the sanitizer admits) renders raw.
 */
export default function ColorSpan({ node: _node, style, children, ...rest }: ComponentPropsWithoutRef<"span"> & { node?: unknown }) {
  const raw = typeof style === "string" ? /color:\s*([^;]+)/.exec(style)?.[1] : style?.color;
  const hex = cssColorToHex(raw);
  const vars = hex ? textColorStyle(hex) : null;
  if (!vars) return <span {...rest} style={style}>{children}</span>;
  return <span {...rest} className="rt-color" style={vars}>{children}</span>;
}
