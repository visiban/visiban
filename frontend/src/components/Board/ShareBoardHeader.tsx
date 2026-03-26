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
    <header className="h-12 bg-slate-800 border-b border-slate-700 flex items-center px-4 gap-3 shrink-0">
      {/* Wordmark */}
      <img
        src="/brand/visiban_wordmark_dark.png"
        alt="Visiban"
        className="h-6 shrink-0"
      />

      {/* Separator */}
      <span className="text-slate-600 select-none">/</span>

      {/* Board name */}
      <span className="truncate min-w-0 text-sm text-slate-300" title={boardName}>
        {boardName}
      </span>

      {/* View only badge */}
      <span className="bg-blue-500/20 text-blue-400 text-xs px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap">
        View only
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Sign-in CTA */}
      <button
        onClick={() => navigate("/login")}
        className="text-slate-300 hover:text-white hover:bg-slate-700 px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0"
      >
        Sign in to collaborate
      </button>
    </header>
  );
}
