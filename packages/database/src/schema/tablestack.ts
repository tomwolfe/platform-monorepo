import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex, index, jsonb, pgEnum, doublePrecision, numeric } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const waitlistStatusEnum = pgEnum('waitlist_status', ['waiting', 'notified', 'seated']);
export const userRoleEnum = pgEnum('user_role', ['shopper', 'merchant']);

export const users = pgTable('user', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique().notNull(),
  name: text('name'),
  email: text('email').notNull().unique(),
  image: text('image'),
  role: userRoleEnum('role').notNull().default('shopper'),
  // Contextual continuity: Store last inferred intent for conversation context
  lastInteractionContext: jsonb('last_interaction_context').$type<{
    intentType?: string;
    rawText?: string;
    parameters?: Record<string, unknown>;
    timestamp?: string;
    executionId?: string;
  }>(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    clerkIdIdx: uniqueIndex('clerk_id_idx').on(table.clerkId),
    emailIdx: uniqueIndex('email_idx').on(table.email),
  };
});

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
  // Deprecated: stripeAccountId: text('stripe_account_id'),
  walletAddress: text('wallet_address'), // Crypto wallet for receiving payments
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

export const restaurantReservations = pgTable('restaurant_reservations', {
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
  // Deprecated: stripePaymentIntentId: text('stripe_payment_intent_id'),
  paymentTxHash: text('payment_tx_hash').unique(), // On-chain transaction hash for crypto payment
  combinedTableIds: jsonb('combined_table_ids').$type<string[]>(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const restaurantWaitlist = pgTable('restaurant_waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email').notNull(),
  partySize: integer('party_size').notNull(),
  status: waitlistStatusEnum('status').default('waiting').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const restaurantProducts = pgTable('restaurant_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  price: doublePrecision('price').notNull(),
  category: text('category').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const inventoryLevels = pgTable('inventory_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').references(() => restaurantProducts.id, { onDelete: 'cascade' }).notNull(),
  availableQuantity: integer('available_quantity').notNull().default(0),
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
  restaurantReservations: many(restaurantReservations),
  restaurantWaitlist: many(restaurantWaitlist),
  guestProfiles: many(guestProfiles),
  restaurantProducts: many(restaurantProducts),
}));

export const restaurantTablesRelations = relations(restaurantTables, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [restaurantTables.restaurantId],
    references: [restaurants.id],
  }),
}));

export const restaurantReservationsRelations = relations(restaurantReservations, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [restaurantReservations.restaurantId],
    references: [restaurants.id],
  }),
  table: one(restaurantTables, {
    fields: [restaurantReservations.tableId],
    references: [restaurantTables.id],
  }),
}));

export const restaurantWaitlistRelations = relations(restaurantWaitlist, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [restaurantWaitlist.restaurantId],
    references: [restaurants.id],
  }),
}));

export const restaurantProductsRelations = relations(restaurantProducts, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [restaurantProducts.restaurantId],
    references: [restaurants.id],
  }),
  inventory: one(inventoryLevels, {
    fields: [restaurantProducts.id],
    references: [inventoryLevels.productId],
  }),
}));

export const inventoryLevelsRelations = relations(inventoryLevels, ({ one }) => ({
  product: one(restaurantProducts, {
    fields: [inventoryLevels.productId],
    references: [restaurantProducts.id],
  }),
}));

export const guestProfilesRelations = relations(guestProfiles, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [guestProfiles.restaurantId],
    references: [restaurants.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  // Add relations if needed in the future
  // For now, users is a standalone table for contextual memory
}));

// ============================================================================
// TRANSACTIONAL OUTBOX PATTERN
// For reliable saga state synchronization between Postgres and Redis
// ============================================================================

export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'processing', 'processed', 'failed']);

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Event type (e.g., 'SAGA_STEP_COMPLETED', 'SAGA_COMPENSATION_TRIGGERED')
  eventType: text('event_type').notNull(),
  // Payload containing event data (JSON)
  payload: jsonb('payload').notNull().$type<{
    executionId: string;
    stepId?: string;
    stepIndex?: number;
    status?: string;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
    timestamp: string;
    traceId?: string;
    correlationId?: string;
  }>(),
  // Status of the event (pending -> processing -> processed/failed)
  status: outboxStatusEnum('status').default('pending').notNull(),
  // Number of processing attempts (for retry logic)
  attempts: integer('attempts').default(0).notNull(),
  // Error message if processing failed
  errorMessage: text('error_message'),
  // When this event was created
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // When this event was last processed
  processedAt: timestamp('processed_at'),
  // When this event expires (for cleanup)
  expiresAt: timestamp('expires_at'),
}, (table) => {
  return {
    // Index for efficient polling of pending events
    statusCreatedAtIdx: index('outbox_status_created_at_idx').on(table.status, table.createdAt),
    // Index for looking up by execution ID
    executionIdIdx: index('outbox_execution_id_idx').on(table.payload),
  };
});

// ============================================================================
// GLOBAL CRYPTO TRANSACTION REPLAY PREVENTION
// Prevents front-running and replay attacks across all apps
// ============================================================================

