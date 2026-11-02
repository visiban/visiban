import { useEscapeStack } from "./useEscapeStack";

/**
 * Escape priority for an inline text field on the board page (add-card input,
 * column/swimlane/board rename, search boxes). Above BoardView's view-toggle
 * (15), focus-exit (12) and selection-clear (10) handlers, so Escape cancels
 * only the field and never also clears the card selection (#1860). Below the
 * dropdowns (25) and side panels (30), which are never open over a focused field.
 */
export const INLINE_EDIT_ESCAPE_PRIORITY = 21;

/**
 * Route an element-level Escape handler through the shared stack instead of an
 * `onKeyDown`. A React `onKeyDown` that does not consume the key lets the same
 * keypress reach the document-level stack, where BoardView's lower handlers
 * act on it too (#1856, #1860). `useEscapeStack` ignores `defaultPrevented`, so
 * only the stack's return value consumes the event.
 *
 * `isActive` is read at dispatch time; when it returns false the handler
 * returns false and Escape falls through to the lower handlers untouched.
 */
export function useInlineEditEscape(isActive: () => boolean, onEscape: () => void): void {
  useEscapeStack(() => {
    if (!isActive()) return false;
    onEscape();
  }, INLINE_EDIT_ESCAPE_PRIORITY);
}
