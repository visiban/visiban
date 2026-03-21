import type { RefObject } from "react";
import { useEscapeStack } from "./useEscapeStack";

/**
 * Register an Escape handler for a dropdown at priority 25 (between inline
 * confirm dialogs at 20 and side panels at 30). When Escape is pressed and
 * the dropdown is open, calls onClose and returns focus to the trigger button.
 * Returns false (not handled) when the dropdown is closed so lower-priority
 * handlers still fire.
 */
export function useDropdownEscape(
  open: boolean,
  onClose: () => void,
  triggerRef: RefObject<HTMLButtonElement | null>,
): void {
  useEscapeStack(() => {
    if (!open) return false;
    onClose();
    triggerRef.current?.focus();
  }, 25);
}
