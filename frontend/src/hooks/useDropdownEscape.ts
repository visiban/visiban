import type { RefObject } from "react";
import { useEscapeStack } from "./useEscapeStack";

/**
 * Register an Escape handler for a dropdown at priority 25 (between inline
 * confirm dialogs at 20 and side panels at 30). When Escape is pressed and
 * the dropdown is open, calls onClose and returns focus to the trigger button.
 * Returns false (not handled) when the dropdown is closed so lower-priority
 * handlers still fire.
 *
 * `priority` exists because 25 is *below* `ModalWrapper`'s 40 (#1140): a
 * dropdown rendered inside a modal would otherwise never consume Escape, so
 * the first Escape closes the whole modal and discards the form the user was
 * filling in. Any dropdown inside a modal must pass a priority above 40 —
 * see the allocation list in `frontend/CLAUDE.md`.
 */
export function useDropdownEscape(
  open: boolean,
  onClose: () => void,
  triggerRef: RefObject<HTMLButtonElement | null>,
  priority = 25,
): void {
  useEscapeStack(() => {
    if (!open) return false;
    onClose();
    triggerRef.current?.focus();
  }, priority);
}
