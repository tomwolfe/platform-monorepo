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
  X,
  Menu,
  DollarSign,
} from "lucide-react";
import { getRealVendors, placeRealOrder, getMenu, Vendor, MenuItem } from "./actions";
import { useUser } from "@clerk/nextjs";
import { reverseGeocode } from "@repo/shared/utils/geo";

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

interface CartItem extends MenuItem {
  quantity: number;
}

export default function CustomerDashboard() {
  const { isLoaded, isSignedIn } = useUser();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [activeOrder, setActiveOrder] = useState<OrderStatus | null>(null);
  const [isLoadingVendors, setIsLoadingVendors] = useState(true);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [isLoadingMenu, setIsLoadingMenu] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [showMenuModal, setShowMenuModal] = useState(false);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [cityLabel, setCityLabel] = useState("Detecting location...");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [tip, setTip] = useState(5.0); // Default $5 tip

  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setLocation(coords);
          // Reverse geocode to get city name for UI
          try {
            const result = await reverseGeocode(coords.lat, coords.lng);
            if (result.success && result.result) {
              if (result.result.address?.city) {
                setCityLabel(result.result.address.city);
              } else {
                setCityLabel("Nearby");
              }
              // FIX: Set the actual delivery address for the order action
              if (result.result.displayName) {
                setDeliveryAddress(result.result.displayName);
              }
            } else {
              setCityLabel("Nearby");
            }
          } catch {
            setCityLabel("Nearby");
          }
        },
        () => {
          // No fallback to San Francisco - show empty state instead
          setCityLabel("Location needed");
          setLocation(null);
        }
      );
    } else {
      // Geolocation not available - show empty state
      setCityLabel("Location needed");
      setLocation(null);
    }
  }, []);

  useEffect(() => {
    const loadVendors = async () => {
      // Only fetch if we actually have coordinates
      if (!location?.lat || !location?.lng) return;

      try {
        const data = await getRealVendors(location.lat, location.lng);
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
  }, [location?.lat, location?.lng]);

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

  const handleViewMenu = useCallback(
    async (vendor: Vendor) => {
      if (!isSignedIn) {
        setError("Please sign in to view menu.");
        return;
      }
      setSelectedVendor(vendor);
      setIsLoadingMenu(true);
      setError(null);

      try {
        const items = await getMenu(vendor.id);
        setMenuItems(items);
        setCart([]);
        setShowMenuModal(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load menu");
      } finally {
        setIsLoadingMenu(false);
      }
    },
    [isSignedIn]
  );

  const handleAddToCart = useCallback((item: MenuItem) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === item.id);
      if (existing) {
        return prev.map((i) =>
          i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { ...item, quantity: 1 }];
    });
  }, []);

  const handleRemoveFromCart = useCallback((itemId: string) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === itemId);
      if (existing && existing.quantity > 1) {
        return prev.map((i) =>
          i.id === itemId ? { ...i, quantity: i.quantity - 1 } : i
        );
      }
      return prev.filter((i) => i.id !== itemId);
    });
  }, []);

  const handleCheckout = useCallback(async () => {
    if (!selectedVendor || cart.length === 0) return;

    setIsPlacingOrder(true);
    setError(null);

    try {
      const orderItems = cart.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
      }));
      const result = await placeRealOrder(selectedVendor.id, orderItems, deliveryAddress || undefined, tip);

      setActiveOrder({
        orderId: result.orderId,
        status: "pending",
        vendor: selectedVendor.name,
        total: cart.reduce((sum, item) => sum + item.price * item.quantity, 0) + tip,
        events: [{ timestamp: new Date().toISOString(), event: "order_created" }],
      });
      setShowMenuModal(false);
      setCart([]);
      setTip(5.0); // Reset tip for next order
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order failed");
    } finally {
      setIsPlacingOrder(false);
    }
  }, [selectedVendor, cart, deliveryAddress, tip]);

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
        const result = await placeRealOrder(vendor.id, [{
          id: "mock-item",
          name: `Chef's Special at ${vendor.name}`,
          price: MOCK_TOTAL,
          quantity: 1,
        }]);

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
          <span className="text-sm font-medium">
            {cityLabel}
          </span>
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
                  className={`bg-white p-5 rounded-xl border transition-all cursor-pointer relative overflow-hidden group ${
                    isPlacingOrder || isLoadingMenu
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
                    onClick={(e) => {
                      e.stopPropagation();
                      handleViewMenu(vendor);
                    }}
                    disabled={isPlacingOrder || isLoadingMenu || !isSignedIn}
                    className="mt-4 w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isLoadingMenu && selectedVendor?.id === vendor.id ? (
                      <>
                        Loading <Loader2 className="animate-spin h-4 w-4" />
                      </>
                    ) : !isSignedIn ? (
                      "Sign In to View Menu"
                    ) : (
                      <>
                        <Menu className="h-4 w-4" /> View Menu
                      </>
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

      {/* Menu Modal */}
      {showMenuModal && selectedVendor && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold">{selectedVendor.name}</h2>
                <p className="text-sm text-gray-500">Select items to add to your order</p>
              </div>
              <button
                onClick={() => {
                  setShowMenuModal(false);
                  setCart([]);
                }}
                className="p-2 hover:bg-gray-100 rounded-full transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
              {/* Menu Items */}
              <div className="flex-1 overflow-y-auto p-6">
                {isLoadingMenu ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="animate-spin h-8 w-8 text-blue-600" />
                  </div>
                ) : menuItems.length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    <Utensils className="h-12 w-12 mx-auto mb-4 opacity-20" />
                    <p>No menu items available</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {menuItems.map((item) => {
                      const inCart = cart.find((c) => c.id === item.id);
                      return (
                        <div
                          key={item.id}
                          className="flex justify-between items-center p-4 border rounded-xl hover:border-blue-300 transition-colors"
                        >
                          <div className="flex-1">
                            <h3 className="font-semibold text-gray-900">{item.name}</h3>
                            <p className="text-sm text-gray-500">{item.description || "No description"}</p>
                            <p className="text-blue-600 font-bold mt-1">${item.price.toFixed(2)}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {inCart ? (
                              <>
                                <button
                                  onClick={() => handleRemoveFromCart(item.id)}
                                  className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center font-bold transition-colors"
                                >
                                  -
                                </button>
                                <span className="w-8 text-center font-semibold">{inCart.quantity}</span>
                              </>
                            ) : null}
                            <button
                              onClick={() => handleAddToCart(item)}
                              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                            >
                              {inCart ? "Add More" : "Add to Cart"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Cart Sidebar */}
              <div className="lg:w-80 border-l bg-gray-50 p-6 overflow-y-auto">
                <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                  <ShoppingCart className="h-5 w-5" /> Your Order
                </h3>
                {cart.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Package className="h-12 w-12 mx-auto mb-4 opacity-20" />
                    <p className="text-sm">No items in cart</p>
                    <p className="text-xs mt-1">Add items from the menu</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {cart.map((item) => (
                      <div key={item.id} className="flex justify-between items-start">
                        <div className="flex-1">
                          <p className="font-medium text-sm">{item.name}</p>
                          <p className="text-xs text-gray-500">Qty: {item.quantity}</p>
                        </div>
                        <p className="font-semibold text-sm">
                          ${(item.price * item.quantity).toFixed(2)}
                        </p>
                      </div>
                    ))}
                    <div className="border-t pt-4 mt-4 space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Delivery Address
                        </label>
                        <input
                          type="text"
                          value={deliveryAddress}
                          onChange={(e) => setDeliveryAddress(e.target.value)}
                          placeholder="123 Main St, Apt 4B"
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <p className="text-[10px] text-gray-400 mt-1">
                          Leave empty to use current location
                        </p>
                      </div>

                      {/* Driver Tip Section - "Bid for Priority" */}
                      <div className="border-t pt-4 mt-4">
                        <div className="flex items-center gap-2 mb-3">
                          <DollarSign className="h-4 w-4 text-emerald-600" />
                          <label className="block text-sm font-bold text-gray-900">
                            Driver Tip (Bid for Priority)
                          </label>
                        </div>
                        <p className="text-xs text-gray-500 mb-3">
                          Higher tips attract drivers faster and prioritize your order
                        </p>
                        <div className="grid grid-cols-4 gap-2 mb-3">
                          {[0, 3, 5, 8].map((amount) => (
                            <button
                              key={amount}
                              onClick={() => setTip(amount)}
                              className={`py-2 rounded-lg font-semibold text-sm transition-all ${
                                tip === amount
                                  ? "bg-emerald-500 text-white shadow-md"
                                  : "bg-white border border-gray-300 text-gray-700 hover:border-emerald-400"
                              }`}
                            >
                              ${amount}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">$</span>
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={tip}
                            onChange={(e) => setTip(Math.max(0, parseFloat(e.target.value) || 0))}
                            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                          />
                        </div>
                      </div>

                      <div className="space-y-2 pt-4 border-t">
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Subtotal</span>
                          <span className="font-medium">
                            ${cart.reduce((sum, item) => sum + item.price * item.quantity, 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Driver Tip</span>
                          <span className="font-medium text-emerald-600">${tip.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between items-center pt-2">
                          <span className="font-bold text-gray-900">Total</span>
                          <span className="text-xl font-black text-blue-600">
                            ${(cart.reduce((sum, item) => sum + item.price * item.quantity, 0) + tip).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={handleCheckout}
                      disabled={isPlacingOrder || cart.length === 0}
                      className="w-full bg-blue-600 text-white py-3 rounded-lg font-bold hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {isPlacingOrder ? (
                        <>
                          Processing <Loader2 className="animate-spin h-4 w-4" />
                        </>
                      ) : (
                        "Place Order"
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
