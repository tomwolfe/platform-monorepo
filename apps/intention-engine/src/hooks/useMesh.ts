import { useEffect, useRef } from 'react';
import * as Ably from 'ably';

// Type-safe event handler for Nervous System updates
interface NervousSystemEvent {
  name: string;
  data: Record<string, unknown>;
}

export function useMesh(onEvent: (name: string, data: Record<string, unknown>) => void) {
  // Store the latest callback in a ref to avoid reconnecting Ably when the callback changes
  const savedOnEvent = useRef(onEvent);

  useEffect(() => {
    savedOnEvent.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let ably: Ably.Realtime | null = null;
    let channel: Ably.RealtimeChannel | null = null;
    let isMounted = true;

    try {
      ably = new Ably.Realtime({
        authUrl: '/api/ably/auth',
      });

      channel = ably.channels.get('nervous-system:updates');

      // Handle connection state changes
      ably.connection.on((stateChange) => {
        if (!isMounted) return;

        if (stateChange.current === 'closed' || stateChange.current === 'failed') {
          console.warn('[Mesh] Connection closed:', stateChange.reason?.message || 'Unknown reason');
        }
      });

      const listener = (message: NervousSystemEvent) => {
        if (!isMounted) return;
        console.log('[Mesh] Received real-time event:', message.name, message.data);
        savedOnEvent.current(message.name!, message.data);
      };

      channel.subscribe(listener);

      // Store on channel object for cleanup
      (channel as any)._listener = listener;
    } catch (err) {
      console.error('[Mesh] Failed to initialize:', err);
    }

    return () => {
      isMounted = false;

      try {
        if (channel && (channel as any)._listener) {
          channel.unsubscribe((channel as any)._listener);
        }
        if (ably) {
          // Prevent race conditions by checking connection state before closing
          if (ably.connection.state !== 'closed' && ably.connection.state !== 'closing') {
            ably.close();
          }
        }
      } catch (err) {
        // Ignore cleanup errors - connection may already be closed
        console.warn('[Mesh] Cleanup error:', err);
      }
    };
  }, []); // Empty dependency array ensures we only connect to Ably once
}
