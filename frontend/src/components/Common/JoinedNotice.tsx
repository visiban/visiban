import type { ReactNode } from "react";

/**
 * The success strip shown after joining from an invite — on the group page
 * (#998) and on the board (#1444). Persistent until dismissed: it is the only
 * confirmation the join produced, so it never auto-dismisses.
 */
export default function JoinedNotice({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-center justify-between gap-3 px-4 py-2.5 bg-success/60 border-b border-success/50 text-success text-sm">
      <span>{children}</span>
      <button
        onClick={onDismiss}
        className="text-success hover:text-success transition text-lg leading-none shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}
