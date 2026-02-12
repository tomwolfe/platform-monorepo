"use client";

import React, { useState, useEffect } from "react";
import { format, addMinutes, startOfToday } from "date-fns";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { Users, Clock, CheckCircle, ChevronRight, AlertCircle } from "lucide-react";
import { createReservation } from "../actions";

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
}

export default function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [date, setDate] = useState<Date | undefined>(startOfToday());
  const [partySize, setPartySize] = useState(2);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState("19:00");
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState(1); // 1: Date/Size/Time, 2: Selection, 3: Details, 4: Success
  const [guestInfo, setGuestInfo] = useState({ name: "", email: "" });

  const { slug } = React.use(params);

  useEffect(() => {
    fetch(`/api/v1/restaurant?slug=${slug}`)
      .then(res => res.json())
      .then(data => {
        setRestaurant(data);
        if (data.openingTime) setSelectedHour(data.openingTime);
      });
  }, [slug]);

  const generateTimeSlots = () => {
    if (!restaurant) return [];
    const slots = [];
    let current = restaurant.openingTime || "17:00";
    const end = restaurant.closingTime || "22:00";
    
    while (current <= end) {
      slots.push(current);
      const [h, m] = current.split(':').map(Number);
      let nextM = m + 30;
      let nextH = h;
      if (nextM >= 60) {
        nextH++;
        nextM -= 60;
      }
      current = `${nextH.toString().padStart(2, '0')}:${nextM.toString().padStart(2, '0')}`;
      if (current > end) break;
    }
    return slots;
  };

  const checkAvailability = async (requestedDate?: Date) => {
    if (!restaurant || !date) return;
    setIsLoading(true);
    setError(null);
    
    const targetDate = requestedDate || date;
    const [h, m] = selectedHour.split(':').map(Number);
    const checkTime = new Date(targetDate);
    checkTime.setHours(h, m, 0, 0);

    try {
      const res = await fetch(
        `/api/v1/availability?restaurantId=${restaurant.id}&date=${checkTime.toISOString()}&partySize=${partySize}`
      );
      const data = await res.json();
      setAvailability(data);
      if (data.availableTables.length > 0) {
        setSelectedTime(checkTime.toISOString());
      }
      setStep(2);
    } catch {
      setError("Failed to fetch availability");
    } finally {
      setIsLoading(false);
    }
  };

  const handleBooking = async () => {
    if (!selectedTime || !availability?.availableTables[0]) return;
    setIsLoading(true);
    try {
      const duration = restaurant.defaultDurationMinutes || 90;
      await createReservation({
        restaurantId: restaurant.id,
        tableId: availability.availableTables[0].id,
        guestName: guestInfo.name,
        guestEmail: guestInfo.email,
        partySize,
        startTime: selectedTime,
        endTime: addMinutes(new Date(selectedTime), duration).toISOString(),
      });
      setStep(4);
    } catch {
      setError("Failed to create reservation");
    } finally {
      setIsLoading(false);
    }
  };

  if (!restaurant) return <div className="min-h-screen flex items-center justify-center">Loading restaurant...</div>;

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="bg-blue-600 p-8 text-white">
          <h1 className="text-2xl font-bold">{restaurant.name}</h1>
          <p className="text-blue-100">Book your table in seconds</p>
        </div>

        <div className="p-6">
          {step === 1 && (
            <div className="space-y-6">
              <div className="flex flex-col items-center">
                <DayPicker
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  disabled={{ before: new Date() }}
                  className="border rounded-lg p-3 bg-white shadow-sm"
                />
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                  <Users className="w-4 h-4" /> Party Size
                </label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5, 6].map(size => (
                    <button
                      key={size}
                      onClick={() => setPartySize(size)}
                      className={`flex-1 py-2 rounded-lg border font-medium transition ${
                        partySize === size ? "bg-blue-600 border-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                  <Clock className="w-4 h-4" /> Preferred Time
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {generateTimeSlots().map(time => (
                    <button
                      key={time}
                      onClick={() => setSelectedHour(time)}
                      className={`py-2 rounded-lg border text-sm font-medium transition ${
                        selectedHour === time ? "bg-blue-600 border-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {time}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={() => checkAvailability()}
                disabled={!date || isLoading}
                className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition flex items-center justify-center gap-2"
              >
                {isLoading ? "Checking..." : "Check Availability"} <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Select Time</h2>
                <button onClick={() => setStep(1)} className="text-blue-600 text-sm font-medium">Change Date</button>
              </div>

              {availability?.availableTables.length === 0 ? (
                <div className="space-y-4">
                  <div className="p-4 bg-orange-50 border border-orange-100 rounded-xl flex gap-3">
                    <AlertCircle className="text-orange-600 w-5 h-5 shrink-0" />
                    <p className="text-sm text-orange-800">Fully booked for your selected time. Try one of these alternatives:</p>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3">
                    {availability.suggestedSlots?.map((slot) => (
                      <button
                        key={slot.time}
                        onClick={() => {
                          setSelectedTime(slot.time);
                          setAvailability({ ...availability, availableTables: slot.availableTables });
                        }}
                        className={`p-3 rounded-xl border font-medium text-center transition ${
                          selectedTime === slot.time ? "bg-blue-600 border-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        {format(new Date(slot.time), "h:mm aa")}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4 py-4">
                   <div className="bg-green-50 text-green-700 px-6 py-4 rounded-2xl border border-green-100 text-center w-full">
                      <p className="text-sm font-medium mb-1">Available at</p>
                      <p className="text-3xl font-bold">{selectedTime ? format(new Date(selectedTime), "h:mm aa") : selectedHour}</p>
                    </div>
                </div>
              )}

              <button
                disabled={!selectedTime}
                onClick={() => setStep(3)}
                className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <h2 className="text-lg font-bold">Your Details</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                  <input
                    value={guestInfo.name}
                    onChange={e => setGuestInfo({ ...guestInfo, name: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="John Doe"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
                  <input
                    type="email"
                    value={guestInfo.email}
                    onChange={e => setGuestInfo({ ...guestInfo, email: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="john@example.com"
                  />
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-xl space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Date</span>
                  <span className="font-medium">{date ? format(date, "PPP") : ""}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Time</span>
                  <span className="font-medium">{selectedTime ? format(new Date(selectedTime), "h:mm aa") : ""}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Party Size</span>
                  <span className="font-medium">{partySize} people</span>
                </div>
              </div>

              <button
                disabled={!guestInfo.name || !guestInfo.email || isLoading}
                onClick={handleBooking}
                className="w-full bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isLoading ? "Confirming..." : "Confirm Reservation"}
              </button>
            </div>
          )}

          {step === 4 && (
            <div className="text-center py-12 space-y-4">
              <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle className="text-green-600 w-10 h-10" />
              </div>
              <h2 className="text-2xl font-bold">See you soon!</h2>
              <p className="text-gray-500">Your reservation has been confirmed. We&apos;ve sent an email to {guestInfo.email}.</p>
              <button
                onClick={() => setStep(1)}
                className="text-blue-600 font-semibold"
              >
                Make another booking
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
