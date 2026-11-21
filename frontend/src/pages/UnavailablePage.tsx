import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Layout/Navbar";
import type { User } from "../types";
import { buttonClasses } from "../components/Page";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  kind: "board" | "group";
}

/**
 * Shown when a board or group fails to load with 404 or 403 (#2041), at first
 * load or after being lost mid-session. One state and one copy for every cause:
 * the API answers a deleted resource and a revoked one identically, so the page
 * must not say which happened or it would leak what the API deliberately hides.
 * Mirrors NotFoundPage (#1740), which handles unmatched routes.
 */
export default function UnavailablePage({ user, onLogout, onUserUpdated, kind }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.title;
    document.title = "Not available – Visiban";
    // The page swaps in for content that may have held focus (or follows a
    // client-side navigation); announce the change.
    headingRef.current?.focus();
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="h-full bg-page flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={[{ label: "Not available" }]} />
      <main className="flex-1 flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
        <h1 ref={headingRef} tabIndex={-1} className="text-fg text-2xl font-bold focus:outline-none">
          This {kind} isn&apos;t available
        </h1>
        <p className="text-sm text-fg-secondary max-w-sm">
          It may have been deleted, or you don&apos;t have access to it. If someone sent you this link, ask them to add you to
          {kind === "board" ? " the board or its group." : " the group."}
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
            <kbd aria-hidden="true" className="rounded bg-surface-hover px-1.5 text-xs text-fg-secondary font-sans">⌘K</kbd>
          </button>
        </div>
      </main>
    </div>
  );
}
