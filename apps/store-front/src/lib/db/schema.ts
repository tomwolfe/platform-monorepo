import { pgTable, uuid, text, doublePrecision, integer, timestamp, uniqueIndex, pgEnum, primaryKey } from 'drizzle-orm/pg-core';
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

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  price: doublePrecision('price').notNull(), // Using double for price as per prompt description, though integer cents is usually better. Sticking to prompt.
  category: text('category').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const stock = pgTable('stock', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }).notNull(),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
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

export const reservations = pgTable('reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }).notNull(),
  quantity: integer('quantity').notNull(),
  status: reservationStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const storesRelations = relations(stores, ({ many }) => ({
  stock: many(stock),
  users: many(users),
  reservations: many(reservations),
}));

export const productsRelations = relations(products, ({ many }) => ({
  stock: many(stock),
  reservations: many(reservations),
}));

export const stockRelations = relations(stock, ({ one }) => ({
  store: one(stores, {
    fields: [stock.storeId],
    references: [stores.id],
  }),
  product: one(products, {
    fields: [stock.productId],
    references: [products.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  managedStore: one(stores, {
    fields: [users.managedStoreId],
    references: [stores.id],
  }),
  reservations: many(reservations),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  user: one(users, {
    fields: [reservations.userId],
    references: [users.id],
  }),
  product: one(products, {
    fields: [reservations.productId],
    references: [products.id],
  }),
  store: one(stores, {
    fields: [reservations.storeId],
    references: [stores.id],
  }),
}));
