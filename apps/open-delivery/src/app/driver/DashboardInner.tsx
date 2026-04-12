"use client";

import React, { useState, useEffect, useCallback } from "react";
import Ably from "ably";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Truck,
  MapPin,
  DollarSign,
  Star,
  Bell,
  Navigation,
  Package,
  Wallet,
} from "lucide-react";
import { acceptDelivery, linkDriverWallet, getDriverWallet } from "./actions";
import Link from "next/link";
import { ConnectWallet } from "@repo/ui-theme";
import { useAccount } from "wagmi";
import { useApiError } from "@repo/ui-theme";

// Force dynamic rendering to avoid SSR issues with wagmi hooks
export const dynamic = "force-dynamic";

// Type-safe event payloads
interface DeliveryIntentPayload {
  orderId: string;
  fulfillmentId?: string;
  pickupAddress: string;
  deliveryAddress: string;
  price?: number;
  priority?: string;
  items?: Array<{ name: string; quantity: number; price: number }>;
  timestamp: string;
  traceId?: string;
  [key: string]: unknown;
}

interface OrderMatchedPayload {
  orderId: string;
  driverId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

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
  walletAddress?: string | null;
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
  const res = await fetch("/api/driver/pending");
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || "Failed to fetch orders");
  }
  const data = await res.json();
  return data.orders || [];
};

const fetchDriverStats = async (): Promise<DriverStats> => {
  const res = await fetch("/api/driver/stats");
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || "Failed to fetch stats");
  }
  return res.json();
};

const checkDriverProfile = async (): Promise<{
  hasProfile: boolean;
  profile?: DriverProfile;
  error?: string;
}> => {
  try {
    const res = await fetch("/api/driver/profile");
    if (res.status === 404) {
      return { hasProfile: false };
    }
    if (!res.ok) {
      const error = await res.json();
      return {
        hasProfile: false,
        error: error.error || "Failed to check profile",
      };
    }
    const profile = await res.json();
    return { hasProfile: true, profile };
  } catch (err) {
    return {
      hasProfile: false,
      error: err instanceof Error ? err.message : "Failed to check profile",
    };
  }
};

