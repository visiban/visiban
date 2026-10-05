import { useEffect, useRef, useState } from "react";
import { checkAndFlagDemoReset } from "../utils/demoReset";

export type BoardEvent = {
  event: string;
  data: Record<string, unknown>;
  /**
   * Id of the row this frame has in the board change feed (#1114).
   *
   * Optional because it is additive and absent on any frame broadcast without a
   * feed row — the group channel's frames, for instance. Nothing in the SPA
   * reads it yet; on reconnect the SPA re-fetches `/full/` via the
   * `onReconnected` option (#1463). It is declared here so the type keeps matching what the server
   * sends, and so a future resume-from-cursor client does not have to widen the
   * type first.
   */
  event_id?: number;
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
 * `options.onReconnected` fires on each successful open after the first, so
 * callers can resync state missed during the gap (#1463). It does not fire on
 * the initial connect.
 *
 * `onEvent` is stored in a ref so callers can pass an inline arrow function
 * without causing the effect to re-run on every render.
 */
export function useBoardSocket(
  boardId: number | null,
  onEvent: (event: BoardEvent) => void,
  options?: { onReconnected?: () => void },
): { connected: boolean; status: SocketStatus; lastEventAt: number | null; reconnectAttempt: number } {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  // `lastEventAt` ticks once per incoming message (including pings). It's used
  // by ConnectionStatus + useIsStale to decide when to show the "stale" badge.
  // Kept in state (not ref) so consumers re-render when a new event lands;
  // pings arrive every 30 s so the re-render cost is negligible.
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  // Reconnect counter: increments on every `onclose → reconnecting` transition,
  // resets on successful open. Surfaced by ConnectionStatus during the
  // "reconnecting" state; intentionally not shown during the first "connecting".
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  // Called on every open after the first one for a given board. Events
  // broadcast while the socket was down are lost, so the caller refetches
  // (#1463). Bypasses the visibility throttle: a reconnect is a real gap signal.
  const onReconnectedRef = useRef(options?.onReconnected);
  onReconnectedRef.current = options?.onReconnected;

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
    // Per-effect (so per-board): navigating to another board opens a new
    // socket whose first open is an initial connect, not a reconnect.
    let everConnected = false;

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
          const wasReconnect = everConnected;
          everConnected = true;
          setStatus("connected");
          setReconnectAttempt(0);
          resetPingTimeout();
          if (wasReconnect) onReconnectedRef.current?.();
        }
      };

      ws.onmessage = (e) => {
        resetPingTimeout();
        setLastEventAt(Date.now());
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
          // Hosted demo (#1179): an idle visitor watching a board makes no
          // REST call, so the socket is the only thing that notices the
          // scheduled reset ended the session. If the reset time has passed,
          // route them to the login page's "demo was reset" notice through
          // the same event the REST 401 path uses, instead of a dead socket.
          if (checkAndFlagDemoReset()) {
            window.dispatchEvent(new Event("auth:sessionExpired"));
          }
          return;
        }
        // Normal unmount close — status stays as-is; component is gone
        if (e.code === 1000) return;
        // Unexpected close (including ping timeout 4002) — schedule reconnect
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
  }, [boardId]);

  return { connected: status === "connected", status, lastEventAt, reconnectAttempt };
}
