import type { HelpTopicKey } from "./topics";

/**
 * The docs topic the user menu's "Help & docs" item opens on a given page (#2593):
 * the page's own docs, not the docs root. Pages without a mapped topic open the home page.
 */
export function helpTopicForPath(pathname: string): HelpTopicKey {
  if (pathname.startsWith("/boards/")) return "board.overview";
  if (pathname === "/groups" || pathname.startsWith("/groups/")) return "groups";
  if (pathname.startsWith("/admin")) return "admin.panel";
  return "home";
}
