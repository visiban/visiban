import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";

interface DemoInertProps {
  /** When false, children render untouched — no wrapper, no DOM change. */
  active: boolean;
  /** Id of the ONE visible notice that states the reason (sub-pattern A). */
  describedBy: string;
  children: ReactNode;
}

const ACTIVATION_KEYS = new Set(["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Makes a whole region of controls inert on the hosted demo (#1179) while
 * keeping every control focusable, so the reason stays reachable by keyboard.
 *
 * WHY A REGION AND NOT A PROP PER CONTROL: Board Settings has 30+ admin
 * controls across three components. Threading `aria-disabled` through each
 * fails OPEN — the next control someone adds is live unless they remember the
 * demo. A region fails CLOSED, the same argument that made the server fence
 * deny-by-default. The ARIA semantics are the spec's own: `aria-disabled` on a
 * `group` applies to all of its focusable descendants, and `aria-describedby`
 * ties the group to the shared notice.
 *
 * Activation is blocked in the CAPTURE phase, before any control's own
 * handler: clicks, changes (so controlled inputs snap back), submits, the
 * keys that activate or change a control, blur (save-on-blur fields), pointer
 * and touch starts (drag-to-reorder sensors) and native drag/drop. Tab and Escape pass through, so the
 * visitor can still move around and close the modal. Never native `disabled`
 * or `inert`: both remove the controls from the tab order.
 */
export default function DemoInert({ active, describedBy, children }: DemoInertProps) {
  if (!active) return <>{children}</>;
  const block = (e: SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const blockKeys = (e: KeyboardEvent) => {
    if (ACTIVATION_KEYS.has(e.key)) block(e);
  };
  // Stop-only (no preventDefault): the event must not reach a control's own
  // handler — a save-on-blur field, a drag-to-reorder sensor — but the
  // browser's default (moving focus) must still happen.
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <div
      role="group"
      aria-disabled="true"
      aria-describedby={describedBy}
      data-testid="demo-inert"
      className="opacity-60 cursor-not-allowed"
      onClickCapture={block}
      onChangeCapture={block}
      onSubmitCapture={block}
      onKeyDownCapture={blockKeys}
      onBlurCapture={stop}
      onPointerDownCapture={stop}
      onMouseDownCapture={stop}
      onTouchStartCapture={stop}
      onDragStartCapture={block}
      onDropCapture={block}
    >
      {children}
    </div>
  );
}
