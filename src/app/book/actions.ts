"use server";

import { db } from "@/db";
import { restaurants, reservations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NotifyService } from "@/lib/notify";
import Ably from "ably";

export async function createReservation(data: {
  restaurantId: string;
  tableId: string;
  guestName: string;
  guestEmail: string;
  partySize: number;
  startTime: string;
  endTime: string;
}) {
  const [reservation] = await db.insert(reservations).values({
    restaurantId: data.restaurantId,
    tableId: data.tableId,
    guestName: data.guestName,
    guestEmail: data.guestEmail,
    partySize: data.partySize,
    startTime: new Date(data.startTime),
    endTime: new Date(data.endTime),
    status: 'confirmed',
    isVerified: true, // Auto-verify for this demo
  }).returning();

  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.id, data.restaurantId),
  });

  if (restaurant) {
    // Notify via email
    await NotifyService.notifyOwner(restaurant.ownerEmail, {
      guestName: data.guestName,
      partySize: data.partySize,
      startTime: new Date(data.startTime),
    });

    // Real-time update via Ably
    if (process.env.ABLY_API_KEY) {
      const ably = new Ably.Rest(process.env.ABLY_API_KEY);
      const channel = ably.channels.get(`restaurant:${restaurant.id}`);
      await channel.publish('NEW_RESERVATION', {
        id: reservation.id,
        guestName: reservation.guestName,
        partySize: reservation.partySize,
        startTime: reservation.startTime,
        tableId: reservation.tableId,
      });
    }
  }

  revalidatePath(`/dashboard/${data.restaurantId}`);
  return reservation;
}
