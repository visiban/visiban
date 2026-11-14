import { useEffect, useRef } from "react";
import type { ImportSummary } from "../../types";
import { useToast } from "../../contexts/useToast";
import {
  formatImportSkipped,
  IMPORT_SKIPPED_TOAST_MS,
  IMPORT_WARNINGS_HEADLINE,
  countImportWarnings,
  importWarnings,
  unmatchedAssignees,
} from "../../utils/importSummary";

interface Props {
  summary: ImportSummary;
  onDismiss: () => void;
}

export const IMPORT_TOAST_KEY = "import-summary";

/**
 * Informational notice shown on the new board after an import left something
 * out (#119) or dropped values (CSV `import_summary.warnings`, #1526), as an
 * `info` toast in the shared region (frontend/CLAUDE.md § Post-import notice
 * for the content, § Toasts for placement and timing). Informational tone,
 * never amber: the import succeeded and there is nothing for the user to act
 * on, even when it reports dropped values. Raises nothing when there is
 * nothing to report.
 *
 * A notice that lists warnings or reports unmatched assignees (#2198) persists
 * until dismissed; the option-skips-only notice auto-dismisses after 8 s, and the region pauses it while hovered or
 * focused. The announcement carries the headline and a count, never the list;
 * the list stays a focusable, labeled `ul` in the visible toast so it is
 * reachable by keyboard. Renders nothing itself.
 */
export default function ImportSkippedToast({ summary, onDismiss }: Props) {
  const { notify, dismiss } = useToast();
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const warnings = importWarnings(summary);
    const skippedMessage = formatImportSkipped(summary);
    const message = skippedMessage ?? (warnings.length > 0 ? IMPORT_WARNINGS_HEADLINE : null);
    if (!message) return;
    const warningCount = countImportWarnings(warnings);
    notify({
      key: IMPORT_TOAST_KEY,
      variant: "info",
      title: message,
      details: warnings.length > 0 ? (
        <ul
          tabIndex={0}
          aria-label="Import warnings"
          className="mt-2 list-disc pl-4 space-y-1 text-xs text-fg-secondary max-h-40 overflow-y-auto rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {warnings.map((w, i) => (
            <li key={i} className="break-words">{w}</li>
          ))}
        </ul>
      ) : undefined,
      // A notice carrying warnings, or unmatched assignees the user may need to
      // reassign (#2198), is never timed out: the user needs time to act on it.
      durationMs: warnings.length > 0 || unmatchedAssignees(summary) > 0 ? null : IMPORT_SKIPPED_TOAST_MS,
      announceText: warnings.length > 0
        ? `${skippedMessage ? `${skippedMessage} ` : "Board imported. "}${warningCount} import ${warningCount === 1 ? "warning" : "warnings"}.`
        : message,
      onDismiss: () => dismissRef.current(),
      testId: "import-notice",
    });
  }, [summary, notify]);

  useEffect(() => () => dismiss(IMPORT_TOAST_KEY), [dismiss]);

  return null;
}
