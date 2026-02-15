"use server";

import { db } from "@/db";
import { restaurants, restaurantTables } from "@/db/schema";
import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import crypto from "crypto";

const onboardingSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2),
  timezone: z.string().min(1),
  openingTime: z.string().min(1),
  closingTime: z.string().min(1),
  daysOpen: z.array(z.string()).min(1),
  defaultDurationMinutes: z.number().min(1),
  tables: z.array(z.object({
    id: z.string().optional(),
    tableNumber: z.string(),
    minCapacity: z.number().min(1),
    maxCapacity: z.number().min(1),
    xPos: z.number(),
    yPos: z.number(),
    tableType: z.enum(['square', 'round', 'booth']),
  })),
});

export async function createRestaurant(data: z.infer<typeof onboardingSchema>) {
  const user = await currentUser();
  if (!user) throw new Error("Unauthorized");

  const validated = onboardingSchema.parse(data);

  // Check if slug is already taken
  const existing = await db.query.restaurants.findFirst({
    where: (restaurants, { eq }) => eq(restaurants.slug, validated.slug),
  });

  if (existing) {
    return { error: "This public slug is already taken. Please choose another one." };
  }

  const apiKey = `ts_${crypto.randomBytes(16).toString("hex")}`;

  const [restaurant] = await db.insert(restaurants).values({
    name: validated.name,
    slug: validated.slug,
    ownerEmail: user.emailAddresses[0].emailAddress,
    ownerId: user.id,
    timezone: validated.timezone,
    openingTime: validated.openingTime,
    closingTime: validated.closingTime,
    daysOpen: validated.daysOpen.join(','),
    defaultDurationMinutes: validated.defaultDurationMinutes,
    apiKey,
  }).returning();

  if (validated.tables.length > 0) {
    await db.insert(restaurantTables).values(
      validated.tables.map(table => ({
        restaurantId: restaurant.id,
        tableNumber: table.tableNumber,
        minCapacity: table.minCapacity,
        maxCapacity: table.maxCapacity,
        xPos: Math.round(table.xPos),
        yPos: Math.round(table.yPos),
        tableType: table.tableType,
        status: 'vacant' as const,
      }))
    );
  }

  revalidatePath("/dashboard");
  redirect(`/dashboard/${restaurant.id}`);
}
