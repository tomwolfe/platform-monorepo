import { z } from "zod";

export const GetAvailabilitySchema = z.object({
  restaurantId: z.string().describe("The internal ID of the restaurant."),
  date: z.string().describe("ISO 8601 date (e.g., '2026-02-12')."),
  partySize: z.number().describe("Number of guests.")
});

export const BookTableSchema = z.object({
  restaurantId: z.string().describe("The internal ID of the restaurant."),
  tableId: z.string().describe("The ID of the table to book."),
  guestName: z.string().describe("The name for the reservation."),
  guestEmail: z.string().describe("The email for the reservation."),
  partySize: z.number().describe("Number of guests."),
  startTime: z.string().describe("ISO 8601 start time.")
});

export const TableReservationSchema = z.object({
  restaurant_name: z.string().describe("The name of the restaurant."),
  restaurant_address: z.string().optional().describe("The address of the restaurant."),
  lat: z.number().optional().describe("Latitude of the restaurant for precise booking."),
  lon: z.number().optional().describe("Longitude of the restaurant for precise booking."),
  date: z.string().describe("The date of the reservation (ISO 8601 format, e.g., '2026-02-11')."),
  time: z.string().describe("The time of the reservation (e.g., '19:00')."),
  party_size: z.number().int().positive().describe("Number of people in the party."),
  contact_name: z.string().describe("The name for the reservation."),
  contact_phone: z.string().describe("Contact phone number for the reservation."),
  contact_email: z.string().email().optional().describe("Contact email for the reservation."),
  special_requests: z.string().optional().describe("Any special requests for the reservation."),
  is_confirmed: z.boolean().default(false).describe("Set to true ONLY if the user has explicitly confirmed these specific details.")
});
