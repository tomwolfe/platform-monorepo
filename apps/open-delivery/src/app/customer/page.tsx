"use client";
import React, { useState, useEffect, useCallback } from "react";
import Ably from "ably";
import {
  ShoppingCart,
  MapPin,
  Clock,
  CheckCircle,
  Package,
  Utensils,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { getRealVendors, placeRealOrder, Vendor } from "./actions";
import { useUser } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

interface OrderStatus {
  orderId: string;
  status:
    | "pending"
    | "matched"
    | "preparing"
    | "transit"
    | "delivered"
    | "cancelled";
  vendor: string;
  total: number;
  events: Array<{ timestamp: string; event: string }>;
}

export default function CustomerDashboard() {
  const { isLoaded, isSignedIn } = useUser();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [activeOrder, setActiveOrder] = useState<OrderStatus | null>(null);
  const [isLoadingVendors, setIsLoadingVendors] = useState(true);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadVendors = async () => {
      try {
        const data = await getRealVendors();
        setVendors(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load vendors"
        );
      } finally {
        setIsLoadingVendors(false);
      }
    };
    loadVendors();
  }, []);

  useEffect(() => {
    if (!activeOrder) return;
    let ably: Ably.Realtime | null = null;
    let channel: Ably.RealtimeChannel | null = null;

    const setupAbly = async () => {
      try {
        ably = new Ably.Realtime({ authUrl: "/api/ably/auth" });
        channel = ably.channels.get("nervous-system:updates");

        channel.subscribe("order.matched", (msg) => {
          if (msg.data.orderId === activeOrder.orderId) {
            setActiveOrder((prev) =>
              prev
                ? {
                    ...prev,
                    status: "matched",
                    events: [
                      ...prev.events,
                      {
                        timestamp: new Date().toISOString(),
                        event: "driver_matched",
                      },
                    ],
                  }
                : null
            );
          }
        });
      } catch (e) {
        console.error("Ably connection failed", e);
      }
    };
    setupAbly();
    return () => {
      ably?.close();
    };
  }, [activeOrder?.orderId]);

  const handleOrderNow = useCallback(
    async (vendor: Vendor) => {
      if (!isSignedIn) {
        setError("Please sign in to place an order.");
        return;
      }

      setIsPlacingOrder(true);
      setError(null);
      const MOCK_TOTAL = 24.99;

      try {
        const result = await placeRealOrder(vendor.id, MOCK_TOTAL);

        setActiveOrder({
          orderId: result.orderId,
          status: "pending",
          vendor: vendor.name,
          total: MOCK_TOTAL,
          events: [{ timestamp: new Date().toISOString(), event: "order_created" }],
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Order failed");
      } finally {
        setIsPlacingOrder(false);
      }
    },
    [isSignedIn]
  );

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin h-8 w-8 text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <header className="mb-8 flex justify-between items-center max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Package className="text-blue-600" /> OpenDeliver
        </h1>
        <div className="bg-white px-4 py-2 rounded-full shadow-sm flex items-center gap-2">
          <MapPin size={18} className="text-red-500" />
          <span className="text-sm font-medium">San Francisco, CA</span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-xl font-semibold mb-4">Nearby Vendors</h2>

          {isLoadingVendors ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-500">
              <Loader2 className="animate-spin h-10 w-10 mb-4" />
              <p>Loading real restaurants from TableStack...</p>
            </div>
          ) : error && vendors.length === 0 ? (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl">
              {error}
            </div>
          ) : vendors.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-xl border border-dashed">
              <Utensils className="mx-auto h-12 w-12 text-gray-300 mb-4" />
              <p className="text-gray-500">No restaurants found.</p>
              <p className="text-sm text-gray-400 mt-2">
                Run <code>pnpm --filter @repo/table-stack db:seed</code> to add
                demo data.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {vendors.map((vendor) => (
                <div
                  key={vendor.id}
                  onClick={() => handleOrderNow(vendor)}
                  className={`bg-white p-5 rounded-xl border transition-all cursor-pointer relative overflow-hidden group ${
                    isPlacingOrder
                      ? "opacity-50 pointer-events-none"
                      : "hover:shadow-lg hover:border-blue-200"
                  }`}
                >
                  <div className="flex justify-between items-start mb-3">
                    <span className="text-4xl">{vendor.image}</span>
                    <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-1 rounded-full">
                      Open Now
                    </span>
                  </div>
                  <h3 className="font-bold text-lg text-gray-900">
                    {vendor.name}
                  </h3>
                  <p className="text-gray-500 text-sm mb-1">
                    {vendor.category} • ⭐ {vendor.rating}
                  </p>
                  <p className="text-xs text-gray-400 truncate">
                    {vendor.address}
                  </p>

                  <button
                    disabled={isPlacingOrder || !isSignedIn}
                    className="mt-4 w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isPlacingOrder ? (
                      <>
                        Processing{" "}
                        <Loader2 className="animate-spin h-4 w-4" />
                      </>
                    ) : !isSignedIn ? (
                      "Sign In to Order"
                    ) : (
                      "Order Now"
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl shadow-lg border border-blue-50 sticky top-6">
            <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
              <ShoppingCart size={20} /> Active Order
            </h2>

            {!isSignedIn && !activeOrder && (
              <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-xl">
                <p className="mb-2">Please sign in to view orders</p>
              </div>
            )}

            {!activeOrder && isSignedIn && (
              <div className="text-center py-12 text-gray-400">
                <Package size={48} className="mx-auto mb-4 opacity-20" />
                <p>No active orders</p>
                <p className="text-xs mt-2">Select a vendor to start</p>
              </div>
            )}

            {activeOrder && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex items-center gap-4 pb-4 border-b">
                  <div
                    className={`p-3 rounded-full ${
                      activeOrder.status === "pending"
                        ? "bg-blue-100 text-blue-600"
                        : "bg-green-100 text-green-600"
                    }`}
                  >
                    {activeOrder.status === "pending" ? (
                      <Clock size={24} />
                    ) : (
                      <CheckCircle size={24} />
                    )}
                  </div>
                  <div>
                    <p className="font-bold text-gray-900">{activeOrder.vendor}</p>
                    <p className="text-sm text-gray-500 capitalize">
                      {activeOrder.status.replace("_", " ")}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Order ID</span>
                    <span className="font-mono text-xs">
                      {activeOrder.orderId.slice(0, 8)}...
                    </span>
                  </div>
                  <div className="flex justify-between text-sm font-bold">
                    <span>Total</span>
                    <span>${activeOrder.total.toFixed(2)}</span>
                  </div>
                </div>

                <div className="relative pl-4 border-l-2 border-gray-100 space-y-4">
                  {activeOrder.events.map((evt, idx) => (
                    <div key={idx} className="relative">
                      <div className="absolute -left-[21px] top-1 w-3 h-3 bg-blue-600 rounded-full border-2 border-white"></div>
                      <p className="text-xs text-gray-500">
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </p>
                      <p className="text-sm font-medium text-gray-800 capitalize">
                        {evt.event.replace("_", " ")}
                      </p>
                    </div>
                  ))}
                  {activeOrder.status === "pending" && (
                    <div className="relative">
                      <div className="absolute -left-[21px] top-1 w-3 h-3 bg-gray-300 rounded-full border-2 border-white animate-pulse"></div>
                      <p className="text-xs text-gray-400">
                        Waiting for driver...
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
