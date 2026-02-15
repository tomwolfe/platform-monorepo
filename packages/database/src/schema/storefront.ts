import { pgTable, uuid, text, doublePrecision, integer, timestamp, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const userRoleEnum = pgEnum('user_role', ['shopper', 'merchant']);
export const reservationStatusEnum = pgEnum('reservation_status', ['pending', 'fulfilled']);

export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  fullAddress: text('full_address').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const storeProducts = pgTable('store_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  price: doublePrecision('price').notNull(),
  category: text('category').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const stock = pgTable('stock', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }).notNull(),
  productId: uuid('product_id').references(() => storeProducts.id, { onDelete: 'cascade' }).notNull(),
  availableQuantity: integer('available_quantity').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => {
  return {
    storeProductIdx: uniqueIndex('store_product_idx').on(table.storeId, table.productId),
  };
});

export const users = pgTable('user', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique().notNull(),
  name: text('name'),
  email: text('email').notNull().unique(),
  image: text('image'),
  role: userRoleEnum('role').notNull().default('shopper'),
  managedStoreId: uuid('managed_store_id').references(() => stores.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const productReservations = pgTable('product_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  productId: uuid('product_id').references(() => storeProducts.id, { onDelete: 'cascade' }).notNull(),
  storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }).notNull(),
  quantity: integer('quantity').notNull(),
  status: reservationStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const storesRelations = relations(stores, ({ many }) => ({
  stock: many(stock),
  users: many(users),
  reservations: many(productReservations),
}));

export const storeProductsRelations = relations(storeProducts, ({ many }) => ({
  stock: many(stock),
  reservations: many(productReservations),
}));

export const stockRelations = relations(stock, ({ one }) => ({
  store: one(stores, {
    fields: [stock.storeId],
    references: [stores.id],
  }),
  product: one(storeProducts, {
    fields: [stock.productId],
    references: [storeProducts.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  managedStore: one(stores, {
    fields: [users.managedStoreId],
    references: [stores.id],
  }),
  reservations: many(productReservations),
}));

export const productReservationsRelations = relations(productReservations, ({ one }) => ({
  user: one(users, {
    fields: [productReservations.userId],
    references: [users.id],
  }),
  product: one(storeProducts, {
    fields: [productReservations.productId],
    references: [storeProducts.id],
  }),
  store: one(stores, {
    fields: [productReservations.storeId],
    references: [stores.id],
  }),
}));
