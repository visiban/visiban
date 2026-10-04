import { useCallback, useEffect, useRef } from "react";

/**
 * Restores keyboard focus to the trigger that opened an inline destructive
 * confirm (Confirm/Cancel row) once that confirm closes (#1367).
 *
 * Why: most inline confirms swap the trigger out while the prompt is open, and
 * even when the trigger stays mounted, the focused Cancel button unmounts on
 * dismiss. Either way the browser drops focus to `body` and a keyboard user
 * loses their place in the list.
 *
 * Usage: pass the key of the currently open confirm (or `null` when none is
 * open) and attach `triggerRef(key)` to each trigger button. When `activeKey`
 * goes from a value to `null`, focus moves to the trigger registered under the
 * previous key. Because the trigger may have been re-mounted, the element is
 * looked up by key at that moment rather than captured at click time.
 *
 * Focus is only restored when it would otherwise be lost (`document.body`), so
 * it never steals focus the user has already moved elsewhere. If the trigger no
 * longer exists (the confirmed action removed its row) this is a no-op.
 */
export function useConfirmFocusReturn<K extends string | number>(activeKey: K | null) {
  const triggers = useRef(new Map<K, HTMLElement>());
  const previousKey = useRef<K | null>(null);

  useEffect(() => {
    const prev = previousKey.current;
    previousKey.current = activeKey;
    if (prev === null || activeKey !== null) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    triggers.current.get(prev)?.focus();
  }, [activeKey]);

  return useCallback(
    (key: K) => (el: HTMLElement | null) => {
      if (el) triggers.current.set(key, el);
      else triggers.current.delete(key);
    },
    [],
  );
}
