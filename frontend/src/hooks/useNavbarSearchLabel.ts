import { matchPath, useLocation } from "react-router-dom";
import { formatShortcut, isMacPlatform } from "../utils/platform";

export interface NavbarSearchLabel {
  placeholder: string;
  ariaLabel: string;
  /** Hover tooltip: the placeholder-free phrasing with the shortcut in parentheses. */
  title: string;
}

// Placeholder text on the Row 1 palette trigger varies per surface so the
// label matches what the palette can actually do there (Option 2 from the
// #868/#869 UX design). `aria-label` uses plain words for screen readers
// The label repeats the visible placeholder and the shortcut exactly as the `kbd` chip
// spells it (formatShortcut: ⌘K on Apple, Ctrl+K elsewhere), outside any parentheses (axe
// drops parenthetical text when matching), so the accessible name contains the visible
// text (WCAG 2.5.3, #2467). `title` keeps the original tooltip wording.
// `boardsOnly` is for a page that lives on a board URL but has no board loaded
// (the Unavailable page): it must never promise cards or people (#2473).
export function useNavbarSearchLabel(boardsOnly = false): NavbarSearchLabel {
  const { pathname } = useLocation();
  const mod = isMacPlatform() ? "Cmd+K" : "Ctrl+K";
  const chip = formatShortcut({ mod: true, key: "K" });

  // matchPath, not startsWith: /boards/1/typo is the not-found page, not a board.
  if (!boardsOnly && matchPath("/boards/:id", pathname)) {
    return { placeholder: "Search cards, people, labels, fields", ariaLabel: `Search cards, people, labels, fields, ${chip}`, title: `Search cards (${mod})` };
  }
  // Off a board the palette searches only boards and actions (#2473), so the
  // copy never promises cards or people there.
  return { placeholder: "Jump to a board or action", ariaLabel: `Jump to a board or action, ${chip}`, title: `Jump to a board or action (${mod})` };
}
