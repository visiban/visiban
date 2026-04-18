import { useNavigate } from "react-router-dom";

interface Props {
  boardName: string;
}

/**
 * Top bar shown on the public share-link board view.
 * Includes the Visiban wordmark, board name, a "View only" badge, and a
 * sign-in CTA. No edit controls, settings, or member actions.
 */
export default function ShareBoardHeader({ boardName }: Props) {
  const navigate = useNavigate();

  return (
    <header className="h-12 bg-surface border-b border-line flex items-center px-4 gap-3 shrink-0">
      {/* Wordmark */}
      <img
        src="/brand/visiban_wordmark_dark.png"
        alt="Visiban"
        className="h-6 shrink-0"
      />

      {/* Separator */}
      <span className="text-fg-faint select-none">/</span>

      {/* Board name */}
      <span className="truncate min-w-0 text-sm text-fg-secondary" title={boardName}>
        {boardName}
      </span>

      {/* View only badge */}
      <span className="bg-info/20 text-info text-xs px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap">
        View only
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Sign-in CTA */}
      <button
        onClick={() => navigate("/login")}
        className="text-fg-secondary hover:text-white hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0"
      >
        Sign in to collaborate
      </button>
    </header>
  );
}
