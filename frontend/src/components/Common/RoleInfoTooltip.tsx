import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  label?: string;
}

/**
 * Generic info-tooltip triggered by a small "?" button. The caller provides
 * the tooltip content as children. Uses a portal so the tooltip escapes any
 * overflow:hidden ancestors (e.g. modal scrollers).
 */
export default function RoleInfoTooltip({ children, label = "Role information" }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const show = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setAnchor({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
  };
  const hide = () => setAnchor(null);

  return (
    <div className="inline-flex items-center">
      <button
        ref={btnRef}
        type="button"
        className="w-4 h-4 rounded-full border border-line-strong text-[10px] text-fg-tertiary hover:text-fg hover:border-line-emphasis flex items-center justify-center transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        aria-label={label}
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        ?
      </button>
      {anchor && createPortal(
        <div
          role="tooltip"
          style={{ position: "fixed", top: anchor.top, right: anchor.right, maxWidth: 280, zIndex: 9999 }}
          className="w-72 bg-sunken border border-line-strong rounded-lg p-3 shadow-xl pointer-events-none"
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
