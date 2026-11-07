import { useEffect, useRef, useState } from "react";
import type { BoardEvent, SocketStatus } from "./useBoardSocket";
import { checkAndFlagDemoReset } from "../utils/demoReset";
import { probeSession } from "../utils/sessionProbe";

const PING_TIMEOUT_MS = 45_000;

/**
 * Opens a WebSocket connection to a group's real-time channel (#753) and calls
 * `onEvent` for every event received. Mirrors useBoardSocket's reconnect,
 * keepalive, and auth-rejection semantics so the two behave identically from
 * the caller's perspective — the only differences are the URL path and the
 * scope of events (group-level board create/update/delete).
 */
export function useGroupSocket(
  groupId: number | null,
  onEvent: (event: BoardEvent) => void,
  options?: { onReconnected?: () => void; onFirstConnected?: () => void; onServerClose?: () => void },
): { connected: boolean; status: SocketStatus; lastEventAt: number | null; reconnectAttempt: number } {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onReconnectedRef = useRef(options?.onReconnected);
  onReconnectedRef.current = options?.onReconnected;
  // Called on the first open for a given group (#2088), including one that only
  // succeeds after failed attempts. Exactly one of the two callbacks fires per
  // open. The caller loaded its lists over REST before this socket existed and
  // the server adds the socket to the group's broadcast group only during the
  // handshake, so a frame committed in between is lost; the caller decides
  // whether the gap was long enough to resync. Mirrors useBoardSocket (#1968).
  const onFirstConnectedRef = useRef(options?.onFirstConnected);
  onFirstConnectedRef.current = options?.onFirstConnected;
  // Fires when the server closes the socket with a normal 1000 the client did
  // not ask for (#2041): the server does this when this user was just removed
  // from the board or group. The caller re-reads over REST to find out whether
  // access is really gone.
  const onServerCloseRef = useRef(options?.onServerClose);
  onServerCloseRef.current = options?.onServerClose;

  useEffect(() => {
    if (!groupId) return;

    const wsBase = (import.meta.env.VITE_API_URL || window.location.origin)
      .replace(/^http/, "ws");
    const url = `${wsBase}/ws/groups/${groupId}/`;

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let pingTimer: ReturnType<typeof setTimeout>;
    let canceled = false;
    let everConnected = false;
    // Server-initiated 1000 closes since the last real frame. One reconnect is
    // allowed; a socket that is closed again before delivering anything stops
    // as failed rather than looping.
    let serverCloses = 0;

    function resetPingTimeout() {
      clearTimeout(pingTimer);
      pingTimer = setTimeout(() => { ws?.close(4002); }, PING_TIMEOUT_MS);
    }

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (canceled) return;
        // onReconnected only after a prior successful open; the first open gets
        // onFirstConnected instead (#2088) so the caller can close the
        // load-to-connect gap without a spurious reconcile on every mount.
        const wasReconnect = everConnected;
        everConnected = true;
        setStatus("connected");
        setReconnectAttempt(0);
        resetPingTimeout();
        if (wasReconnect) onReconnectedRef.current?.();
        else onFirstConnectedRef.current?.();
      };

      ws.onmessage = (e) => {
        resetPingTimeout();
        serverCloses = 0;
        setLastEventAt(Date.now());
        try {
          const data = JSON.parse(e.data) as BoardEvent;
          if (data.event === "ping") return;
          onEventRef.current(data);
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = (e) => {
        clearTimeout(pingTimer);
        if (canceled) return;
        if (e.code === 4001 || e.code === 4003) {
          setStatus("failed");
          // Same handling as useBoardSocket (#2037, #2044): an idle group page
          // makes no REST call, so the socket may be the only thing that
          // notices the session ended, and useAuth clears per-user prefs
          // (recent boards) only on auth:sessionExpired. A demo reset or a
          // 4001 (no valid credential) dispatches directly. A 4003 is
          // ambiguous (revoked credential, or merely lost group access, where
          // signing out would be wrong), so it probes the session and lets the
          // 401 interceptor sign out only if the session is dead.
          if (checkAndFlagDemoReset() || e.code === 4001) {
            window.dispatchEvent(new Event("auth:sessionExpired"));
          } else {
            void probeSession();
          }
          return;
        }
        // Our own close (unmount or group change) sets `canceled` first and so
        // returned above. A 1000 that reaches here was sent by the server: this
        // user was removed from the group (#2041). Re-read to find out; if
        // access is intact, reconnect like any unexpected close, but stop as
        // failed if the server closes again before sending a frame.
        if (e.code === 1000) {
          serverCloses += 1;
          onServerCloseRef.current?.();
          if (serverCloses > 1) { setStatus("failed"); return; }
        }
        // Anything else reconnects, including 1011 (the server could not
        // complete its access re-check; not a loss of access, #2003).
        setStatus("reconnecting");
        setReconnectAttempt((n) => n + 1);
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      canceled = true;
      clearTimeout(reconnectTimer);
      clearTimeout(pingTimer);
      ws?.close(1000);
    };
  }, [groupId]);

  return { connected: status === "connected", status, lastEventAt, reconnectAttempt };
}