/**
 * processed_crypto_transactions - Global registry of verified crypto payments
 * 
 * SECURITY PURPOSE:
 * - Prevents replay attacks where attackers reuse txHash from public blockchain
 * - Prevents cross-app replay (e.g., using OpenDelivery payment for TableStack reservation)
 * - Enforces global uniqueness of transaction hashes across the entire system
 * 
 * Usage:
 * 1. Before accepting a payment, check if txHash already exists in this table
 * 2. After successful verification, insert the txHash with app_source
 * 3. All payment verification flows MUST check this table first
 */
export const processed_crypto_transactions = pgTable('processed_crypto_transactions', {
  // Transaction hash as primary key (enforces global uniqueness)
  txHash: text('tx_hash').primaryKey().notNull(),
  // Source app that processed this transaction ('open-delivery', 'table-stack', etc.)
  appSource: text('app_source').notNull(),
  // Associated entity ID (orderId, reservationId, etc.) for audit trail
  entityId: text('entity_id').notNull(),
  // When this transaction was processed
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
  return {
    // Index for efficient lookup by entity
    entityIdIdx: index('processed_tx_entity_id_idx').on(table.entityId),
    // Index for efficient lookup by app source
    appSourceIdx: index('processed_tx_app_source_idx').on(table.appSource),
  };
});

// OpenDeliver: Drivers table for delivery network
export const drivers = pgTable('drivers', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique(), // Link to Clerk authentication
  fullName: text('full_name').notNull(),
  email: text('email').unique().notNull(),
  walletAddress: text('wallet_address'), // Crypto wallet for payouts
  trustScore: integer('trust_score').default(80),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  lastOnline: timestamp('last_online'),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    clerkIdIdx: uniqueIndex('drivers_clerk_id_idx').on(table.clerkId),
    emailIdx: uniqueIndex('drivers_email_idx').on(table.email),
  };
});

// OpenDeliver: Orders table for durable order storage
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  driverId: uuid('driver_id').references(() => drivers.id),
  storeId: uuid('store_id').references(() => restaurants.id),
  status: text('status').notNull().default('pending'), // pending, matched, preparing, pickup, transit, delivered, cancelled
  // Crypto-safe numeric fields: stores raw token amounts as strings (Wei for ETH, smallest unit for other tokens)
  // numeric(78, 0) supports up to 78 digits - sufficient for any token's smallest unit (e.g., 10^77 Wei)
  subtotal: numeric('subtotal', { precision: 78, scale: 0 }).notNull().default('0'), // Price of food/items in token smallest unit
  tip: numeric('tip', { precision: 78, scale: 0 }).notNull().default('0'), // Driver incentive in token smallest unit
  total: numeric('total', { precision: 78, scale: 0 }).notNull().default('0'), // subtotal + tip in token smallest unit
  deliveryAddress: text('delivery_address').notNull(),
  pickupAddress: text('pickup_address'),
  specialInstructions: text('special_instructions'),
  priority: text('priority').default('standard'), // standard, express, urgent
  // Web3 payment tracking
  paymentTxHash: text('payment_tx_hash').unique(), // On-chain transaction hash
  walletAddress: text('wallet_address'), // User's wallet address
  paymentCurrency: text('payment_currency').default('USDC'), // Token symbol (USDC, ETH, etc.)
  matchedAt: timestamp('matched_at'),
  pickedUpAt: timestamp('picked_up_at'),
  deliveredAt: timestamp('delivered_at'),
  cancelledAt: timestamp('cancelled_at'),
  cancellationReason: text('cancellation_reason'),
  // Payout tracking (to prevent double-spending)
  payoutStatus: text('payout_status').default('pending'), // pending, processing, completed, failed
  payoutProcessedAt: timestamp('payout_processed_at'),
  payoutTxHash: text('payout_tx_hash'), // On-chain transaction hash for payout (async verification)
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    userIdIdx: index('orders_user_id_idx').on(table.userId),
    driverIdIdx: index('orders_driver_id_idx').on(table.driverId),
    storeIdIdx: index('orders_store_id_idx').on(table.storeId),
    statusIdx: index('orders_status_idx').on(table.status),
    paymentTxHashIdx: uniqueIndex('orders_payment_tx_hash_idx').on(table.paymentTxHash),
    payoutStatusIdx: index('orders_payout_status_idx').on(table.payoutStatus),
    payoutTxHashIdx: index('orders_payout_tx_hash_idx').on(table.payoutTxHash),
  };
});

// OpenDeliver: Order items table
export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull().default(1),
  price: doublePrecision('price').notNull(),
  specialInstructions: text('special_instructions'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => {
  return {
    orderIdIdx: index('order_items_order_id_idx').on(table.orderId),
  };
});

// OpenDeliver: Drivers relations
export const driversRelations = relations(drivers, ({ many }) => ({
  orders: many(orders),
}));

// OpenDeliver: Orders relations
export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
  driver: one(drivers, {
    fields: [orders.driverId],
    references: [drivers.id],
  }),
  store: one(restaurants, {
    fields: [orders.storeId],
    references: [restaurants.id],
  }),
  items: many(orderItems),
}));

// OpenDeliver: Order items relations
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));
