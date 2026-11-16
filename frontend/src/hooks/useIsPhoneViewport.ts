import { useEffect, useState } from "react";

// Phone width for the redesigned board (#2277): below Tailwind's `sm` (640px).
// Tablets keep the multi-column grid, which scrolls sideways inside its own box.
const PHONE_VIEWPORT_QUERY = "(max-width: 639px)";

function readInitial(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

/** True while the viewport is narrower than 640px (phone layout). */
export function useIsPhoneViewport(): boolean {
  const [isPhone, setIsPhone] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const update = () => setIsPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return isPhone;
}
