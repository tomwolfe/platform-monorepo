import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex, index, jsonb, pgEnum, doublePrecision, numeric } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const waitlistStatusEnum = pgEnum('waitlist_status', ['waiting', 'notified', 'seated']);
export const userRoleEnum = pgEnum('user_role', ['shopper', 'merchant']);

// ============================================================================
// CRYPTO PRICES HISTORICAL FALLBACK
// Used by getCryptoPrices oracle when all external APIs fail
// ============================================================================

export const cryptoPrices = pgTable("crypto_prices", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull(), // 'ETH' | 'MATIC'
  priceUsd: doublePrecision("price_usd").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
  /** Timezone for restaurant operations. Nullable to allow legacy data migration. */
  timezone: text('timezone').default('UTC'),
  /** Latitude coordinate for restaurant location. Nullable - not all restaurants have GPS coordinates. */
  lat: numeric('lat', { precision: 10, scale: 7 }),
  /** Longitude coordinate for restaurant location. Nullable - not all restaurants have GPS coordinates. */
  lng: numeric('lng', { precision: 10, scale: 7 }),
  /** Physical address of the restaurant. Nullable for shadow restaurants. */
  address: text('address'),
  apiKey: text('api_key').unique().notNull(),
  openingTime: text('opening_time').default('09:00'),
  closingTime: text('closing_time').default('22:00'),
  daysOpen: text('days_open').default('monday,tuesday,wednesday,thursday,friday,saturday,sunday'),
  defaultDurationMinutes: integer('default_duration_minutes').default(90),
  /** Crypto wallet address for receiving payments. Nullable until restaurant connects wallet. */
  walletAddress: text('wallet_address'),
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
  /** Table status: 'vacant', 'occupied', or 'dirty'. Nullable to allow legacy data. */
  status: text('status').default('vacant'),
  /** X position on floor plan. Nullable - defaults to 0. */
  xPos: integer('x_pos').default(0),
  /** Y position on floor plan. Nullable - defaults to 0. */
  yPos: integer('y_pos').default(0),
  /** Table shape type for rendering. Nullable - defaults to 'square'. */
  tableType: text('table_type').default('square'),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    restaurantIdIdx: index('tables_restaurant_id_idx').on(table.restaurantId),
  };
});

export const restaurantReservations = pgTable('restaurant_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  /** Table ID for the reservation. Nullable until table is assigned. */
  tableId: uuid('table_id').references(() => restaurantTables.id),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email').notNull(),
  partySize: integer('party_size').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  /** Reservation status: 'confirmed', 'cancelled', or 'noshow'. Nullable to allow legacy data. */
  status: text('status').default('confirmed'),
  isVerified: boolean('is_verified').default(false),
  verificationToken: uuid('verification_token').defaultRandom(),
  depositAmount: integer('deposit_amount').default(0),
  /** On-chain transaction hash for crypto payment. Nullable until payment is made. */
  paymentTxHash: text('payment_tx_hash').unique(),
  /** Array of table IDs when tables are combined. Nullable for single-table reservations. */
  combinedTableIds: jsonb('combined_table_ids').$type<string[]>(),
  /** Additional metadata for the reservation. Nullable for optional extensibility. */
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => {
  return {
    // Indexes for efficient querying
    restaurantIdIdx: index('reservations_restaurant_id_idx').on(table.restaurantId),
    guestEmailIdx: index('reservations_guest_email_idx').on(table.guestEmail),
    startTimeIdx: index('reservations_start_time_idx').on(table.startTime),
    statusIdx: index('reservations_status_idx').on(table.status),
    // Composite index for common query pattern: find reservations by restaurant + status + time
    restaurantStatusTimeIdx: index('reservations_restaurant_status_time_idx').on(table.restaurantId, table.status, table.startTime),
  };
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
}, (table) => {
  return {
    // Indexes for efficient querying
    restaurantIdIdx: index('waitlist_restaurant_id_idx').on(table.restaurantId),
    statusIdx: index('waitlist_status_idx').on(table.status),
    createdAtIdx: index('waitlist_created_at_idx').on(table.createdAt),
    // Composite index for common query: get waiting list by restaurant ordered by time
    restaurantStatusCreatedAtIdx: index('waitlist_restaurant_status_created_at_idx').on(table.restaurantId, table.status, table.createdAt),
  };
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
}, (table) => {
  return {
    // Indexes for efficient querying
    restaurantIdIdx: index('products_restaurant_id_idx').on(table.restaurantId),
    categoryIdx: index('products_category_idx').on(table.category),
    // Composite index for querying products by restaurant and category
    restaurantCategoryIdx: index('products_restaurant_category_idx').on(table.restaurantId, table.category),
  };
});

export const inventoryLevels = pgTable('inventory_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').references(() => restaurantProducts.id, { onDelete: 'cascade' }).notNull(),
  availableQuantity: integer('available_quantity').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    // Index for efficient querying by product
    productIdIdx: index('inventory_product_id_idx').on(table.productId),
    // Unique constraint to prevent duplicate inventory records
    uniqueProduct: uniqueIndex('inventory_product_unique_idx').on(table.productId),
  };
});

