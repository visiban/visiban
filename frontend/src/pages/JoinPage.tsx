import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { resolveJoinToken, joinGroup } from "../api/groups";
import type { User } from "../types";

interface Props {
  user: User | null;
  onLogin: (user: User) => void;
}

export default function JoinPage({ user }: Props) {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [groupName, setGroupName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    resolveJoinToken(token)
      .then((data) => { setGroupName(data.group_name); setGroupId(data.group_id); })
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false));
  }, [token]);

  const handleJoin = async () => {
    if (!token) return;
    setJoining(true);
    setJoinError(null);
    try {
      await joinGroup(token);
      navigate(`/groups/${groupId}`, { state: { joinedGroup: groupName } });
    } catch {
      setJoinError("Failed to join group. The invite may have expired.");
    } finally {
      setJoining(false);
    }
  };

  const handleAuthRedirect = (mode: "login" | "register") => {
    sessionStorage.setItem("returnTo", `/join/${token}`);
    navigate("/", { state: { authMode: mode } });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <span className="text-gray-400">Checking invite…</span>
      </div>
    );
  }

  if (invalid) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 text-lg font-medium mb-2">Invalid or expired invite link</p>
          <p className="text-gray-500 text-sm">This link may have been revoked.</p>
          {user && (
            <button onClick={() => navigate("/")} className="mt-4 text-blue-400 hover:text-blue-300 text-sm">
              Go to dashboard
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="bg-gray-800 rounded-2xl shadow-2xl p-10 w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold text-white mb-2">You're invited</h1>
        <p className="text-gray-400 text-sm mb-6">
          Join <span className="text-white font-semibold">{groupName}</span> on Visiban
        </p>

        {user ? (
          <>
            <button
              onClick={handleJoin}
              disabled={joining}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg text-sm transition disabled:opacity-50"
            >
              {joining ? "Joining…" : `Join ${groupName}`}
            </button>
            {joinError && <p className="text-red-400 text-sm mt-3">{joinError}</p>}
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <button
              onClick={() => handleAuthRedirect("register")}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg text-sm transition"
            >
              Create account to join
            </button>
            <button
              onClick={() => handleAuthRedirect("login")}
              className="w-full bg-gray-700 hover:bg-gray-600 text-white font-medium py-2.5 rounded-lg text-sm transition"
            >
              Sign in to join
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
