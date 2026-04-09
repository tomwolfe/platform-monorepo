import { useEffect, useRef } from "react";
import * as Ably from "ably";

// Type-safe event handler for Nervous System updates
interface NervousSystemEvent {
  name: string;
  data: Record<string, unknown>;
}

// Module-level singleton to prevent duplicate Ably connections in React 18 Strict Mode
let ablyInstance: Ably.Realtime | null = null;
let channelInstance: Ably.RealtimeChannel | null = null;
let connectionCount = 0;

/**
 * Get or create the Ably singleton instance
 */
function getAblyInstance(): Ably.Realtime {
  if (
    !ablyInstance ||
    ablyInstance.connection.state === "closed" ||
    ablyInstance.connection.state === "failed"
  ) {
    ablyInstance = new Ably.Realtime({
      authUrl: "/api/ably/auth",
    });
    channelInstance = ablyInstance.channels.get("nervous-system:updates");
  }
  return ablyInstance;
}

/**
 * Clean up the Ably instance when all consumers have unmounted
 */
function cleanupAblyInstance(): void {
  connectionCount = Math.max(0, connectionCount - 1);

  if (connectionCount === 0 && ablyInstance) {
    try {
      if (channelInstance) {
        channelInstance.unsubscribe();
        ablyInstance.channels.release("nervous-system:updates");
        channelInstance = null;
      }

      if (
        ablyInstance.connection.state !== "closed" &&
        ablyInstance.connection.state !== "closing"
      ) {
        ablyInstance.close();
      }
    } catch (err) {
      console.warn("[Mesh] Cleanup error:", err);
    } finally {
      ablyInstance = null;
    }
  }
}

export function useMesh(
  onEvent: (name: string, data: Record<string, unknown>) => void,
) {
  // Store the latest callback in a ref to avoid reconnecting Ably when the callback changes
  const savedOnEvent = useRef(onEvent);

  useEffect(() => {
    savedOnEvent.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let isMounted = true;
    let listener: ((message: NervousSystemEvent) => void) | null = null;

    try {
      // Increment connection count
      connectionCount++;

      const ably = getAblyInstance();

      if (!channelInstance) {
        console.error("[Mesh] Channel not initialized");
        return;
      }

      // Handle connection state changes
      ably.connection.on((stateChange) => {
        if (!isMounted) return;

        if (
          stateChange.current === "closed" ||
          stateChange.current === "failed"
        ) {
          console.warn(
            "[Mesh] Connection closed:",
            stateChange.reason?.message || "Unknown reason",
          );
        }
      });

      listener = (message: NervousSystemEvent) => {
        if (!isMounted) return;
        console.log(
          "[Mesh] Received real-time event:",
          message.name,
          message.data,
        );
        savedOnEvent.current(message.name!, message.data);
      };

      channelInstance.subscribe(listener);
    } catch (err) {
      console.error("[Mesh] Failed to initialize:", err);
      connectionCount = Math.max(0, connectionCount - 1);
    }

    return () => {
      isMounted = false;

      try {
        if (listener && channelInstance) {
          channelInstance.unsubscribe(listener);
        }
      } catch (err) {
        // Ignore cleanup errors - connection may already be closed
        console.warn("[Mesh] Cleanup error:", err);
      }

      // Clean up the singleton when component unmounts
      cleanupAblyInstance();
    };
  }, []); // Empty dependency array ensures we only connect to Ably once
}
