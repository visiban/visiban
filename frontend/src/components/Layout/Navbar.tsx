import { useState } from "react";
import { Link } from "react-router-dom";
import type { User } from "../../types";
import { userDisplayName } from "../../types";
import ProfileModal from "../Auth/ProfileModal";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface Props {
  user: User;
  breadcrumb?: BreadcrumbItem[];
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

export default function Navbar({ user, breadcrumb, onLogout, onUserUpdated }: Props) {
  const [showProfile, setShowProfile] = useState(false);

  return (
    <>
      <header className="h-12 bg-gray-900 flex items-center px-4 gap-2 shrink-0">
        <Link to="/" className="text-white font-bold tracking-wide hover:text-gray-200 transition">
          Visiban
        </Link>
        {breadcrumb?.map((item, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="text-gray-600">/</span>
            {item.href ? (
              <Link to={item.href} className="text-gray-300 text-sm font-medium hover:text-white transition">
                {item.label}
              </Link>
            ) : (
              <span className="text-gray-300 text-sm font-medium">{item.label}</span>
            )}
          </span>
        ))}
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
