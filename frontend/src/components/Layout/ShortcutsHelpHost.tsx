import { useCallback, useEffect, useState } from "react";
import KeyboardShortcutsOverlay from "../Board/KeyboardShortcutsOverlay";
import { shouldIgnoreGlobalShortcut } from "../../utils/keyboard";
import { OPEN_SHORTCUTS_EVENT, SHOW_BOARD_SHORTCUTS_EVENT } from "./shellNavModel";

/**
 * The one `?` handler in the app (#2473). Before this, `?` was bound only
 * inside BoardView and the account menu's item was disabled off a board. Both
 * now route here, so two handlers never both fire. Typing contexts are
 * ignored through the shared `shouldIgnoreGlobalShortcut`, which also yields to popovers and any open modal.
 */
export default function ShortcutsHelpHost() {
  const [open, setOpen] = useState(false);

  const show = useCallback(() => {
    const unclaimed = window.dispatchEvent(new CustomEvent(SHOW_BOARD_SHORTCUTS_EVENT, { cancelable: true }));
    if (unclaimed) setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (shouldIgnoreGlobalShortcut(e.target)) return;
      e.preventDefault();
      show();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, show);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, show);
    };
  }, [show]);

  if (!open) return null;
  return <KeyboardShortcutsOverlay onBoard={false} onClose={() => setOpen(false)} />;
}
