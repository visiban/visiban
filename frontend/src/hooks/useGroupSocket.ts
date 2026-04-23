import { useEffect, useRef, useState } from "react";
import type { BoardEvent, SocketStatus } from "./useBoardSocket";

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
  options?: { onReconnected?: () => void },
): { connected: boolean; status: SocketStatus } {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onReconnectedRef = useRef(options?.onReconnected);
  onReconnectedRef.current = options?.onReconnected;

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

    function resetPingTimeout() {
      clearTimeout(pingTimer);
      pingTimer = setTimeout(() => { ws?.close(4002); }, PING_TIMEOUT_MS);
    }

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (canceled) return;
        // Fire reconnected callback only after a prior successful open; avoids
        // a spurious reconcile on initial mount.
        const wasReconnect = everConnected;
        everConnected = true;
        setStatus("connected");
        resetPingTimeout();
        if (wasReconnect) onReconnectedRef.current?.();
      };

      ws.onmessage = (e) => {
        resetPingTimeout();
        try {
          const data = JSON.parse(e.data) as BoardEvent;
          if (data.event === "ping") return;
          onEventRef.current(data);
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = (e) => {
        clearTimeout(pingTimer);
        if (canceled) return;
        if (e.code === 4001 || e.code === 4003) { setStatus("failed"); return; }
        if (e.code === 1000) return;
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
  }, [groupId]);

  return { connected: status === "connected", status };
}
