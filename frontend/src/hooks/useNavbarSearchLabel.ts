import { matchPath, useLocation } from "react-router-dom";
import { isMacPlatform } from "../utils/platform";

export interface NavbarSearchLabel {
  placeholder: string;
  ariaLabel: string;
}

// Placeholder text on the Row 1 palette trigger varies per surface so the
// label matches what the palette can actually do there (Option 2 from the
// #868/#869 UX design). `aria-label` uses plain words for screen readers
// instead of the visible `⌘K` glyph.
export function useNavbarSearchLabel(): NavbarSearchLabel {
  const { pathname } = useLocation();
  const mod = isMacPlatform() ? "Cmd+K" : "Ctrl+K";

  // matchPath, not startsWith: /boards/1/typo is the not-found page, not a board.
  if (matchPath("/boards/:id", pathname)) {
    return { placeholder: "Search cards…", ariaLabel: `Search cards (${mod})` };
  }
  if (pathname === "/" || pathname.startsWith("/groups/")) {
    return { placeholder: "Jump to board…", ariaLabel: `Jump to board (${mod})` };
  }
  return { placeholder: "Jump to…", ariaLabel: `Jump to (${mod})` };
}
