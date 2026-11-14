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

// Which prompt currently owns each region's text (a WeakMap, not a DOM expando).
const owners = new WeakMap<HTMLElement, symbol>();

/**
 * The region for the topmost open `aria-modal` dialog, else the page's. A screen
 * reader that honors `aria-modal` may ignore a live region outside the active
 * dialog, so a prompt opened inside a modal needs its region inside that modal.
 */
function ensureRegion(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  const container = modals.length > 0 ? modals[modals.length - 1] : document.body;
  const existing = Array.from(container.children).find(
    (c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute(REGION_ATTR),
  );
  if (existing) return existing;
  const el = document.createElement("div");
  el.setAttribute(REGION_ATTR, "");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");
  // Same visually-hidden recipe as Tailwind's `sr-only`; this node lives
  // outside React so it cannot take the class from a component.
  el.style.cssText =
    "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
  container.appendChild(el);
  return el;
}

/** Create the page-level region at app boot so it exists before any prompt opens. */
export function mountConfirmAnnouncer(): void {
  ensureRegion();
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
    owners.set(region, me);
    region.textContent = message;
    return () => {
      if (owners.get(region) === me) {
        region.textContent = "";
        owners.delete(region);
      }
    };
  }, [message]);
}
