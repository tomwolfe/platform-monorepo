'use client';

import React, { useEffect, useState } from 'react';
import Ably from 'ably';
import { Bell, X } from 'lucide-react';

export default function LiveView({ restaurantId }: { restaurantId: string }) {
  const [notification, setNotification] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    if (!restaurantId) return;

    const ably = new Ably.Realtime({ authUrl: '/api/ably/auth' });
    const channel = ably.channels.get(`merchant:${restaurantId}`);

    channel.subscribe('delivery_dispatched', (message) => {
      setNotification({
        id: message.data.order_id,
        message: `Delivery Out: Order ${message.data.order_id} has been dispatched!`,
      });
      
      // Auto-hide after 5 seconds
      setTimeout(() => {
        setNotification(null);
      }, 5000);
    });

    return () => {
      channel.unsubscribe();
      ably.close();
    };
  }, [restaurantId]);

  if (!notification) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100]">
      <div className="bg-blue-600 text-white p-4 rounded-xl shadow-2xl flex items-center gap-4 max-w-sm transition-all animate-in fade-in slide-in-from-bottom-4">
        <div className="bg-blue-500 p-2 rounded-lg">
          <Bell className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">{notification.message}</p>
        </div>
        <button 
          onClick={() => setNotification(null)}
          className="text-blue-200 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
