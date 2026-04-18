import type { ReactNode } from "react";
import { useIsLargeViewport } from "../../hooks/useIsLargeViewport";

interface ViewportGateProps {
  children: ReactNode;
}

/**
 * Renders a full-viewport notice when the screen is narrower than 1024px.
 * The board grid, swimlane panel, and sidebar require horizontal space that a
 * phone or portrait-mode tablet cannot provide, so the app surfaces an honest
 * "use a larger screen" message instead of a degraded layout.
 */
export default function ViewportGate({ children }: ViewportGateProps) {
  const isLarge = useIsLargeViewport();

  if (isLarge) {
    return <>{children}</>;
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="viewport-gate-heading"
      className="fixed inset-0 z-[100] bg-canvas flex items-center justify-center p-6"
    >
      <div className="bg-surface border border-line rounded-lg shadow-xl p-6 max-w-sm w-full text-center">
        <div className="flex justify-center mb-4 text-fg-muted">
          <svg
            className="w-10 h-10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="4" width="20" height="13" rx="1.5" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
        </div>
        <h1
          id="viewport-gate-heading"
          className="text-xl font-semibold text-white mb-2"
        >
          Visiban works best on a larger screen
        </h1>
        <p className="text-sm text-fg-secondary">
          This view is optimized for displays 1024px wide or larger. Please switch to a desktop or tablet in landscape mode to continue.
        </p>
      </div>
    </div>
  );
}
