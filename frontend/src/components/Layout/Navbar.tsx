import type { User } from "../../types";

interface Props {
  user: User;
  boardName?: string;
  onLogout: () => void;
}

export default function Navbar({ user, boardName, onLogout }: Props) {
  return (
    <header className="h-12 bg-gray-900 flex items-center px-4 gap-4 shrink-0">
      <span className="text-white font-bold tracking-wide">Visiban</span>
      {boardName && (
        <>
          <span className="text-gray-600">/</span>
          <span className="text-gray-300 text-sm font-medium">{boardName}</span>
        </>
      )}
      <div className="ml-auto flex items-center gap-3">
        <span className="text-gray-400 text-sm">{user.first_name || user.username}</span>
        <button
          onClick={onLogout}
          className="text-xs text-gray-400 hover:text-white transition"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
