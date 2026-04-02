import { useRef, useState, useId, cloneElement } from "react";
import { createPortal } from "react-dom";
import type { ReactElement } from "react";

interface Props {
  content: string;
  children: ReactElement;
  position?: "top" | "bottom";
  delay?: number;
}

export default function Tooltip({ content, children, position = "bottom", delay = 300 }: Props) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const id = useId();

  const show = () => {
    timerRef.current = setTimeout(() => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      const top = position === "top" ? r.top - 6 : r.bottom + 6;
      const left = r.left + r.width / 2;
      setCoords({ top, left });
      setVisible(true);
    }, delay);
  };

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  };

  const child = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Forward ref if the child already has one
      const { ref } = children as any;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    onMouseEnter: (e: React.MouseEvent) => {
      show();
      children.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      hide();
      children.props.onMouseLeave?.(e);
    },
    onFocus: (e: React.FocusEvent) => {
      show();
      children.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      hide();
      children.props.onBlur?.(e);
    },
    "aria-describedby": visible ? id : undefined,
  });

  return (
    <>
      {child}
      {visible && coords && createPortal(
        <div
          id={id}
          role="tooltip"
          className="bg-slate-900 text-slate-200 text-xs rounded px-2 py-1 shadow-lg pointer-events-none whitespace-nowrap z-50"
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            transform: position === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
