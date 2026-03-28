import { useCallback, useEffect, useRef } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";

interface ModalWrapperProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
  /** When true, the close button and backdrop click are disabled. */
  dismissable?: boolean;
  /** Custom aria-labelledby id. Auto-generated from title if omitted. */
  labelId?: string;
  /** Optional subtitle shown below the title. */
  subtitle?: string;
  /** When true, children control their own padding. Used for scrollable or
   *  multi-section modals that need full layout control below the header. */
  noPadding?: boolean;
  /** Extra CSS classes to apply to the panel element. */
  panelClassName?: string;
  /** When true, a border is shown below the header. Useful for multi-section
   *  modals (tabbed, scrollable body with footer). */
  headerBorder?: boolean;
}

/**
 * Shared modal wrapper providing consistent backdrop, panel, close button,
 * and ARIA attributes per the design system spec:
 * - Backdrop: fixed inset-0 bg-black/60 z-50
 * - Panel: bg-slate-800 border border-slate-700 rounded-lg shadow-xl
 * - Close button: icon-only variant, top-right corner
 * - role="dialog" aria-modal="true"
 * - Click-outside-to-close on backdrop
 * - Escape key to close via useEscapeStack
 */
export default function ModalWrapper({
  open,
  onClose,
  title,
  children,
  maxWidth = "max-w-lg",
  dismissable = true,
  labelId,
  subtitle,
  noPadding = false,
  panelClassName,
  headerBorder = false,
}: ModalWrapperProps) {
  const headingId = labelId ?? "modal-title";
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key handling — only register when dismissable
  useEscapeStack(
    dismissable ? onClose : () => { /* intentionally blocked */ },
    40,
  );

  // Focus trap: move focus into the panel on mount
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (dismissable && e.target === e.currentTarget) {
        onClose();
      }
    },
    [dismissable, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className={`bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-full ${maxWidth} flex flex-col outline-none${panelClassName ? ` ${panelClassName}` : ""}`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 pt-6 pb-4${headerBorder ? " border-b border-slate-700" : ""}`}>
          <div>
            <h2 id={headingId} className="text-lg font-semibold text-white">
              {title}
            </h2>
            {subtitle && <p className="text-slate-400 text-sm mt-0.5">{subtitle}</p>}
          </div>
          {dismissable && (
            <button
              onClick={onClose}
              className="flex-shrink-0 text-slate-400 hover:text-white hover:bg-slate-700 rounded p-1 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5">
                <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>

        {/* Content */}
        {noPadding ? children : (
          <div className="px-6 pb-6">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
