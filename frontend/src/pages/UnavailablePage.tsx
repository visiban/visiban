import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Layout/Navbar";
import type { User } from "../types";

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
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={[{ label: "Not available" }]} />
      <main className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 ref={headingRef} tabIndex={-1} className="text-fg text-2xl font-bold focus:outline-none">
          This {kind} isn&apos;t available
        </h1>
        <p className="text-sm text-fg-tertiary max-w-sm">
          It may have been deleted, or you may not have access to it. If someone sent you this link, ask them to check it.
        </p>
        <Link
          to="/"
          className="mt-2 px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis transition"
        >
          Back to dashboard
        </Link>
      </main>
    </div>
  );
}