export const guestProfiles = pgTable('guest_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  /** Default delivery address for the guest. Nullable for pickup orders. */
  defaultDeliveryAddress: text('default_delivery_address'),
  visitCount: integer('visit_count').default(0),
  /** Guest preferences (dietary restrictions, allergies, etc.). Nullable for optional tracking. */
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
  // When this event was last updated (for detecting orphaned processing events)
  updatedAt: timestamp('updated_at').defaultNow(),
  // When this event was last processed
  processedAt: timestamp('processed_at'),
  // When this event expires (for cleanup)
  expiresAt: timestamp('expires_at'),
}, (table) => {
  return {
    // Index for efficient polling of pending events
    statusCreatedAtIdx: index('outbox_status_created_at_idx').on(table.status, table.createdAt),
    // Index for looking up by execution ID (using JSONB expression for efficient path queries)
    executionIdIdx: index('outbox_execution_id_idx').on(sql`(${table.payload}->>'executionId')`),
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

/**
 * Crypto Transaction Speed-Ups Tracking
 * 
 * Tracks replacement transactions sent with higher gas fees to unstuck pending payments.
 * Used by the TransactionSpeedUpService to monitor gas bump attempts.
 */
export const crypto_transaction_speedups = pgTable('crypto_transaction_speedups', {
  // Original transaction hash (references processed_crypto_transactions)
  originalTxHash: text('original_tx_hash').primaryKey().notNull(),
  // Replacement transaction hash with higher gas
  replacementTxHash: text('replacement_tx_hash').notNull(),
  // Associated entity ID (orderId, reservationId, etc.)
  entityId: text('entity_id').notNull(),
  // Gas bump percentage applied (e.g., 20 for 20% increase)
  gasBumpPercentage: integer('gas_bump_percentage').notNull(),
  // When the speed-up was created
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // When the speed-up was last updated
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    // Index for efficient lookup by entity
    entityIdIdx: index('speedups_entity_id_idx').on(table.entityId),
    // Index for efficient lookup by replacement tx hash
    replacementTxIdx: index('speedups_replacement_tx_idx').on(table.replacementTxHash),
  };
});

// OpenDeliver: Drivers table for delivery network
export const drivers = pgTable('drivers', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Link to Clerk authentication. Nullable for drivers not yet authenticated. */
  clerkId: text('clerk_id').unique(),
  fullName: text('full_name').notNull(),
  email: text('email').unique().notNull(),
  /** Crypto wallet address for payouts. Nullable until driver connects wallet. */
  walletAddress: text('wallet_address'),
  trustScore: integer('trust_score').default(80),
  isActive: boolean('is_active').default(true),
  /** GPS latitude coordinate. Nullable when driver is offline. */
  currentLat: numeric('current_lat', { precision: 10, scale: 7 }),
  /** GPS longitude coordinate. Nullable when driver is offline. */
  currentLng: numeric('current_lng', { precision: 10, scale: 7 }),
  createdAt: timestamp('created_at').defaultNow(),
  /** Last time driver was online. Nullable for new drivers. */
  lastOnline: timestamp('last_online'),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    clerkIdIdx: uniqueIndex('drivers_clerk_id_idx').on(table.clerkId),
    emailIdx: uniqueIndex('drivers_email_idx').on(table.email),
    // Composite index for geospatial queries (bounding box searches)
    locationIdx: index('drivers_location_idx').on(table.currentLat, table.currentLng),
    activeLocationIdx: index('drivers_active_location_idx').on(table.isActive, table.currentLat, table.currentLng),
  };
});

// OpenDeliver: Orders table for durable order storage
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  driverId: uuid('driver_id').references(() => drivers.id),
  storeId: uuid('store_id').references(() => restaurants.id),
  /** Order status lifecycle. Nullable to allow draft orders. */
  status: text('status').notNull().default('pending'),
  subtotal: numeric('subtotal', { precision: 78, scale: 0 }).notNull().default('0'),
  tip: numeric('tip', { precision: 78, scale: 0 }).notNull().default('0'),
  total: numeric('total', { precision: 78, scale: 0 }).notNull().default('0'),
  deliveryAddress: text('delivery_address').notNull(),
  /** Pickup address for the order. Nullable for delivery-only orders. */
  pickupAddress: text('pickup_address'),
  /** Special instructions from customer. Nullable for standard orders. */
  specialInstructions: text('special_instructions'),
  priority: text('priority').default('standard'),
  /** On-chain transaction hash for payment. Nullable until payment is confirmed. */
  paymentTxHash: text('payment_tx_hash').unique(),
  /** User's wallet address. Nullable for non-crypto payments. */
  walletAddress: text('wallet_address'),
  paymentCurrency: text('payment_currency').default('USDC'),
  /** When order was matched to a driver. Nullable until driver accepts. */
  matchedAt: timestamp('matched_at'),
  /** When order was picked up. Nullable until driver arrives. */
  pickedUpAt: timestamp('picked_up_at'),
  /** When order was delivered. Nullable until delivery complete. */
  deliveredAt: timestamp('delivered_at'),
  /** When order was cancelled. Nullable for active orders. */
  cancelledAt: timestamp('cancelled_at'),
  /** Reason for cancellation. Nullable for non-cancelled orders. */
  cancellationReason: text('cancellation_reason'),
  escrowStatus: text('escrow_status').default('locked'),
  /** When escrow payout was processed. Nullable until escrow release. */
  payoutProcessedAt: timestamp('payout_processed_at'),
  /** On-chain tx hash for escrow release. Nullable until payout complete. */
  payoutTxHash: text('payout_tx_hash'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    userIdIdx: index('orders_user_id_idx').on(table.userId),
    driverIdIdx: index('orders_driver_id_idx').on(table.driverId),
    storeIdIdx: index('orders_store_id_idx').on(table.storeId),
    statusIdx: index('orders_status_idx').on(table.status),
    paymentTxHashIdx: uniqueIndex('orders_payment_tx_hash_idx').on(table.paymentTxHash),
    escrowStatusIdx: index('orders_escrow_status_idx').on(table.escrowStatus),
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
