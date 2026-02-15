"use server";

import { db } from "@repo/database";
import { restaurants, restaurantReservations, restaurantWaitlist } from "@repo/database";
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
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(data.restaurantId) || !uuidRegex.test(data.tableId)) {
    throw new Error("Invalid restaurant or table ID");
  }

  const [reservation] = await db.insert(restaurantReservations).values({
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

export async function cancelReservation(reservationId: string) {
  const [reservation] = await db.update(restaurantReservations)
    .set({ status: 'cancelled' })
    .where(eq(restaurantReservations.id, reservationId))
    .returning();

  if (reservation) {
    // Real-time update via Ably
    if (process.env.ABLY_API_KEY) {
      const ably = new Ably.Rest(process.env.ABLY_API_KEY);
      const channel = ably.channels.get(`restaurant:${reservation.restaurantId}`);
      await channel.publish('RESERVATION_CANCELLED', {
        id: reservation.id,
      });
    }

    revalidatePath(`/dashboard/${reservation.restaurantId}`);
    revalidatePath(`/book/manage/${reservationId}`);
  }
  return reservation;
}

export async function addToWaitlist(data: {
  restaurantId: string;
  guestName: string;
  guestEmail: string;
  partySize: number;
}) {
  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.id, data.restaurantId),
  });

  if (!restaurant) throw new Error("Restaurant not found");

  const [entry] = await db.insert(restaurantWaitlist).values({
    restaurantId: data.restaurantId,
    guestName: data.guestName,
    guestEmail: data.guestEmail,
    partySize: data.partySize,
    status: 'waiting',
  }).returning();

  if (entry && process.env.ABLY_API_KEY) {
    const ably = new Ably.Rest(process.env.ABLY_API_KEY);
    const channel = ably.channels.get(`restaurant:${data.restaurantId}`);
    await channel.publish('restaurantWaitlist-updated', {
      id: entry.id,
      guestName: entry.guestName,
      partySize: entry.partySize,
      status: entry.status,
    });
  }

  revalidatePath(`/dashboard/${data.restaurantId}`);
  return entry;
}
