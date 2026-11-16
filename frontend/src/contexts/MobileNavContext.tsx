import { createContext, useContext } from "react";

/**
 * Lets a page's app header (Navbar) carry the navigation-drawer button on phones (#2344).
 *
 * The shell owns the drawer state and the separate mobile navigation bar. On phones the
 * header takes over the hamburger so the two rows become one; the shell hides its own bar
 * only while a header has registered, so a route that renders no Navbar (a loading or
 * error state) still keeps a way into the drawer.
 */
export interface MobileNavValue {
  /** Whether the navigation drawer is open (for the button's aria-expanded). */
  open: boolean;
  openMenu: () => void;
  /** Called by a mounted header; returns its unregister function. Stable identity. */
  registerHeader: () => () => void;
}

export const MobileNavContext = createContext<MobileNavValue | null>(null);

export function useMobileNav(): MobileNavValue | null {
  return useContext(MobileNavContext);
}
