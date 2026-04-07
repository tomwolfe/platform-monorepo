'use client';

import React, { useEffect, useState } from 'react';
import Ably from 'ably';
import { IconAfterMount } from '@/components/ui/IconWrapper';
import { Bell, X } from 'lucide-react';
import { DeliveryDispatchedPayload, isDeliveryDispatchedPayload } from '@repo/shared/types/events';

export default function LiveView({ restaurantId }: { restaurantId: string }) {
  const [notification, setNotification] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    if (!restaurantId) return;

    const ably = new Ably.Realtime({ authUrl: '/api/ably/auth' });
    const channel = ably.channels.get(`merchant:${restaurantId}`);

    const deliveryListener = (message: Ably.InboundMessage) => {
      const data = message.data as DeliveryDispatchedPayload;
      
      if (!isDeliveryDispatchedPayload(data)) {
        return;
      }
      
      setNotification({
        id: data.order_id,
        message: `Delivery Out: Order ${data.order_id} has been dispatched!`,
      });

      // Auto-hide after 5 seconds
      setTimeout(() => {
        setNotification(null);
      }, 5000);
    };

    channel.subscribe('delivery_dispatched', deliveryListener);

    return () => {
      try {
        channel.unsubscribe('delivery_dispatched', deliveryListener);
        // Prevent race conditions by checking connection state before closing
        if (ably.connection.state !== 'closed' && ably.connection.state !== 'closing') {
          ably.close();
        }
      } catch {
        // Ignore cleanup errors
      }
    };
  }, [restaurantId]);

  if (!notification) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100]">
      <div className="bg-blue-600 text-white p-4 rounded-xl shadow-2xl flex items-center gap-4 max-w-sm transition-all animate-in fade-in slide-in-from-bottom-4">
        <div className="bg-blue-500 p-2 rounded-lg">
          <IconAfterMount>
            <Bell className="w-5 h-5 text-white" />
          </IconAfterMount>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">{notification.message}</p>
        </div>
        <button
          onClick={() => setNotification(null)}
          className="text-blue-200 hover:text-white transition-colors"
        >
          <IconAfterMount>
            <X className="w-5 h-5" />
          </IconAfterMount>
        </button>
      </div>
    </div>
  );
}
