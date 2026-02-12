import { pgTable, uuid, text, integer, timestamp, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const restaurants = pgTable('restaurants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  timezone: text('timezone').default('UTC'),
  apiKey: text('api_key').unique().notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const restaurantTables = pgTable('restaurant_tables', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  tableNumber: text('table_number').notNull(),
  minCapacity: integer('min_capacity').notNull(),
  maxCapacity: integer('max_capacity').notNull(),
  isActive: boolean('is_active').default(true),
  xPos: integer('x_pos').default(0),
  yPos: integer('y_pos').default(0),
  tableType: text('table_type').default('square'), // 'square', 'round', 'booth'
});

export const reservations = pgTable('reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  tableId: uuid('table_id').references(() => restaurantTables.id),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email').notNull(),
  partySize: integer('party_size').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  status: text('status').default('confirmed'), // 'confirmed', 'cancelled', 'noshow'
  isVerified: boolean('is_verified').default(false),
  verificationToken: uuid('verification_token').defaultRandom(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const restaurantsRelations = relations(restaurants, ({ many }) => ({
  tables: many(restaurantTables),
  reservations: many(reservations),
}));

export const restaurantTablesRelations = relations(restaurantTables, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [restaurantTables.restaurantId],
    references: [restaurants.id],
  }),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [reservations.restaurantId],
    references: [restaurants.id],
  }),
  table: one(restaurantTables, {
    fields: [reservations.tableId],
    references: [restaurantTables.id],
  }),
}));
