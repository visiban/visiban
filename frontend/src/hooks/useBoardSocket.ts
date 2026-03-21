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
 * Opens a WebSocket connection to the board's real-time channel and calls
 * `onEvent` for every message received from the server.
 *
 * Reconnection behaviour: the socket reconnects automatically after 3 seconds
 * whenever it closes unexpectedly. Reconnection is suppressed for:
 *   - Normal closure (code 1000) — e.g. component unmount.
 *   - Auth rejection (code 4001 / 4003) — the server closes the socket when
 *     the session cookie is invalid or the user is no longer a board member.
 *     Reconnecting would loop indefinitely in those cases.
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

    const wsBase = (import.meta.env.VITE_API_URL || "http://localhost:8000")
      .replace(/^http/, "ws");
    const url = `${wsBase}/ws/boards/${boardId}/`;

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let canceled = false;

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => { if (!canceled) setStatus("connected"); };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as BoardEvent;
          onEventRef.current(data);
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = (e) => {
        if (canceled) return;
        // Auth rejection — stop here, no reconnect
        if (e.code === 4001 || e.code === 4003) {
          setStatus("failed");
          return;
        }
        // Normal unmount close — status stays as-is; component is gone
        if (e.code === 1000) return;
        // Unexpected close — schedule reconnect
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      canceled = true;
      clearTimeout(reconnectTimer);
      ws?.close(1000);
    };
  }, [boardId]);

  return { connected: status === "connected", status };
}
