"use client";

import React, { useState, useEffect } from 'react';
import { Truck, MapPin, DollarSign, Star, Bell, Navigation } from 'lucide-react';

export default function DriverDashboard() {
  const [isOnline, setIsOnline] = useState(false);
  const [trustScore, setTrustScore] = useState(94);
  const [availableOrders, setAvailableOrders] = useState([
    { id: 'ORD-123', pickup: 'Green Garden', delivery: '123 Tech Lane', payout: 8.50, distance: '1.2km' },
    { id: 'ORD-124', pickup: 'Burger Barn', delivery: '456 Oak St', payout: 12.00, distance: '3.5km', priority: true },
  ]);

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
          <div className="text-right hidden md:block">
            <div className="flex items-center gap-1 justify-end text-emerald-400">
              <Star size={14} fill="currentColor" />
              <span className="font-bold">{trustScore}</span>
            </div>
            <p className="text-slate-500 text-xs">Trust Score</p>
          </div>
          
          <button 
            onClick={() => setIsOnline(!isOnline)}
            className={`px-6 py-2 rounded-full font-bold transition-all ${
              isOnline 
                ? 'bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]' 
                : 'bg-slate-700 text-slate-400'
            }`}
          >
            {isOnline ? 'ONLINE' : 'GO ONLINE'}
          </button>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Stats Grid */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700">
            <div className="flex justify-between items-start mb-4">
              <p className="text-slate-400 text-sm">Today's Earnings</p>
              <DollarSign className="text-emerald-400" size={20} />
            </div>
            <h2 className="text-3xl font-bold">$142.50</h2>
            <p className="text-emerald-400 text-xs mt-2">↑ 12% from yesterday</p>
          </div>

          <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700">
            <div className="flex justify-between items-start mb-4">
              <p className="text-slate-400 text-sm">Deliveries</p>
              <Truck className="text-blue-400" size={20} />
            </div>
            <h2 className="text-3xl font-bold">18</h2>
            <p className="text-slate-500 text-xs mt-2">Avg. 14 mins / delivery</p>
          </div>
        </div>

        {/* Available Intents */}
        <div className="lg:col-span-3 space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Bell size={20} className="text-emerald-400" />
              Available Delivery Intents
            </h2>
            {trustScore > 90 && (
              <span className="text-xs bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full border border-emerald-500/20">
                Priority Access Enabled
              </span>
            )}
          </div>

          {!isOnline ? (
            <div className="bg-slate-800/50 border border-slate-700 border-dashed rounded-3xl py-20 text-center">
              <Navigation size={48} className="mx-auto mb-4 text-slate-600 animate-pulse" />
              <p className="text-slate-400">Go online to start receiving delivery intents</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {availableOrders.map(order => (
                <div key={order.id} className={`bg-slate-800 p-5 rounded-2xl border transition-all hover:scale-[1.02] cursor-pointer ${
                  order.priority ? 'border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-slate-700'
                }`}>
                  <div className="flex justify-between items-start mb-4">
                    <span className="text-xs font-mono text-slate-500">{order.id}</span>
                    <span className="text-xl font-bold text-emerald-400">${order.payout.toFixed(2)}</span>
                  </div>
                  
                  <div className="space-y-4 mb-6">
                    <div className="flex items-start gap-3">
                      <div className="w-2 h-2 rounded-full bg-slate-500 mt-1.5 shrink-0" />
                      <div>
                        <p className="text-xs text-slate-500 uppercase">Pickup</p>
                        <p className="text-sm font-medium">{order.pickup}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="w-2 h-2 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                      <div>
                        <p className="text-xs text-slate-500 uppercase">Delivery</p>
                        <p className="text-sm font-medium">{order.delivery}</p>
                      </div>
                    </div>
                  </div>

                  <button className="w-full bg-white text-slate-900 py-3 rounded-xl font-bold hover:bg-emerald-400 transition-colors">
                    Accept Intent
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
