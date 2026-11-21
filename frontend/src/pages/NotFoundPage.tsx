import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Layout/Navbar";
import type { User } from "../types";
import { buttonClasses } from "../components/Page";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

/**
 * Catch-all for authenticated routes that match nothing (#1740). Previously
 * these redirected silently to the dashboard, so a mistyped or stale link gave
 * the user no explanation. Share links, boards, and groups never reach this
 * page: they are matched by their own routes; a missing or revoked board or
 * group shows UnavailablePage (#2041).
 */
export default function NotFoundPage({ user, onLogout, onUserUpdated }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.title;
    document.title = "Page not found – Visiban";
    // Client-side navigation unmounts the focused link; announce the change.
    headingRef.current?.focus();
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="h-full bg-page flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={[{ label: "Page not found" }]} />
      <main className="flex-1 flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
        <h1 ref={headingRef} tabIndex={-1} className="text-fg text-2xl font-semibold focus:outline-none">Page not found</h1>
        <p className="text-sm text-fg-secondary max-w-sm">
          There&apos;s no page at this address. Check it for typos, or go back to Home.
        </p>
        {/* Go to Home (Primary) and Search boards (Secondary); full width and stacked on phones (#2480). */}
        <div className="mt-2 flex w-full max-w-sm flex-col gap-2 sm:w-auto sm:max-w-none sm:flex-row">
          <Link to="/" className={buttonClasses("primary", { className: "max-sm:w-full" })}>
            Go to Home
          </Link>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("visiban:open-palette"))}
            aria-keyshortcuts="Meta+K Control+K"
            className={buttonClasses("secondary", { className: "max-sm:w-full" })}
          >
            Search boards
            <kbd aria-hidden="true" className="rounded border border-line bg-surface-active px-1.5 text-xs text-fg-secondary font-sans">{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
          </button>
        </div>
      </main>
    </div>
  );
}
