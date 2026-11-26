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
 * MutationObserver repeats the attempt whenever focus is lost to `<body>` (the target mounted late, or the
 * control focused first was replaced by a re-render). It stops after `WATCH_MS`, on the next request, or on
 * unmount. Never poll with `requestAnimationFrame`.
 */
export function useFocusWhenPresent(): (find: Request["find"]) => void {
  const [req, setReq] = useState<Request | null>(null);
  const request = useCallback((find: Request["find"]) => setReq((prev) => ({ find, n: (prev?.n ?? 0) + 1 })), []);

  useLayoutEffect(() => {
    if (!req) return;
    const attempt = () => { req.find()?.focus(); };
    attempt();
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (!active || active === document.body) attempt();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), WATCH_MS);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [req]);

  return request;
}