export default function DriverDashboardInner() {
  const [isOnline, setIsOnline] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [ablyError, setAblyError] = useState<string | null>(null);
  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(
    null,
  );
  const [profileChecked, setProfileChecked] = useState(false);
  const [walletSynced, setWalletSynced] = useState(false);

  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const { handleApiError } = useApiError({
    defaultTitle: "Driver Dashboard Error",
  });

  // Check driver profile on mount
  useEffect(() => {
    checkDriverProfile().then((result) => {
      if (result.hasProfile && result.profile) {
        setDriverProfile(result.profile);
      }
      setProfileChecked(true);
    });
  }, []);

  // Auto-sync connected wallet to driver profile
  useEffect(() => {
    if (!isConnected || !address || !driverProfile || walletSynced) return;

    // Check if wallet is already linked and matches
    if (driverProfile.walletAddress === address) {
      setWalletSynced(true);
      return;
    }

    // Auto-link the connected wallet
    linkDriverWallet(address).then(
      (res: { success: boolean; error?: string }) => {
        if (res.success) {
          console.log("Payout wallet linked:", address);
          setWalletSynced(true);
          // Update local profile state
          setDriverProfile((prev) =>
            prev ? { ...prev, walletAddress: address } : null,
          );
        } else {
          console.warn("Failed to link wallet:", res.error);
        }
      },
    );
  }, [isConnected, address, driverProfile, walletSynced]);

  // TanStack Query for driver stats
  const {
    data: stats,
    error: statsError,
    isLoading: statsLoading,
  } = useQuery<DriverStats>({
    queryKey: ["driver-stats"],
    queryFn: fetchDriverStats,
    staleTime: 60 * 1000, // 1 minute
    refetchInterval: 60 * 1000, // Refresh every minute
    refetchOnWindowFocus: true,
    enabled: profileChecked && !!driverProfile,
  });

  // TanStack Query for pending orders - only fetch when online
  const {
    data: availableOrders,
    refetch: refetchOrders,
    error: ordersError,
    isLoading,
  } = useQuery<OrderIntent[]>({
    queryKey: ["pending-orders"],
    queryFn: fetchPendingOrders,
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: isOnline ? 30 * 1000 : false, // Refresh every 30 seconds when online
    refetchOnWindowFocus: true,
    enabled: isOnline,
  });

  // Ably real-time subscription
  useEffect(() => {
    if (!isOnline) return;

    let ably: Ably.Realtime | null = null;
    let channel: Ably.RealtimeChannel | null = null;

    const setupAbly = async () => {
      try {
        // Fetch token from auth endpoint
        const authRes = await fetch("/api/ably/auth");

        if (!authRes.ok) {
          const errorData = await authRes.json();
          throw new Error(errorData.error || "Auth failed");
        }

        const { tokenRequest, driverName, trustScore } = await authRes.json();

        // Initialize Ably with token auth
        ably = new Ably.Realtime({
          authUrl: "/api/ably/auth",
          authMethod: "GET",
          authHeaders: {
            "Content-Type": "application/json",
          },
          // Use token request directly
          authCallback: async (tokenParams: any, callback: any) => {
            try {
              const res = await fetch("/api/ably/auth");
              const data = await res.json();
              callback(null, data.tokenRequest);
            } catch (err) {
              callback(err);
            }
          },
        });

        channel = ably.channels.get("nervous-system:updates");

        // Listen for new delivery intents
        const deliveryIntentListener = (msg: Ably.InboundMessage) => {
          const data = msg.data as DeliveryIntentPayload;
          console.log("[Ably] New intent created:", data);

          // Optimistic update: invalidate queries to refetch
          queryClient.invalidateQueries({ queryKey: ["pending-orders"] });
        };
        channel.subscribe("delivery.intent_created", deliveryIntentListener);
        (channel as any)._deliveryIntentListener = deliveryIntentListener;

        // Listen for orders matched (taken by self or others)
        const orderMatchedListener = (msg: Ably.InboundMessage) => {
          const data = msg.data as OrderMatchedPayload;
          console.log("[Ably] Order matched:", data);

          // Invalidate queries to refetch
          queryClient.invalidateQueries({ queryKey: ["pending-orders"] });
        };
        channel.subscribe("order.matched", orderMatchedListener);
        (channel as any)._orderMatchedListener = orderMatchedListener;

        // Connection state monitoring
        ably.connection.on("connected", () => {
          console.log("[Ably] Connected to real-time updates");
          setAblyError(null);
        });

        ably.connection.on("failed", (stateChange) => {
          console.error("[Ably] Connection failed:", stateChange.reason);
          setAblyError("Connection lost - reconnecting...");
        });
      } catch (error) {
        console.error("[Ably] Setup error:", error);
        setAblyError(
          error instanceof Error ? error.message : "Failed to connect",
        );
      }
    };

    setupAbly();

    // Cleanup on unmount or when going offline
    return () => {
      if (channel) {
        try {
          if ((channel as any)._deliveryIntentListener) {
            channel.unsubscribe(
              "delivery.intent_created",
              (channel as any)._deliveryIntentListener,
            );
          }
          if ((channel as any)._orderMatchedListener) {
            channel.unsubscribe(
              "order.matched",
              (channel as any)._orderMatchedListener,
            );
          }
        } catch (e) {}
      }
      if (ably) {
        ably.close();
      }
    };
  }, [isOnline, queryClient]);

  const handleAccept = useCallback(
    async (id: string) => {
      if (confirmingId === id) {
        // Final acceptance
        try {
          // Optimistic update: invalidate immediately
          queryClient.invalidateQueries({ queryKey: ["pending-orders"] });
          setConfirmingId(null);

          const result = await acceptDelivery(id);

          if (!result.success) {
            await handleApiError(result.error || "Failed to accept order");
            // Refetch to restore state
            refetchOrders();
          }
        } catch (error) {
          await handleApiError(error, "Failed to accept order");
          refetchOrders();
        }
      } else {
        // First click - require confirmation
        setConfirmingId(id);
      }
    },
    [confirmingId, queryClient, refetchOrders, handleApiError],
  );

  const handleGoOnline = useCallback(async () => {
    if (!driverProfile) {
      // No profile - user needs to register first
      return;
    }

    const newState = !isOnline;
    setIsOnline(newState);

    if (newState) {
      // Could trigger haptic feedback or sound here
      console.log("Driver went online");
    }
  }, [isOnline, driverProfile]);

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6">
      <header className="mb-8 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <Truck className="text-emerald-400" size={32} />
          <div>
            <h1 className="text-2xl font-bold">Driver Core</h1>
            <p className="text-slate-400 text-xs uppercase tracking-widest">
              Payouts:{" "}
              {driverProfile?.walletAddress ? (
                <span className="text-emerald-400">Linked</span>
              ) : isConnected ? (
                <span className="text-amber-400">Connecting...</span>
              ) : (
                <span className="text-slate-500">Not Configured</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {driverProfile && (
            <div className="text-right hidden md:block">
              <div className="flex items-center gap-1 justify-end text-emerald-400">
                <Star size={14} fill="currentColor" />
                <span className="font-bold">{driverProfile.trustScore}</span>
              </div>
              <p className="text-slate-500 text-xs">Trust Score</p>
            </div>
          )}

          <ConnectWallet />

          <button
            onClick={handleGoOnline}
            disabled={!profileChecked || !driverProfile}
            className={`px-6 py-2 rounded-full font-bold transition-all ${
              isOnline
                ? "bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]"
                : !driverProfile
                  ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                  : "bg-slate-700 text-slate-400"
            }`}
          >
            {!profileChecked
              ? "Loading..."
              : !driverProfile
                ? "Register First"
                : isOnline
                  ? "ONLINE"
                  : "GO ONLINE"}
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
              You need to register as a driver before you can start accepting
              deliveries.
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
                  <p className="text-slate-400 text-sm">
                    Today&apos;s Earnings
                  </p>
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
                    <h2 className="text-3xl font-bold">
                      ${stats?.todayEarnings.toFixed(2) ?? "0.00"}
                    </h2>
                    <p className="text-emerald-400 text-xs mt-2">
                      ↑ 12% from yesterday
                    </p>
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
                    <h2 className="text-3xl font-bold">
                      {stats?.deliveriesCount ?? 0}
                    </h2>
                    <p className="text-slate-500 text-xs mt-2">
                      Avg. {stats?.avgTimePerDelivery ?? 0} mins / delivery
                    </p>
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
                  <Navigation
                    size={48}
                    className="mx-auto mb-4 text-slate-600 animate-pulse"
                  />
                  <p className="text-slate-400">
                    Go online to start receiving delivery intents
                  </p>
                </div>
              ) : isLoading ? (
                <div className="bg-slate-800/50 border border-slate-700 border-dashed rounded-3xl py-20 text-center">
                  <Package
                    size={48}
                    className="mx-auto mb-4 text-slate-600 animate-spin"
                  />
                  <p className="text-slate-400">Loading available orders...</p>
                </div>
              ) : ordersError ? (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-6 py-8 rounded-2xl text-center">
                  <p className="font-bold">Failed to load orders</p>
                  <p className="text-sm mt-1">
                    {(ordersError as Error).message}
                  </p>
                </div>
              ) : !availableOrders || availableOrders.length === 0 ? (
                <div className="bg-slate-800/50 border border-slate-700 border-dashed rounded-3xl py-20 text-center">
                  <Package size={48} className="mx-auto mb-4 text-slate-600" />
                  <p className="text-slate-400">No pending orders available</p>
                  <p className="text-slate-500 text-sm mt-2">
                    New orders will appear here in real-time
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {availableOrders.map((order: OrderIntent) => {
                    const orderId = order.id || order.orderId;
                    const displayId =
                      orderId?.slice(0, 8).toUpperCase() || "UNKNOWN";

                    return (
                      <div
                        key={orderId}
                        className={`bg-slate-800 p-5 rounded-2xl border transition-all hover:scale-[1.02] cursor-pointer ${
                          order.priority === "urgent"
                            ? "border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.1)]"
                            : "border-slate-700"
                        }`}
                      >
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-xs font-mono text-slate-500">
                            {displayId}
                          </span>
                          <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded-full border border-emerald-500/20">
                            Bid for Priority
                          </span>
                        </div>
                        <div className="flex justify-between items-end mb-4">
                          <div>
                            <p className="text-[10px] text-slate-500 uppercase font-bold">
                              Base: ${(order.subtotal || 0).toFixed(2)}
                            </p>
                            <p className="text-xl font-bold text-emerald-400">
                              Tip: ${(order.tip || 0).toFixed(2)}
                            </p>
                          </div>
                          <div className="text-right">
                            <span className="text-sm text-slate-400">
                              Total Payout:
                            </span>
                            <h2 className="text-3xl font-black text-white">
                              ${(order.total || 0).toFixed(2)}
                            </h2>
                          </div>
                        </div>

                        {order.items && order.items.length > 0 && (
                          <div className="mb-4 p-3 bg-slate-900/50 rounded-xl border border-slate-700/50">
                            <p className="text-[10px] text-slate-500 uppercase mb-2">
                              Items
                            </p>
                            <div className="space-y-1">
                              {order.items.slice(0, 3).map((item, idx) => (
                                <div
                                  key={idx}
                                  className="flex justify-between text-xs"
                                >
                                  <span className="text-slate-300">
                                    {item.name} ×{item.quantity}
                                  </span>
                                  <span className="text-slate-500">
                                    ${item.price.toFixed(2)}
                                  </span>
                                </div>
                              ))}
                              {order.items.length > 3 && (
                                <p className="text-xs text-slate-500">
                                  +{order.items.length - 3} more items
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        <div className="space-y-4 mb-6">
                          <div className="flex items-start gap-3">
                            <div className="w-2 h-2 rounded-full bg-slate-500 mt-1.5 shrink-0" />
                            <div className="flex-1">
                              <p className="text-xs text-slate-500 uppercase">
                                Pickup
                              </p>
                              <p className="text-sm font-medium truncate">
                                {order.pickupAddress}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-2 h-2 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                            <div className="flex-1">
                              <p className="text-xs text-slate-500 uppercase">
                                Delivery
                              </p>
                              <p className="text-sm font-medium truncate">
                                {order.deliveryAddress}
                              </p>
                            </div>
                          </div>
                        </div>

                        {order.priority && (
                          <div className="mb-4">
                            <span
                              className={`text-[10px] uppercase font-bold px-2 py-1 rounded-full ${
                                order.priority === "urgent"
                                  ? "bg-red-500/20 text-red-400 border border-red-500/30"
                                  : order.priority === "express"
                                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                    : "bg-slate-700 text-slate-400"
                              }`}
                            >
                              {order.priority}
                            </span>
                          </div>
                        )}

                        <button
                          onClick={() => handleAccept(orderId)}
                          className={`w-full py-3 rounded-xl font-bold transition-all ${
                            confirmingId === orderId
                              ? "bg-emerald-500 text-white animate-pulse"
                              : "bg-white text-slate-900 hover:bg-emerald-400"
                          }`}
                        >
                          {confirmingId === orderId
                            ? "CONFIRM ACCEPTANCE"
                            : "ACCEPT INTENT"}
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
