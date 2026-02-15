"use client";

import React, { useState, useEffect } from "react";
import { format, addMinutes } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { Users, Clock, CheckCircle, ChevronRight, AlertCircle } from "lucide-react";
import { createReservation } from "../actions";
import Link from "next/link";
import ReservationForm from "@/components/ReservationForm";

interface Table {
  id: string;
  tableNumber: string;
  maxCapacity: number;
}

interface SuggestedSlot {
  time: string;
  availableTables: Table[];
}

interface AvailabilityResponse {
  availableTables: Table[];
  suggestedSlots?: SuggestedSlot[];
}

interface Restaurant {
  id: string;
  name: string;
  openingTime: string | null;
  closingTime: string | null;
  defaultDurationMinutes: number | null;
  timezone: string | null;
}

export default function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { slug } = React.use(params);

  useEffect(() => {
    fetch(`/api/v1/restaurant?slug=${slug}`)
      .then(res => {
        if (!res.ok) throw new Error("Restaurant not found");
        return res.json();
      })
      .then(data => {
        setRestaurant(data);
      })
      .catch(err => {
        setError(err.message);
        setRestaurant(null);
      });
  }, [slug]);

  const handleBook = async (data: { date: Date; partySize: number; time: string; guestInfo: { name: string; email: string } }) => {
    if (!restaurant) throw new Error("Restaurant not loaded");
    
    const timezone = restaurant.timezone || 'UTC';
    const datePart = format(data.date, 'yyyy-MM-dd');
    const checkTime = fromZonedTime(`${datePart} ${data.time}`, timezone);

    // 1. Check availability
    const availRes = await fetch(
      `/api/v1/availability?restaurantId=${restaurant.id}&date=${checkTime.toISOString()}&partySize=${data.partySize}`
    );
    
    if (!availRes.ok) {
      const errorData = await availRes.json();
      throw new Error(errorData.message || "No tables available for this time");
    }
    
    const availData = await availRes.json() as AvailabilityResponse;
    if (availData.availableTables.length === 0) {
      throw new Error("Fully booked for this time. Please try another slot.");
    }

    // 2. Create reservation
    const duration = restaurant.defaultDurationMinutes || 90;
    const res = await createReservation({
      restaurantId: restaurant.id,
      tableId: availData.availableTables[0].id,
      guestName: data.guestInfo.name,
      guestEmail: data.guestInfo.email,
      partySize: data.partySize,
      startTime: checkTime.toISOString(),
      endTime: addMinutes(checkTime, duration).toISOString(),
    });
    
    return res.id;
  };

  if (!restaurant) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        {error ? (
          <div className="text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-gray-900">Error</h1>
            <p className="text-gray-500">{error}</p>
          </div>
        ) : (
          "Loading restaurant..."
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-4xl mx-auto bg-white rounded-3xl shadow-xl overflow-hidden">
        <div className="bg-blue-600 p-10 text-white flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">{restaurant.name}</h1>
            <p className="text-blue-100">Intelligent Reservation Experience</p>
          </div>
          <div className="hidden md:block bg-blue-500/30 px-4 py-2 rounded-full border border-blue-400/30 text-sm font-medium">
            Open today until {restaurant.closingTime || "10:00 PM"}
          </div>
        </div>

        <div className="p-8 md:p-12">
           <ReservationForm restaurant={restaurant} onBook={handleBook} />
        </div>
      </div>
    </div>
  );
}
