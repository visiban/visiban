import { useId } from "react";
import type { ReactNode } from "react";
import type { ToastRecord, ToastVariant } from "../../utils/toastQueue";

/**
 * The visible half of the shared toast system (#2060, #1438): one
 * `role="region"` "Notifications" holding up to three toasts above the
 * anchor, plus the `+N waiting` line. Presentational only; `ToastProvider`
 * owns state, timers, focus return and the two sr-only live regions, so the
 * visible toasts themselves are never live (no double announcement) and their
 * actions stay ordinary Tab stops. Rules: frontend/CLAUDE.md § Toasts.
 */

/** Shape + word carry the meaning; hue only reinforces it. */
const SHELL: Record<ToastVariant, string> = {
  success: "bg-surface border-line-strong",
  // The shipped post-import notice shell, over the opaque surface below.
  info: "bg-primary/15 border-primary-emphasis/40",
  warning: "bg-surface border-warning",
  blocked: "bg-surface border-warning",
  danger: "bg-surface border-danger",
};

/**
 * Title and action text use the on-tint tokens even on the untinted shell:
 * plain `text-warning` is 3.56:1 on white (#2029). Ratios in § Color tokens.
 */
const TOAST_TEXT_TONE: Record<ToastVariant, string> = {
  success: "text-success-on-tint",
  info: "text-info-on-tint",
  warning: "text-warning-on-tint",
  blocked: "text-warning-on-tint",
  danger: "text-danger-on-tint",
};

const GLYPH_TONE: Record<ToastVariant, string> = {
  success: "text-success-on-tint",
  info: "text-info-on-tint",
  // Move constraints stay amber; severity is the glyph, never the hue.
  warning: "text-warning",
  blocked: "text-warning",
  danger: "text-danger-on-tint",
};

/**
 * The `danger` glyph: an octagon with an ×. Not `⛔` (reserved for hard WIP
 * blocks) and not `⊘` (the card blocked signal).
 */
function DangerGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" focusable="false" data-glyph="danger">
      <path d="M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2l-3.7-3.7V5.2z" strokeLinejoin="round" />
      <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" strokeLinecap="round" />
    </svg>
  );
}

export function ToastGlyph({ variant, hard = false }: { variant: ToastVariant; hard?: boolean }) {
  let glyph: ReactNode;
  switch (variant) {
    case "success": glyph = "✓"; break;
    case "info": glyph = "ℹ"; break;
    case "danger": glyph = <DangerGlyph />; break;
    // ⛔ only for a hard limit on `blocked`, as § Move-blocked toast reserves it.
    case "blocked": glyph = hard ? "⛔" : "⚠"; break;
    default: glyph = "⚠";
  }
  return (
    <span aria-hidden="true" className={`${GLYPH_TONE[variant]} shrink-0 mt-px leading-5`}>
      {glyph}
    </span>
  );
}

interface ItemProps {
  toast: ToastRecord;
  pending: boolean;
  onClose: (id: number) => void;
  onAction: (toast: ToastRecord) => void;
}

function ToastItem({ toast, pending, onClose, onAction }: ItemProps) {
  const guardId = useId();
  const { variant, title, message, details, action, guarded } = toast;
  const fullText = message ? `${title} — ${message}` : title;
  return (
    <div
      data-toast-id={toast.id}
      data-testid={toast.testId}
      data-variant={variant}
      className="pointer-events-auto w-full bg-surface rounded-lg shadow-xl animate-fade-in motion-reduce:animate-none"
    >
      <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm text-fg ${SHELL[variant]}`}>
        <ToastGlyph variant={variant} hard={toast.hardGlyph} />
        <div className="flex-1 min-w-0">
          {/* Wraps to three lines on a phone; the full text stays in `title`. */}
          <p className="break-words max-[640px]:line-clamp-3" title={fullText}>
            <span className={`font-medium ${TOAST_TEXT_TONE[variant]}`}>{title}</span>
            {message && <> — {message}</>}
          </p>
          {details}
          {action && (
            <button
              type="button"
              aria-disabled={pending || undefined}
              onClick={() => { if (!pending) onAction(toast); }}
              className={`block mt-1.5 text-xs underline ${TOAST_TEXT_TONE[variant]} transition rounded max-[640px]:min-h-11 aria-disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
            >
              {pending ? action.pendingLabel ?? `${action.label}…` : action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          // Undo guard: inert for 5 s but still focusable, so focus is never dropped.
          aria-disabled={guarded || undefined}
          aria-describedby={guarded ? guardId : undefined}
          title={guarded ? "Available in a few seconds" : undefined}
          onClick={() => { if (!guarded) onClose(toast.id); }}
          className="w-6 h-6 -my-0.5 -mr-1.5 max-[1024px]:w-11 max-[1024px]:h-11 max-[1024px]:-my-3 max-[1024px]:-mr-3 flex items-center justify-center shrink-0 text-lg leading-none text-fg-tertiary hover:text-fg transition rounded aria-disabled:opacity-40 aria-disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          ×
        </button>
        {guarded && <span id={guardId} className="sr-only">Available in a few seconds</span>}
      </div>
    </div>
  );
}

interface RegionProps {
  /** Already in display order: bottom of the stack first. */
  toasts: ToastRecord[];
  waiting: number;
  pendingIds: ReadonlySet<number>;
  regionRef: (el: HTMLElement | null) => void;
  onClose: (id: number) => void;
  onAction: (toast: ToastRecord) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusIn: (from: Element | null) => void;
  onFocusOut: () => void;
}

export default function ToastRegion({
  toasts, waiting, pendingIds, regionRef, onClose, onAction, onPointerEnter, onPointerLeave, onFocusIn, onFocusOut,
}: RegionProps) {
  if (toasts.length === 0) return null;
  return (
    <section
      ref={regionRef}
      role="region"
      aria-label="Notifications"
      // A click on a toast never closes an open card detail sheet (#1914).
      data-keeps-card-sheet-open
      data-testid="toast-region"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onFocus={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusIn(e.relatedTarget as Element | null);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusOut();
      }}
      // Floats 8px above BulkActionToolbar, which publishes its height as
      // --bulk-toolbar-h; with no toolbar the -0.5rem fallback leaves 1rem.
      style={{ bottom: "calc(1.5rem + var(--bulk-toolbar-h, -0.5rem))" }}
      className={[
        "fixed z-[55] flex flex-col-reverse gap-2 pointer-events-none",
        "left-1/2 -translate-x-1/2 w-max max-w-[min(24rem,calc(100%-2rem))]",
        "max-[820px]:left-4 max-[820px]:right-4 max-[820px]:translate-x-0 max-[820px]:mx-auto max-[820px]:w-auto max-[820px]:max-w-[28rem]",
        "max-[820px]:pb-[env(safe-area-inset-bottom)] max-[640px]:max-w-none",
      ].join(" ")}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} pending={pendingIds.has(t.id)} onClose={onClose} onAction={onAction} />
      ))}
      {waiting > 0 && (
        // Last in the DOM, so with flex-col-reverse it sits at the top of the stack.
        <p className="pointer-events-auto self-center rounded bg-surface px-2 py-0.5 text-xs text-fg-tertiary shadow" data-testid="toast-waiting">
          +{waiting} waiting
        </p>
      )}
    </section>
  );
}
