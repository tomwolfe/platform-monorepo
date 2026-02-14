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

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { mode: 'date' }),
  image: text('image'),
  role: userRoleEnum('role').notNull().default('shopper'),
  managedStoreId: uuid('managed_store_id').references(() => stores.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const accounts = pgTable('accounts', {
  userId: uuid('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('providerAccountId').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, (account) => ({
  compoundKey: uniqueIndex('accounts_compound_key').on(account.provider, account.providerAccountId),
}));

export const sessions = pgTable('sessions', {
  sessionToken: text('sessionToken').notNull().primaryKey(),
  userId: uuid('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable('verificationToken', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
}, (vt) => ({
  compoundKey: uniqueIndex('verification_token_compound_key').on(vt.identifier, vt.token),
}));

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
  accounts: many(accounts),
  sessions: many(sessions),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
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
