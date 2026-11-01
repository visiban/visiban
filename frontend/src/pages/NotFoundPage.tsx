import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Layout/Navbar";
import type { User } from "../types";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

/**
 * Catch-all for authenticated routes that match nothing (#1740). Previously
 * these redirected silently to the dashboard, so a mistyped or stale link gave
 * the user no explanation. Share links, boards, and groups never reach this
 * page: they are matched by their own routes. (A missing or revoked board or
 * group still redirects to the dashboard from its own page; unchanged here.)
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
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={[{ label: "Page not found" }]} />
      <main className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 ref={headingRef} tabIndex={-1} className="text-fg text-2xl font-bold focus:outline-none">Page not found</h1>
        <p className="text-sm text-fg-tertiary max-w-sm">
          This page doesn&apos;t exist, or the link is mistyped or out of date.
        </p>
        <Link
          to="/"
          className="mt-2 px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis transition"
        >
          Go to dashboard
        </Link>
      </main>
    </div>
  );
}
