import { useCallback, useLayoutEffect, useState } from "react";

/** How long a request keeps watching for its target and for focus falling to the body. */
const WATCH_MS = 2000;

interface Request {
  find: () => HTMLElement | null | undefined;
  n: number;
}

/**
 * Focus a control that may not be in the DOM yet (focus rule 3, #2608, #2632).
 *
 * `request(find)` records the intent in state; a layout effect then tries `find()` in the commit that renders
 * the request, so focus never rests on `<body>` past paint. While the request is live, a scoped
 * MutationObserver repeats the attempt only if the target mounted late or the element it focused was
 * replaced by a re-render and focus fell to `<body>`. It stops after `WATCH_MS`, on the next request, or on
 * unmount. Never poll with `requestAnimationFrame`.
 */
export function useFocusWhenPresent(): (find: Request["find"]) => void {
  const [req, setReq] = useState<Request | null>(null);
  const request = useCallback((find: Request["find"]) => setReq((prev) => ({ find, n: (prev?.n ?? 0) + 1 })), []);

  useLayoutEffect(() => {
    if (!req) return;
    let focused: HTMLElement | null = null;
    const attempt = () => {
      const el = req.find();
      if (!el) return;
      el.focus();
      focused = el;
    };
    attempt();
    // Retry only while the target never mounted, or the element we focused was replaced and focus fell to
    // <body>. A user who moves focus away (or clicks empty space) afterward is never pulled back.
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      const lost = !active || active === document.body;
      if (lost && (focused === null || !focused.isConnected)) attempt();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), WATCH_MS);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [req]);

  return request;
}
