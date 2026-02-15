import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex, index, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const restaurants = pgTable('restaurants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  ownerEmail: text('owner_email').notNull(),
  ownerId: text('owner_id').notNull(),
  timezone: text('timezone').default('UTC'),
  lat: text('lat'),
  lng: text('lng'),
  address: text('address'),
  apiKey: text('api_key').unique().notNull(),
  openingTime: text('opening_time').default('09:00'),
  closingTime: text('closing_time').default('22:00'),
  daysOpen: text('days_open').default('monday,tuesday,wednesday,thursday,friday,saturday,sunday'),
  defaultDurationMinutes: integer('default_duration_minutes').default(90),
  stripeAccountId: text('stripe_account_id'),
  isShadow: boolean('is_shadow').default(false),
  isClaimed: boolean('is_claimed').default(false),
  claimToken: uuid('claim_token').defaultRandom(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => {
  return {
    slugIdx: uniqueIndex('slug_idx').on(table.slug),
    ownerIdIdx: index('owner_id_idx').on(table.ownerId),
  };
});

export const restaurantTables = pgTable('restaurant_tables', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  tableNumber: text('table_number').notNull(),
  minCapacity: integer('min_capacity').notNull(),
  maxCapacity: integer('max_capacity').notNull(),
  isActive: boolean('is_active').default(true),
  status: text('status').default('vacant'), // 'vacant', 'occupied', 'dirty'
  xPos: integer('x_pos').default(0),
  yPos: integer('y_pos').default(0),
  tableType: text('table_type').default('square'), // 'square', 'round', 'booth'
  updatedAt: timestamp('updated_at').defaultNow(),
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
  depositAmount: integer('deposit_amount').default(0),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  combinedTableIds: jsonb('combined_table_ids').$type<string[]>(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email').notNull(),
  partySize: integer('party_size').notNull(),
  status: text('status').default('waiting'), // 'waiting', 'seated', 'cancelled'
  joinedAt: timestamp('joined_at').defaultNow(),
});

export const inventory = pgTable('inventory', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  itemName: text('item_name').notNull(),
  quantity: integer('quantity').notNull(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const guestProfiles = pgTable('guest_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  defaultDeliveryAddress: text('default_delivery_address'),
  visitCount: integer('visit_count').default(0),
  preferences: text('preferences'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    restaurantEmailIdx: uniqueIndex('restaurant_email_idx').on(table.restaurantId, table.email),
  };
});

export const restaurantsRelations = relations(restaurants, ({ many }) => ({
  tables: many(restaurantTables),
  reservations: many(reservations),
  waitlist: many(waitlist),
  guestProfiles: many(guestProfiles),
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

export const guestProfilesRelations = relations(guestProfiles, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [guestProfiles.restaurantId],
    references: [restaurants.id],
  }),
}));
