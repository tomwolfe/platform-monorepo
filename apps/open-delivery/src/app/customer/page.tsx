"use client";

import React, { useState, useEffect } from 'react';
import Ably from 'ably';
import { ShoppingCart, MapPin, Clock, CheckCircle, Package, Utensils, Phone } from 'lucide-react';

interface OrderStatus {
  orderId: string;
  status: 'pending' | 'matched' | 'preparing' | 'pickup' | 'transit' | 'delivered' | 'cancelled';
  vendor: string;
  total: number;
  estimatedDelivery?: string;
  driver?: {
    name: string;
    phone?: string;
    rating?: number;
    trustScore?: number;
  };
  events: Array<{
    timestamp: string;
    event: string;
    details?: any;
  }>;
}

interface Vendor {
  id: string;
  name: string;
  category: string;
  rating: number;
  image: string;
  restaurantId?: string;
}

const mockVendors: Vendor[] = [
  { id: '1', name: "Green Garden", category: "Vegetarian", rating: 4.8, image: "🥗" },
  { id: '2', name: "Burger Barn", category: "Fast Food", rating: 4.2, image: "🍔" },
  { id: '3', name: "Sushi Star", category: "Japanese", rating: 4.9, image: "🍣" },
];

export default function CustomerDashboard() {
  const [activeOrder, setActiveOrder] = useState<OrderStatus | null>(null);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  // Ably real-time subscription for order updates
  useEffect(() => {
    if (!activeOrder) return;

    let ably: Ably.Realtime | null = null;
    let channel: Ably.RealtimeChannel | null = null;

    const setupAbly = async () => {
      try {
        ably = new Ably.Realtime({
          key: process.env.NEXT_PUBLIC_ABLY_API_KEY,
        });

        channel = ably.channels.get('nervous-system:updates');

        // Listen for order match event
        channel.subscribe('order.matched', (msg) => {
          if (msg.data.orderId === activeOrder.orderId) {
            setActiveOrder((prev) => {
              if (!prev) return null;
              return {
                ...prev,
                status: 'matched',
                driver: {
                  name: msg.data.driverName,
                  trustScore: msg.data.trustScore,
                },
                events: [
                  ...prev.events,
                  {
                    timestamp: msg.data.timestamp,
                    event: 'driver_matched',
                    details: { driverName: msg.data.driverName },
                  },
                ],
              };
            });
          }
        });

        // Listen for delivery status updates
        channel.subscribe('delivery.status_update', (msg) => {
          if (msg.data.orderId === activeOrder.orderId) {
            setActiveOrder((prev) => {
              if (!prev) return null;
              return {
                ...prev,
                status: msg.data.status,
                events: [
                  ...prev.events,
                  {
                    timestamp: msg.data.timestamp,
                    event: 'status_update',
                    details: { status: msg.data.status },
                  },
                ],
              };
            });
          }
        });

      } catch (error) {
        console.error('[Customer Ably] Setup error:', error);
      }
    };

    setupAbly();

    return () => {
      if (ably) {
        ably.close();
      }
    };
  }, [activeOrder?.orderId]);

  const handleOrderNow = async (vendor: Vendor) => {
    setSelectedVendor(vendor);
    setIsPlacingOrder(true);
    setOrderError(null);

    try {
      // Simulate order creation via MCP server
      // In production, this would call your order creation API
      const mockOrderId = `ord_${Date.now()}`;
      
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1500));

      setActiveOrder({
        orderId: mockOrderId,
        status: 'pending',
        vendor: vendor.name,
        total: 12.50,
        estimatedDelivery: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
        events: [
          {
            timestamp: new Date().toISOString(),
            event: 'order_created',
          },
        ],
      });
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : 'Failed to place order');
    } finally {
      setIsPlacingOrder(false);
    }
  };

  const getStatusIcon = (status: OrderStatus['status']) => {
    switch (status) {
      case 'pending': return <Clock className="text-blue-600" />;
      case 'matched': return <CheckCircle className="text-emerald-600" />;
      case 'preparing': return <Utensils className="text-amber-600" />;
      case 'transit': return <ShoppingCart className="text-blue-600" />;
      case 'delivered': return <CheckCircle className="text-green-600" />;
      case 'cancelled': return <CheckCircle className="text-red-600" />;
      default: return <Clock className="text-gray-600" />;
    }
  };

  const getStatusMessage = (status: OrderStatus['status']) => {
    switch (status) {
      case 'pending': return 'Waiting for driver...';
      case 'matched': return 'Driver on the way to restaurant';
      case 'preparing': return 'Restaurant is preparing your order';
      case 'pickup': return 'Driver has picked up your order';
      case 'transit': return 'Driver is on the way to you';
      case 'delivered': return 'Order delivered successfully!';
      case 'cancelled': return 'Order cancelled';
      default: return 'Processing...';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <header className="mb-8 flex justify-between items-center">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Package className="text-blue-600" /> OpenDeliver
        </h1>
        <div className="bg-white px-4 py-2 rounded-full shadow-sm flex items-center gap-2">
          <MapPin size={18} className="text-red-500" />
          <span className="text-sm font-medium">123 Tech Lane, San Francisco</span>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Vendor Selection */}
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-xl font-semibold mb-4">Nearby Vendors</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {mockVendors.map(vendor => (
              <div 
                key={vendor.id} 
                className="bg-white p-4 rounded-xl shadow-sm hover:shadow-md transition-shadow cursor-pointer border border-gray-100"
                onClick={() => handleOrderNow(vendor)}
              >
                <div className="text-4xl mb-3">{vendor.image}</div>
                <h3 className="font-bold text-lg">{vendor.name}</h3>
                <p className="text-gray-500 text-sm">{vendor.category} • ⭐ {vendor.rating}</p>
                <button
                  className="mt-4 w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors"
                  disabled={isPlacingOrder}
                >
                  {isPlacingOrder && selectedVendor?.id === vendor.id ? 'Placing Order...' : 'Order Now'}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Order Status Sidebar */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl shadow-lg border border-blue-50">
            <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
              <ShoppingCart size={20} /> Active Order
            </h2>

            {orderError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-4">
                {orderError}
              </div>
            )}

            {activeOrder ? (
              <div className="space-y-6">
                <div className="flex items-center gap-4">
                  <div className="bg-blue-100 p-3 rounded-full">
                    {getStatusIcon(activeOrder.status)}
                  </div>
                  <div>
                    <p className="font-bold">{activeOrder.vendor}</p>
                    <p className="text-sm text-gray-600">{getStatusMessage(activeOrder.status)}</p>
                    {activeOrder.estimatedDelivery && activeOrder.status !== 'delivered' && (
                      <p className="text-xs text-gray-500">ETA: ~25 mins</p>
                    )}
                  </div>
                </div>

                {activeOrder.driver && activeOrder.status === 'matched' && (
                  <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl">
                    <p className="text-xs text-emerald-700 font-bold uppercase mb-2">Your Driver</p>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-emerald-900">{activeOrder.driver.name}</p>
                        {activeOrder.driver.trustScore && (
                          <p className="text-xs text-emerald-600">Trust Score: {activeOrder.driver.trustScore}</p>
                        )}
                      </div>
                      <button className="bg-emerald-600 text-white p-2 rounded-full hover:bg-emerald-700">
                        <Phone size={16} />
                      </button>
                    </div>
                  </div>
                )}

                <div className="relative pl-8 space-y-8 before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-0.5 before:bg-blue-100">
                  <div className="relative flex items-center gap-3">
                    <div className={`absolute -left-8 w-6 h-6 rounded-full flex items-center justify-center border-4 border-white ${
                      activeOrder.events.some(e => e.event === 'order_created') 
                        ? 'bg-blue-600' 
                        : 'bg-gray-200'
                    }`}>
                      <CheckCircle size={12} className="text-white" />
                    </div>
                    <p className={`text-sm font-medium ${
                      activeOrder.events.some(e => e.event === 'order_created') 
                        ? 'text-gray-900' 
                        : 'text-gray-400'
                    }`}>
                      Order Confirmed
                    </p>
                  </div>
                  <div className="relative flex items-center gap-3">
                    <div className={`absolute -left-8 w-6 h-6 rounded-full flex items-center justify-center border-4 border-white ${
                      activeOrder.status === 'matched' || activeOrder.status === 'preparing'
                        ? 'bg-blue-600' 
                        : 'bg-gray-200'
                    }`}>
                      <CheckCircle size={12} className="text-white" />
                    </div>
                    <p className={`text-sm font-medium ${
                      activeOrder.status === 'matched' || activeOrder.status === 'preparing'
                        ? 'text-blue-600' 
                        : 'text-gray-400'
                    }`}>
                      Driver Picking Up
                    </p>
                  </div>
                  <div className="relative flex items-center gap-3">
                    <div className={`absolute -left-8 w-6 h-6 rounded-full border-4 border-white ${
                      activeOrder.status === 'transit'
                        ? 'bg-blue-600' 
                        : activeOrder.status === 'delivered'
                        ? 'bg-green-600'
                        : 'bg-gray-200'
                    }`}>
                      {activeOrder.status === 'delivered' && <CheckCircle size={12} className="text-white" />}
                    </div>
                    <p className={`text-sm font-medium ${
                      activeOrder.status === 'transit' || activeOrder.status === 'delivered'
                        ? 'text-gray-900' 
                        : 'text-gray-400'
                    }`}>
                      Out for Delivery
                    </p>
                  </div>
                </div>

                <div className="pt-6 border-t">
                  <div className="flex justify-between font-bold text-lg">
                    <span>Total</span>
                    <span>${activeOrder.total.toFixed(2)}</span>
                  </div>
                </div>

                {activeOrder.status === 'delivered' && (
                  <button
                    onClick={() => setActiveOrder(null)}
                    className="w-full bg-gray-100 text-gray-700 py-2 rounded-lg font-medium hover:bg-gray-200 transition-colors"
                  >
                    Place Another Order
                  </button>
                )}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-400">
                <Package size={48} className="mx-auto mb-4 opacity-20" />
                <p>No active orders</p>
                <p className="text-xs mt-2">Select a vendor to start ordering</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
