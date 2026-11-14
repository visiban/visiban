import { useEffect, useRef } from "react";

/**
 * Announces an inline Confirm/Cancel prompt to screen readers when it opens
 * (#1435).
 *
 * Why: the prompt's own wrapper mounts together with its text, and NVDA/JAWS
 * (and some VoiceOver builds) do not announce a live region that appears
 * already filled. Text inserted into a region that was already in the DOM is
 * announced reliably, so this hook keeps one visually hidden polite region
 * alive for the page's lifetime and writes the prompt into it on open.
 *
 * Usage: next to `useConfirmFocusReturn`, pass the prompt's text while the
 * confirm is open and `null` when it is closed:
 *
 *   useConfirmAnnouncement(pendingRemove === null ? null : `Remove ${name} from this board?`);
 *
 * The region is created the first time any host mounts (before any prompt can
 * open) and is shared: the latest open prompt wins, and closing a prompt clears
 * the region only if that prompt still owns it, so reopening the same prompt
 * announces again. It carries no `role`, so it never collides with the status
 * wrappers the prompts keep for failure text.
 */
const REGION_ATTR = "data-confirm-announcer";

function ensureRegion(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.querySelector<HTMLElement>(`[${REGION_ATTR}]`);
  if (existing?.isConnected) return existing;
  const el = document.createElement("div");
  el.setAttribute(REGION_ATTR, "");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");
  // Same visually-hidden recipe as Tailwind's `sr-only`; this node lives
  // outside React so it cannot take the class from a component.
  el.style.cssText =
    "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
  document.body.appendChild(el);
  return el;
}

export function useConfirmAnnouncement(message: string | null): void {
  const owner = useRef(Symbol("confirm-announcement"));

  // Mount the (empty) region ahead of any prompt opening.
  useEffect(() => {
    ensureRegion();
  }, []);

  useEffect(() => {
    if (message === null) return;
    const region = ensureRegion();
    if (!region) return;
    const me = owner.current;
    region.textContent = message;
    (region as HTMLElement & { _owner?: symbol })._owner = me;
    return () => {
      const r = region as HTMLElement & { _owner?: symbol };
      if (r._owner === me) {
        r.textContent = "";
        r._owner = undefined;
      }
    };
  }, [message]);
}
