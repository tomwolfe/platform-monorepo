"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Ably from 'ably';
import useSWR from 'swr';
import { Truck, MapPin, DollarSign, Star, Bell, Navigation, Package } from 'lucide-react';
import { acceptDelivery } from './actions';
import Link from 'next/link';

interface OrderIntent {
  id?: string; // For API compatibility
  orderId: string;
  fulfillmentId?: string;
  pickupAddress: string;
  deliveryAddress: string;
  subtotal?: number;
  tip?: number;
  price?: number;
  total?: number;
  priority?: string;
  items?: Array<{ name: string; quantity: number; price: number }>;
  timestamp: string;
  traceId?: string;
}

interface DriverProfile {
  id: string;
  fullName: string;
  email: string;
  trustScore: number;
  isActive: boolean;
}

interface DriverStats {
  todayEarnings: number;
  deliveriesCount: number;
  avgTimePerDelivery: number;
  trustScore: number;
}

const fetchPendingOrders = async (): Promise<OrderIntent[]> => {
  const res = await fetch('/api/driver/pending');
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to fetch orders');
  }
  const data = await res.json();
  return data.orders || [];
};

const fetchDriverStats = async (): Promise<DriverStats> => {
  const res = await fetch('/api/driver/stats');
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to fetch stats');
  }
  return res.json();
};

const checkDriverProfile = async (): Promise<{ hasProfile: boolean; profile?: DriverProfile; error?: string }> => {
  try {
    const res = await fetch('/api/driver/profile');
    if (res.status === 404) {
      return { hasProfile: false };
    }
    if (!res.ok) {
      const error = await res.json();
      return { hasProfile: false, error: error.error || 'Failed to check profile' };
    }
    const profile = await res.json();
    return { hasProfile: true, profile };
  } catch (err) {
    return { hasProfile: false, error: err instanceof Error ? err.message : 'Failed to check profile' };
  }
};

