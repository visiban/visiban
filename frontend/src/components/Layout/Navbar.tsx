import { useState } from "react";
import type { User } from "../../types";
import { userDisplayName } from "../../types";
import ProfileModal from "../Auth/ProfileModal";

interface Props {
  user: User;
  boardName?: string;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

export default function Navbar({ user, boardName, onLogout, onUserUpdated }: Props) {
  const [showProfile, setShowProfile] = useState(false);

  return (
    <>
      <header className="h-12 bg-gray-900 flex items-center px-4 gap-4 shrink-0">
        <span className="text-white font-bold tracking-wide">Visiban</span>
        {boardName && (
          <>
            <span className="text-gray-600">/</span>
            <span className="text-gray-300 text-sm font-medium">{boardName}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setShowProfile(true)}
            className="text-gray-400 text-sm hover:text-white transition"
          >
            {userDisplayName(user)}
          </button>
          <button
            onClick={onLogout}
            className="text-xs text-gray-400 hover:text-white transition"
          >
            Sign out
          </button>
        </div>
      </header>

      {showProfile && (
        <ProfileModal
          user={user}
          onClose={() => setShowProfile(false)}
          onUpdated={(updated) => { onUserUpdated(updated); setShowProfile(false); }}
        />
      )}
    </>
  );
}
