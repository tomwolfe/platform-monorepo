'use client';

import React, { useState } from 'react';
import { format, addMinutes } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { DayPicker } from "react-day-picker";
import { Users, Clock, ChevronRight, AlertCircle, CheckCircle, User } from "lucide-react";
import "react-day-picker/dist/style.css";

interface Table {
  id: string;
  tableNumber: string;
  maxCapacity: number;
}

interface Restaurant {
  id: string;
  name: string;
  openingTime: string | null;
  closingTime: string | null;
  defaultDurationMinutes: number | null;
  timezone: string | null;
}

export default function ReservationForm({ 
  restaurant, 
  onBook 
}: { 
  restaurant: Restaurant;
  onBook: (data: any) => Promise<string>;
}) {
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [partySize, setPartySize] = useState(2);
  const [selectedHour, setSelectedHour] = useState(restaurant.openingTime || "19:00");
  const [guestInfo, setGuestInfo] = useState({ name: "", email: "" });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);

  const generateTimeSlots = () => {
    const slots = [];
    let current = restaurant.openingTime || "17:00";
    const end = restaurant.closingTime || "22:00";
    while (current <= end) {
      slots.push(current);
      const [h, m] = current.split(':').map(Number);
      let nextM = m + 30;
      let nextH = h;
      if (nextM >= 60) { nextH++; nextM -= 60; }
      current = `${nextH.toString().padStart(2, '0')}:${nextM.toString().padStart(2, '0')}`;
      if (current > end) break;
    }
    return slots;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!date || !guestInfo.name || !guestInfo.email) return;
    
    setIsLoading(true);
    setError(null);
    try {
      const id = await onBook({
        date,
        partySize,
        time: selectedHour,
        guestInfo
      });
      setSuccessId(id);
    } catch (err: any) {
      setError(err.message || "Failed to book");
    } finally {
      setIsLoading(false);
    }
  };

  if (successId) {
    return (
      <div className="text-center py-8 space-y-4">
        <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle className="text-green-600 w-10 h-10" />
        </div>
        <h2 className="text-2xl font-bold">Confirmed!</h2>
        <p className="text-gray-500">Your table at {restaurant.name} is reserved.</p>
        <button onClick={() => setSuccessId(null)} className="text-blue-600 font-medium">Make another booking</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {error && (
        <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex gap-3 text-red-800 text-sm">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-6">
          <div className="flex flex-col items-center border rounded-2xl p-4 bg-white shadow-sm">
            <DayPicker
              mode="single"
              selected={date}
              onSelect={setDate}
              className="m-0"
            />
          </div>

          <div className="space-y-4 p-6 bg-gray-50 rounded-2xl border border-gray-100">
             <h3 className="flex items-center gap-2 font-bold text-gray-900"><User className="w-4 h-4" /> Guest Details</h3>
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wider">Name</label>
                <input
                  required
                  value={guestInfo.name}
                  onChange={e => setGuestInfo({ ...guestInfo, name: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition"
                  placeholder="John Doe"
                />
             </div>
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wider">Email</label>
                <input
                  required
                  type="email"
                  value={guestInfo.email}
                  onChange={e => setGuestInfo({ ...guestInfo, email: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition"
                  placeholder="john@example.com"
                />
             </div>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <label className="flex items-center gap-2 text-sm font-bold text-gray-900 mb-3">
              <Users className="w-4 h-4" /> Party Size
            </label>
            <div className="grid grid-cols-6 gap-2">
              {[1, 2, 3, 4, 5, 6].map(size => (
                <button
                  type="button"
                  key={size}
                  onClick={() => setPartySize(size)}
                  className={`py-2 rounded-xl border-2 font-bold transition ${
                    partySize === size ? "bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-200" : "bg-white text-gray-700 hover:bg-gray-50 border-gray-100"
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-bold text-gray-900 mb-3">
              <Clock className="w-4 h-4" /> Select Time
            </label>
            <div className="grid grid-cols-4 gap-2">
              {generateTimeSlots().map(time => (
                <button
                  type="button"
                  key={time}
                  onClick={() => setSelectedHour(time)}
                  className={`py-2 rounded-xl border-2 text-sm font-bold transition ${
                    selectedHour === time ? "bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-200" : "bg-white text-gray-700 hover:bg-gray-50 border-gray-100"
                  }`}
                >
                  {time}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-4">
            <button
              disabled={isLoading}
              className="w-full bg-blue-600 text-white py-4 rounded-2xl font-bold hover:bg-blue-700 transition flex items-center justify-center gap-2 shadow-xl shadow-blue-100 disabled:opacity-50"
            >
              {isLoading ? "Processing..." : "Confirm Reservation"} <ChevronRight className="w-5 h-5" />
            </button>
            <p className="text-center text-xs text-gray-400 mt-4">By clicking confirm, you agree to the restaurant&apos;s terms of service.</p>
          </div>
        </div>
      </div>
    </form>
  );
}