export default function DriverDashboard() {
  const [isOnline, setIsOnline] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [ablyError, setAblyError] = useState<string | null>(null);
  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [profileChecked, setProfileChecked] = useState(false);

  // Check driver profile on mount
  useEffect(() => {
    checkDriverProfile().then((result) => {
      if (result.hasProfile && result.profile) {
        setDriverProfile(result.profile);
      }
      setProfileChecked(true);
    });
  }, []);

  // SWR for driver stats
  const { data: stats, error: statsError, isLoading: statsLoading } = useSWR<DriverStats>(
    profileChecked && driverProfile ? '/api/driver/stats' : null,
    fetchDriverStats,
    {
      refreshInterval: 60000, // Refresh every minute
      revalidateOnFocus: true,
    }
  );

  // SWR for pending orders - only fetch when online
  const {
    data: availableOrders,
    mutate,
    error: ordersError,
    isLoading
  } = useSWR<OrderIntent[]>(
    isOnline ? '/api/driver/pending' : null,
    fetchPendingOrders,
    {
      refreshInterval: 30000, // Refresh every 30 seconds
      revalidateOnFocus: true,
    }
  );

  // Ably real-time subscription
  useEffect(() => {
    if (!isOnline) return;

    let ably: Ably.Realtime | null = null;
    let channel: Ably.RealtimeChannel | null = null;

    const setupAbly = async () => {
      try {
        // Fetch token from auth endpoint
        const authRes = await fetch('/api/ably/auth');
        
        if (!authRes.ok) {
          const errorData = await authRes.json();
          throw new Error(errorData.error || 'Auth failed');
        }

        const { tokenRequest, driverName, trustScore } = await authRes.json();

        // Initialize Ably with token auth
        ably = new Ably.Realtime({
          authUrl: '/api/ably/auth',
          authMethod: 'GET',
          authHeaders: {
            'Content-Type': 'application/json',
          },
          // Use token request directly
          authCallback: async (tokenParams: any, callback: any) => {
            try {
              const res = await fetch('/api/ably/auth');
              const data = await res.json();
              callback(null, data.tokenRequest);
            } catch (err) {
              callback(err);
            }
          },
        });

        channel = ably.channels.get('nervous-system:updates');

        // Listen for new delivery intents
        channel.subscribe('delivery.intent_created', (msg) => {
          console.log('[Ably] New intent created:', msg.data);
          
          // Optimistic update: prepend new order to list
          mutate((current) => {
            const newOrder: OrderIntent = {
              orderId: msg.data.orderId,
              fulfillmentId: msg.data.fulfillmentId,
              pickupAddress: msg.data.pickupAddress,
              deliveryAddress: msg.data.deliveryAddress,
              price: msg.data.price,
              priority: msg.data.priority,
              items: msg.data.items,
              timestamp: msg.data.timestamp,
              traceId: msg.data.traceId,
            };
            
            // Avoid duplicates
            if (current?.some(o => o.orderId === newOrder.orderId)) {
              return current;
            }
            return [newOrder, ...(current || [])];
          }, false);
        });

        // Listen for orders matched (taken by self or others)
        channel.subscribe('order.matched', (msg) => {
          console.log('[Ably] Order matched:', msg.data);
          
          // Remove matched order from available list
          mutate((current) => 
            (current || []).filter(o => o.orderId !== msg.data.orderId)
          , false);
        });

        // Connection state monitoring
        ably.connection.on('connected', () => {
          console.log('[Ably] Connected to real-time updates');
          setAblyError(null);
        });

        ably.connection.on('failed', (stateChange) => {
          console.error('[Ably] Connection failed:', stateChange.reason);
          setAblyError('Connection lost - reconnecting...');
        });

      } catch (error) {
        console.error('[Ably] Setup error:', error);
        setAblyError(error instanceof Error ? error.message : 'Failed to connect');
      }
    };

    setupAbly();

    // Cleanup on unmount or when going offline
    return () => {
      if (ably) {
        ably.close();
      }
    };
  }, [isOnline, mutate]);

  const handleAccept = useCallback(async (id: string) => {
    if (confirmingId === id) {
      // Final acceptance
      try {
        // Optimistic update: remove from list immediately
        mutate((current) => (current || []).filter(o => o.id !== id && o.orderId !== id), false);
        setConfirmingId(null);

        const result = await acceptDelivery(id);
        
        if (!result.success) {
          alert(`Failed to accept: ${result.error}`);
          // Revert on error
          mutate();
        }
      } catch (error) {
        console.error('Accept error:', error);
        alert('Failed to accept order');
        mutate();
      }
    } else {
      // First click - require confirmation
      setConfirmingId(id);
    }
  }, [confirmingId, mutate]);

  const handleGoOnline = useCallback(async () => {
    if (!driverProfile) {
      // No profile - user needs to register first
      return;
    }
    
    const newState = !isOnline;
    setIsOnline(newState);

    if (newState) {
      // Could trigger haptic feedback or sound here
      console.log('Driver went online');
    }
  }, [isOnline, driverProfile]);

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6">
      <header className="mb-8 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <Truck className="text-emerald-400" size={32} />
          <div>
            <h1 className="text-2xl font-bold">Driver Core</h1>
            <p className="text-slate-400 text-xs uppercase tracking-widest">OpenDeliver Network</p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          {driverProfile && (
            <div className="text-right hidden md:block">
              <div className="flex items-center gap-1 justify-end text-emerald-400">
                <Star size={14} fill="currentColor" />
                <span className="font-bold">{driverProfile.trustScore}</span>
              </div>
              <p className="text-slate-500 text-xs">Trust Score</p>
            </div>
          )}

          <button
            onClick={handleGoOnline}
            disabled={!profileChecked || !driverProfile}
            className={`px-6 py-2 rounded-full font-bold transition-all ${
              isOnline
                ? 'bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]'
                : !driverProfile
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-slate-700 text-slate-400'
            }`}
          >
            {!profileChecked ? 'Loading...' : !driverProfile ? 'Register First' : isOnline ? 'ONLINE' : 'GO ONLINE'}
          </button>
        </div>
      </header>

      {!profileChecked ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500"></div>
        </div>
      ) : !driverProfile ? (
        <div className="max-w-md mx-auto">
          <div className="bg-slate-800 p-8 rounded-2xl border border-slate-700 text-center">
            <Truck className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">No Driver Profile Found</h2>
            <p className="text-slate-400 mb-6">
              You need to register as a driver before you can start accepting deliveries.
            </p>
            <Link
              href="/driver/register"
              className="inline-block bg-emerald-500 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-400 transition-colors"
            >
              Register as Driver
            </Link>
          </div>
        </div>
      ) : (
        <>
          <main className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Stats Grid */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700">
            <div className="flex justify-between items-start mb-4">
              <p className="text-slate-400 text-sm">Today&apos;s Earnings</p>
              <DollarSign className="text-emerald-400" size={20} />
            </div>
            {statsLoading ? (
              <div className="animate-pulse">
                <div className="h-10 w-32 bg-slate-700 rounded mb-2"></div>
                <div className="h-4 w-24 bg-slate-700 rounded"></div>
              </div>
            ) : statsError ? (
              <p className="text-red-400 text-sm">Failed to load</p>
            ) : (
              <>
                <h2 className="text-3xl font-bold">${stats?.todayEarnings.toFixed(2) ?? "0.00"}</h2>
                <p className="text-emerald-400 text-xs mt-2">↑ 12% from yesterday</p>
              </>
            )}
          </div>

          <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700">
            <div className="flex justify-between items-start mb-4">
              <p className="text-slate-400 text-sm">Deliveries</p>
              <Truck className="text-blue-400" size={20} />
            </div>
            {statsLoading ? (
              <div className="animate-pulse">
                <div className="h-10 w-20 bg-slate-700 rounded mb-2"></div>
                <div className="h-4 w-32 bg-slate-700 rounded"></div>
              </div>
            ) : statsError ? (
              <p className="text-red-400 text-sm">Failed to load</p>
            ) : (
              <>
                <h2 className="text-3xl font-bold">{stats?.deliveriesCount ?? 0}</h2>
                <p className="text-slate-500 text-xs mt-2">Avg. {stats?.avgTimePerDelivery ?? 0} mins / delivery</p>
              </>
            )}
          </div>
        </div>

        {/* Available Intents */}
        <div className="lg:col-span-3 space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Bell size={20} className="text-emerald-400" />
              Available Delivery Intents
            </h2>
            {(stats?.trustScore ?? 0) > 90 && (
              <span className="text-xs bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full border border-emerald-500/20">
                Priority Access Enabled
              </span>
            )}
          </div>

          {ablyError && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-400 px-4 py-3 rounded-xl text-sm">
              ⚠️ {ablyError}
            </div>
          )}

          {!isOnline ? (
            <div className="bg-slate-800/50 border border-slate-700 border-dashed rounded-3xl py-20 text-center">
              <Navigation size={48} className="mx-auto mb-4 text-slate-600 animate-pulse" />
              <p className="text-slate-400">Go online to start receiving delivery intents</p>
            </div>
          ) : isLoading ? (
            <div className="bg-slate-800/50 border border-slate-700 border-dashed rounded-3xl py-20 text-center">
              <Package size={48} className="mx-auto mb-4 text-slate-600 animate-spin" />
              <p className="text-slate-400">Loading available orders...</p>
            </div>
          ) : ordersError ? (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-6 py-8 rounded-2xl text-center">
              <p className="font-bold">Failed to load orders</p>
              <p className="text-sm mt-1">{(ordersError as Error).message}</p>
            </div>
          ) : !availableOrders || availableOrders.length === 0 ? (
            <div className="bg-slate-800/50 border border-slate-700 border-dashed rounded-3xl py-20 text-center">
              <Package size={48} className="mx-auto mb-4 text-slate-600" />
              <p className="text-slate-400">No pending orders available</p>
              <p className="text-slate-500 text-sm mt-2">New orders will appear here in real-time</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {availableOrders.map((order) => {
                const orderId = (order as any).id || order.orderId;
                const displayId = orderId?.slice(0, 8).toUpperCase() || 'UNKNOWN';
                
                return (
                  <div
                    key={orderId}
                    className={`bg-slate-800 p-5 rounded-2xl border transition-all hover:scale-[1.02] cursor-pointer ${
                      order.priority === 'urgent'
                        ? 'border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.1)]'
                        : 'border-slate-700'
                    }`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-mono text-slate-500">{displayId}</span>
                      <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded-full border border-emerald-500/20">
                        Bid for Priority
                      </span>
                    </div>
                    <div className="flex justify-between items-end mb-4">
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase font-bold">Base: ${(order.subtotal || 0).toFixed(2)}</p>
                        <p className="text-xl font-bold text-emerald-400">Tip: ${(order.tip || 0).toFixed(2)}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-sm text-slate-400">Total Payout:</span>
                        <h2 className="text-3xl font-black text-white">${(order.total || 0).toFixed(2)}</h2>
                      </div>
                    </div>

                    {order.items && order.items.length > 0 && (
                      <div className="mb-4 p-3 bg-slate-900/50 rounded-xl border border-slate-700/50">
                        <p className="text-[10px] text-slate-500 uppercase mb-2">Items</p>
                        <div className="space-y-1">
                          {order.items.slice(0, 3).map((item, idx) => (
                            <div key={idx} className="flex justify-between text-xs">
                              <span className="text-slate-300">{item.name} ×{item.quantity}</span>
                              <span className="text-slate-500">${item.price.toFixed(2)}</span>
                            </div>
                          ))}
                          {order.items.length > 3 && (
                            <p className="text-xs text-slate-500">+{order.items.length - 3} more items</p>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="space-y-4 mb-6">
                      <div className="flex items-start gap-3">
                        <div className="w-2 h-2 rounded-full bg-slate-500 mt-1.5 shrink-0" />
                        <div className="flex-1">
                          <p className="text-xs text-slate-500 uppercase">Pickup</p>
                          <p className="text-sm font-medium truncate">{order.pickupAddress}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                        <div className="flex-1">
                          <p className="text-xs text-slate-500 uppercase">Delivery</p>
                          <p className="text-sm font-medium truncate">{order.deliveryAddress}</p>
                        </div>
                      </div>
                    </div>

                    {order.priority && (
                      <div className="mb-4">
                        <span className={`text-[10px] uppercase font-bold px-2 py-1 rounded-full ${
                          order.priority === 'urgent' 
                            ? 'bg-red-500/20 text-red-400 border border-red-500/30' 
                            : order.priority === 'express'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-slate-700 text-slate-400'
                        }`}>
                          {order.priority}
                        </span>
                      </div>
                    )}

                    <button
                      onClick={() => handleAccept(orderId)}
                      className={`w-full py-3 rounded-xl font-bold transition-all ${
                        confirmingId === orderId
                          ? 'bg-emerald-500 text-white animate-pulse'
                          : 'bg-white text-slate-900 hover:bg-emerald-400'
                      }`}
                    >
                      {confirmingId === orderId ? 'CONFIRM ACCEPTANCE' : 'ACCEPT INTENT'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
        </>
      )}
    </div>
  );
}
