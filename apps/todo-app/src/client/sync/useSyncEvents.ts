import { useEffect, useRef } from "react";
import { z } from "zod";
import { getSessionToken } from "@every-app/sdk/core";
import { queryClient } from "../tanstack-db/queryClient";

/**
 * Reconnection backoff configuration.
 * - Base delay starts at 1 second
 * - Exponential backoff doubles the delay each attempt
 * - Maximum delay caps at 30 seconds to balance responsiveness with server load
 */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

/**
 * Delay before retrying connection when no auth token is available.
 * Shorter than reconnect delay since this is likely a timing issue during page load.
 */
const TOKEN_RETRY_DELAY_MS = 2000;

/**
 * Events that trigger query invalidation when received via sync.
 * All todo mutations invalidate the "todos" query.
 */
const INVALIDATING_SYNC_EVENTS = new Set([
  "createTodo",
  "updateTodo",
  "deleteTodo",
]);

const SyncMessageSchema = z.object({
  event: z.string(),
  timestamp: z.number(),
});

type SyncMessage = z.infer<typeof SyncMessageSchema>;

/**
 * Hook that connects to the sync WebSocket and invalidates queries when
 * mutations happen on other devices.
 */
export function useSyncEvents() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reconnectAttemptsRef = useRef(0);

  useEffect(() => {
    // Only run in browser
    if (typeof window === "undefined") {
      return;
    }

    const connect = async () => {
      let token: string;
      try {
        token = await getSessionToken();
      } catch {
        reconnectTimeoutRef.current = setTimeout(connect, TOKEN_RETRY_DELAY_MS);
        return;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/sync?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        const parsed = SyncMessageSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) {
          handleSyncMessage(parsed.data);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;

        // Reconnect with exponential backoff
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current),
          RECONNECT_MAX_DELAY_MS,
        );
        reconnectAttemptsRef.current++;
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);
}

function handleSyncMessage(message: SyncMessage) {
  if (INVALIDATING_SYNC_EVENTS.has(message.event)) {
    queryClient.invalidateQueries({ queryKey: ["todos"] });
  }
}
