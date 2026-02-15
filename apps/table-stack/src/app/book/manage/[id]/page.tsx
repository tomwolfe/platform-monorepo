import { db } from "@/db";
import { reservations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Calendar, Clock, Users, MapPin, XCircle, CheckCircle } from "lucide-react";
import { cancelReservation } from "../../actions";
import Link from "next/link";

export default async function ManageBookingPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const reservationId = params.id;

  const reservation = await db.query.reservations.findFirst({
    where: eq(reservations.id, reservationId),
    with: {
      restaurant: true,
      table: true,
    },
  });

  if (!reservation) {
    notFound();
  }

  const isCancelled = reservation.status === 'cancelled';

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className={`p-8 text-white ${isCancelled ? 'bg-gray-600' : 'bg-blue-600'}`}>
          <h1 className="text-2xl font-bold">Your Reservation</h1>
          <p className={isCancelled ? 'text-gray-300' : 'text-blue-100'}>
            {reservation.restaurant.name}
          </p>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
            {isCancelled ? (
              <XCircle className="w-12 h-12 text-red-500" />
            ) : (
              <CheckCircle className="w-12 h-12 text-green-500" />
            )}
            <div>
              <p className="font-bold text-lg">{isCancelled ? 'Cancelled' : 'Confirmed'}</p>
              <p className="text-sm text-gray-500">
                {isCancelled ? 'This reservation is no longer active.' : 'We look forward to seeing you!'}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3 text-gray-700">
              <Calendar className="w-5 h-5 text-blue-600" />
              <span>{format(new Date(reservation.startTime), "EEEE, MMMM do, yyyy")}</span>
            </div>
            <div className="flex items-center gap-3 text-gray-700">
              <Clock className="w-5 h-5 text-blue-600" />
              <span>{format(new Date(reservation.startTime), "h:mm aa")}</span>
            </div>
            <div className="flex items-center gap-3 text-gray-700">
              <Users className="w-5 h-5 text-blue-600" />
              <span>Party of {reservation.partySize}</span>
            </div>
            <div className="flex items-center gap-3 text-gray-700">
              <MapPin className="w-5 h-5 text-blue-600" />
              <span>Table #{reservation.table?.tableNumber || 'Assigned on arrival'}</span>
            </div>
          </div>

          {!isCancelled && (
            <form action={async () => {
              'use server';
              await cancelReservation(reservationId);
            }}>
              <button
                type="submit"
                className="w-full py-3 rounded-xl border-2 border-red-100 text-red-600 font-bold hover:bg-red-50 transition flex items-center justify-center gap-2"
              >
                <XCircle className="w-5 h-5" /> Cancel Reservation
              </button>
            </form>
          )}

          <div className="pt-6 border-t border-gray-100">
            <Link 
              href={`/book/${reservation.restaurant.slug}`}
              className="text-blue-600 font-medium hover:underline block text-center"
            >
              Back to {reservation.restaurant.name}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
