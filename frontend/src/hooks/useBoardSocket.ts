import { useEffect, useRef, useState } from "react";

export type BoardEvent = {
  event: string;
  data: Record<string, unknown>;
};

/**
 * The connection state exposed by the hook.
 *   connecting   — initial connect attempt in progress (before onopen fires)
 *   connected    — socket is open and receiving events
 *   reconnecting — socket closed unexpectedly; a reconnect timer is running
 *   failed       — auth rejected (code 4001/4003); no further reconnect attempts
 */
export type SocketStatus = "connecting" | "connected" | "reconnecting" | "failed";

/**
 * How long (ms) the client waits for *any* message (including server pings)
 * before assuming the connection is dead.  The server sends a ping every 30 s,
 * so 45 s gives a comfortable margin for network jitter.
 */
const PING_TIMEOUT_MS = 45_000;

/**
 * Opens a WebSocket connection to the board's real-time channel and calls
 * `onEvent` for every message received from the server.
 *
 * Reconnection behavior: the socket reconnects automatically after 3 seconds
 * whenever it closes unexpectedly. Reconnection is suppressed for:
 *   - Normal closure (code 1000) — e.g. component unmount.
 *   - Auth rejection (code 4001 / 4003) — the server closes the socket when
 *     the session cookie is invalid or the user is no longer a board member.
 *     Reconnecting would loop indefinitely in those cases.
 *
 * Keepalive: the server sends `{"event":"ping"}` every 30 seconds.  If no
 * message arrives within `PING_TIMEOUT_MS` (45 s), the client treats the
 * connection as dead, closes the socket, and triggers a reconnect.  Ping
 * events are silently consumed — they are not forwarded to `onEvent`.
 *
 * `onEvent` is stored in a ref so callers can pass an inline arrow function
 * without causing the effect to re-run on every render.
 */
export function useBoardSocket(
  boardId: number | null,
  onEvent: (event: BoardEvent) => void
): { connected: boolean; status: SocketStatus } {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!boardId) return;

    // When VITE_API_URL is "" (the default in production Docker builds, meaning
    // the API is served from the same origin via nginx), fall back to
    // window.location.origin so the WebSocket connects to the same host as the
    // page.  Using || here (not ??) is intentional: empty string is falsy and
    // must not be passed through — it would produce a broken URL like
    // "ws:///ws/boards/5/".
    const wsBase = (import.meta.env.VITE_API_URL || window.location.origin)
      .replace(/^http/, "ws");
    const url = `${wsBase}/ws/boards/${boardId}/`;

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let pingTimer: ReturnType<typeof setTimeout>;
    let canceled = false;

    function resetPingTimeout() {
      clearTimeout(pingTimer);
      pingTimer = setTimeout(() => {
        // No message received within the timeout window — assume dead.
        // Close with a non-1000 code so onclose triggers a reconnect.
        ws?.close(4002);
      }, PING_TIMEOUT_MS);
    }

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (!canceled) {
          setStatus("connected");
          resetPingTimeout();
        }
      };

      ws.onmessage = (e) => {
        resetPingTimeout();
        try {
          const data = JSON.parse(e.data) as BoardEvent;
          // Silently consume server keepalive pings — they are not board events.
          if (data.event === "ping") return;
          onEventRef.current(data);
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = (e) => {
        clearTimeout(pingTimer);
        if (canceled) return;
        // Auth rejection — stop here, no reconnect
        if (e.code === 4001 || e.code === 4003) {
          setStatus("failed");
          return;
        }
        // Normal unmount close — status stays as-is; component is gone
        if (e.code === 1000) return;
        // Unexpected close (including ping timeout 4002) — schedule reconnect
        setStatus("reconnecting");
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
  }, [boardId]);

  return { connected: status === "connected", status };
}
