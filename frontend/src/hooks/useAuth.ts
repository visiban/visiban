import { useState, useEffect } from "react";
import { getCurrentUser, logout as apiLogout } from "../api/auth";
import type { User } from "../types";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentUser()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handleSessionExpired = () => {
      // Clear any pending invite-link state so a subsequent user on the same
      // tab doesn't inherit a stale join intent from the previous session.
      sessionStorage.removeItem("pendingJoinToken");
      sessionStorage.removeItem("returnTo");
      setUser(null);
    };
    window.addEventListener("auth:sessionExpired", handleSessionExpired);
    return () => window.removeEventListener("auth:sessionExpired", handleSessionExpired);
  }, []);

  const logout = async () => {
    await apiLogout();
    sessionStorage.removeItem("pendingJoinToken");
    sessionStorage.removeItem("returnTo");
    setUser(null);
  };

  return { user, loading, logout, updateUser: setUser };
}
