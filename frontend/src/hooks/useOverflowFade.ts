import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Tracks whether a popover's scroll region has more content below the fold
 * (#1455), so the caller can render the bottom fade only while it applies.
 * macOS hides scrollbars, so the fade is the only overflow cue. Pass the
 * returned `onScroll` to the region and `deps` for anything that changes its
 * content height.
 */
export function useOverflowFade(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[] = [],
): { moreBelow: boolean; onScroll: () => void } {
  const [moreBelow, setMoreBelow] = useState(false);
  const update = () => {
    const el = ref.current;
    if (el) setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's list of content-affecting inputs
  useLayoutEffect(update, deps);
  return { moreBelow, onScroll: update };
}
