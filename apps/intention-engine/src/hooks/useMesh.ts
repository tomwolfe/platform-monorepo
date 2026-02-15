import { useEffect } from 'react';
import * as Ably from 'ably';

export function useMesh(onEvent: (name: string, data: any) => void) {
  useEffect(() => {
    const ably = new Ably.Realtime({
      authUrl: '/api/ably/auth',
    });

    const channel = ably.channels.get('nervous-system:updates');
    
    channel.subscribe((message) => {
      console.log('[Mesh] Received real-time event:', message.name, message.data);
      onEvent(message.name!, message.data);
    });

    return () => {
      channel.unsubscribe();
      ably.close();
    };
  }, [onEvent]);
}
