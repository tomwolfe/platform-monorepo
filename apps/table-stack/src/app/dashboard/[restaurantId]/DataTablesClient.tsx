'use client';

import { useState } from 'react';
import { Bell, UserCheck, Trash2 } from 'lucide-react';

interface WaitlistItem {
  id: string;
  guestName: string;
  partySize: number;
  status: 'waiting' | 'notified' | 'seated';
  createdAt: string;
}

interface ReservationItem {
  id: string;
  guestName: string;
  partySize: number;
  startTime: string;
  status: 'confirmed' | 'cancelled' | 'completed';
}

interface DataTablesClientProps {
  waitlist: WaitlistItem[];
  reservations: ReservationItem[];
  restaurantInternalId: string;
  updateWaitlistStatus: (waitlistId: string, restaurantId: string, status: 'waiting' | 'notified' | 'seated') => Promise<any>;
  deleteReservation: (id: string, restaurantId: string) => Promise<any>;
}

export function DataTablesClient({
  waitlist,
  reservations,
  restaurantInternalId,
  updateWaitlistStatus,
  deleteReservation,
}: DataTablesClientProps) {
  // Format dates using a fixed format to avoid hydration mismatch
  const formatDate = (date: Date | string) => {
    return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
  };

  return (
    <>
      <section className="mt-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-6 text-orange-600">Active Waitlist</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Guest</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Party</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Joined</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {waitlist.map((w: any) => (
                <tr key={w.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{w.guestName}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{w.partySize}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(w.createdAt!)}
                  </td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold capitalize ${
                    w.status === 'notified' ? 'text-blue-600' : 'text-orange-600'
                  }`}>
                    {w.status}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    {w.status === 'waiting' && (
                      <form action={async () => {
                        await updateWaitlistStatus(w.id, restaurantInternalId, 'notified');
                      }} className="inline">
                        <button type="submit" title="Notify Guest" className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                          <Bell className="w-4 h-4" />
                        </button>
                      </form>
                    )}
                    <form action={async () => {
                      await updateWaitlistStatus(w.id, restaurantInternalId, 'seated');
                    }} className="inline">
                      <button type="submit" title="Seat Guest" className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors">
                        <UserCheck className="w-4 h-4" />
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {waitlist.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-sm text-gray-500">Waitlist is currently empty.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-6">Recent Reservations</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Guest</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {reservations.map((res: any) => (
                <tr key={res.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{res.guestName}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{res.partySize}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(res.startTime)}
                  </td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold capitalize ${
                    res.status === 'confirmed' ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {res.status}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <form action={async () => {
                      await deleteReservation(res.id, restaurantInternalId);
                    }} className="inline">
                      <button type="submit" className="text-red-600 hover:text-red-900 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {reservations.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-sm text-gray-500">No reservations found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
