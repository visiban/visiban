import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  heading: string;
  description?: string;
  testId?: string;
}

/**
 * Canonical section-level empty state (frontend/CLAUDE.md § Empty states): a
 * centered muted decorative icon, a heading, and an optional sentence. Use it
 * instead of a one-off inline `<p>` so every empty section reads the same way.
 */
export default function SectionEmptyState({ icon, heading, description, testId }: Props) {
  return (
    <div className="flex flex-col items-center text-center py-6" data-testid={testId}>
      <span className="text-fg-faint mb-2" aria-hidden="true">{icon}</span>
      <p className="text-fg-tertiary text-sm">{heading}</p>
      {description && <p className="text-fg-muted text-sm">{description}</p>}
    </div>
  );
}
