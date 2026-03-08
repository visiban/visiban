import { useEffect, useRef, useState } from "react";

export type BoardEvent = {
  type: string;
  [key: string]: unknown;
};

export function useBoardSocket(
  boardId: number | null,
  onEvent: (event: BoardEvent) => void
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!boardId) return;

    const wsBase = (import.meta.env.VITE_API_URL || "http://localhost:8000")
      .replace(/^http/, "ws");
    const url = `${wsBase}/ws/boards/${boardId}/`;

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => { if (!cancelled) setConnected(true); };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as BoardEvent;
          onEventRef.current(data);
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = (e) => {
        setConnected(false);
        // Reconnect unless we closed intentionally or auth was rejected
        if (!cancelled && e.code !== 1000 && e.code !== 4001 && e.code !== 4003) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      ws?.close(1000);
    };
  }, [boardId]);

  return { connected };
}
