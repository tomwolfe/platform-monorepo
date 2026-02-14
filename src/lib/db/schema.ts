import { pgTable, uuid, text, doublePrecision, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

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

export const storesRelations = relations(stores, ({ many }) => ({
  stock: many(stock),
}));

export const productsRelations = relations(products, ({ many }) => ({
  stock: many(stock),
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
