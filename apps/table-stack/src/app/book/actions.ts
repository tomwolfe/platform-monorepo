"use server";

import { getDb, restaurants, restaurantReservations, restaurantWaitlist, eq } from "@repo/database";
import { revalidatePath } from "next/cache";
import { NotifyService } from "@tablestack/lib/notifications";
import { withServerActionHandler } from "@repo/shared";

export const createReservation = withServerActionHandler(
  async (data: {
  restaurantId: string;
  tableId: string;
  guestName: string;
  guestEmail: string;
  partySize: number;
  startTime: string;
  endTime: string;
  depositAmount?: number;
  paymentTxHash?: string;
}) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuidRegex.test(data.restaurantId) || !uuidRegex.test(data.tableId)) {
    throw new Error("Invalid restaurant or table ID");
  }

  // If deposit is required, mark as pending until payment is verified
  const requiresDeposit = data.depositAmount && data.depositAmount > 0;
  const isVerified = !requiresDeposit || !!data.paymentTxHash;

  const [reservation] = await getDb().insert(restaurantReservations).values({
    restaurantId: data.restaurantId,
    tableId: data.tableId,
    guestName: data.guestName,
    guestEmail: data.guestEmail,
    partySize: data.partySize,
    startTime: new Date(data.startTime),
    endTime: new Date(data.endTime),
    status: 'confirmed',
    isVerified: isVerified,
    depositAmount: data.depositAmount || 0,
    paymentTxHash: data.paymentTxHash,
  }).returning();

  const restaurant = await getDb().query.restaurants.findFirst({
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
    await NotifyService.broadcast(restaurant.id, 'reservation.created', {
      id: reservation.id,
      guestName: reservation.guestName,
      partySize: reservation.partySize,
      startTime: reservation.startTime,
      tableId: reservation.tableId,
    });
  }

  revalidatePath(`/dashboard/${data.restaurantId}`);
  return reservation;
}, { errorCode: 'CREATE_RESERVATION_FAILED' });

export const cancelReservation = withServerActionHandler(
  async (reservationId: string) => {
  const [reservation] = await getDb().update(restaurantReservations)
    .set({ status: 'cancelled' })
    .where(eq(restaurantReservations.id, reservationId))
    .returning();

  if (reservation) {
    // Real-time update via Ably
    await NotifyService.broadcast(reservation.restaurantId, 'RESERVATION_CANCELLED', {
      id: reservation.id,
    });

    revalidatePath(`/dashboard/${reservation.restaurantId}`);
    revalidatePath(`/book/manage/${reservationId}`);
  }
  return reservation;
}, { errorCode: 'CANCEL_RESERVATION_FAILED' });

export const addToWaitlist = withServerActionHandler(
  async (data: {
  restaurantId: string;
  guestName: string;
  guestEmail: string;
  partySize: number;
}) => {
  const restaurant = await getDb().query.restaurants.findFirst({
    where: eq(restaurants.id, data.restaurantId),
  });

  if (!restaurant) throw new Error("Restaurant not found");

  const [entry] = await getDb().insert(restaurantWaitlist).values({
    restaurantId: data.restaurantId,
    guestName: data.guestName,
    guestEmail: data.guestEmail,
    partySize: data.partySize,
    status: 'waiting',
  }).returning();

  if (entry) {
    await NotifyService.broadcast(data.restaurantId, 'restaurantWaitlist-updated', {
      id: entry.id,
      guestName: entry.guestName,
      partySize: entry.partySize,
      status: entry.status,
    });
  }

  revalidatePath(`/dashboard/${data.restaurantId}`);
  return entry;
}, { errorCode: 'ADD_TO_WAITLIST_FAILED' });
