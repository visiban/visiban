import type { CSSProperties } from "react";

/**
 * The hover "+" shown where a separator would insert a column or row.
 * Purely decorative (the separator is the control), so it is hidden from
 * assistive tech or it is announced as a stray "+". Shared so every site
 * gets the attribute from one place (#2012).
 */
export default function SeparatorPlus({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden="true" className={`text-info font-bold leading-none bg-sunken px-0.5 rounded-sm ${className}`} style={style}>+</span>
  );
}
