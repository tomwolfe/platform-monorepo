"use client";

import React, { useState } from 'react';
import { ShoppingCart, MapPin, Clock, CheckCircle, Package } from 'lucide-react';

export default function CustomerDashboard() {
  const [activeOrder, setActiveOrder] = useState<any>(null);

  const mockVendors = [
    { id: 1, name: "Green Garden", category: "Vegetarian", rating: 4.8, image: "🥗" },
    { id: 2, name: "Burger Barn", category: "Fast Food", rating: 4.2, image: "🍔" },
    { id: 3, name: "Sushi Star", category: "Japanese", rating: 4.9, image: "🍣" },
  ];

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
              <div key={vendor.id} className="bg-white p-4 rounded-xl shadow-sm hover:shadow-md transition-shadow cursor-pointer border border-gray-100">
                <div className="text-4xl mb-3">{vendor.image}</div>
                <h3 className="font-bold text-lg">{vendor.name}</h3>
                <p className="text-gray-500 text-sm">{vendor.category} • ⭐ {vendor.rating}</p>
                <button 
                  className="mt-4 w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors"
                  onClick={() => setActiveOrder({ vendor: vendor.name, status: 'quoting' })}
                >
                  Order Now
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
            
            {activeOrder ? (
              <div className="space-y-6">
                <div className="flex items-center gap-4">
                  <div className="bg-blue-100 p-3 rounded-full">
                    <Clock className="text-blue-600" />
                  </div>
                  <div>
                    <p className="font-bold">{activeOrder.vendor}</p>
                    <p className="text-sm text-gray-500">Estimated delivery: 25 mins</p>
                  </div>
                </div>

                <div className="relative pl-8 space-y-8 before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-0.5 before:bg-blue-100">
                  <div className="relative flex items-center gap-3">
                    <div className="absolute -left-8 bg-blue-600 w-6 h-6 rounded-full flex items-center justify-center border-4 border-white">
                      <CheckCircle size={12} className="text-white" />
                    </div>
                    <p className="text-sm font-medium">Order Confirmed</p>
                  </div>
                  <div className="relative flex items-center gap-3">
                    <div className="absolute -left-8 bg-blue-600 w-6 h-6 rounded-full flex items-center justify-center border-4 border-white">
                      <CheckCircle size={12} className="text-white" />
                    </div>
                    <p className="text-sm font-medium text-blue-600">Preparing your food</p>
                  </div>
                  <div className="relative flex items-center gap-3">
                    <div className="absolute -left-8 bg-gray-200 w-6 h-6 rounded-full border-4 border-white"></div>
                    <p className="text-sm font-medium text-gray-400">Driver picking up</p>
                  </div>
                </div>

                <div className="pt-6 border-t">
                  <div className="flex justify-between font-bold text-lg">
                    <span>Total</span>
                    <span>$12.50</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-400">
                <Package size={48} className="mx-auto mb-4 opacity-20" />
                <p>No active orders</p>
                <p className="text-xs mt-2">Find a vendor to start ordering</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
