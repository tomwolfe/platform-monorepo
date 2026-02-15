import { pgTable, uuid, text, doublePrecision, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { restaurants } from './index';
import { relations } from 'drizzle-orm';

export const products = pgTable('products', {
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
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  availableQuantity: integer('available_quantity').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const productsRelations = relations(products, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [products.restaurantId],
    references: [restaurants.id],
  }),
  inventory: one(inventoryLevels, {
    fields: [products.id],
    references: [inventoryLevels.productId],
  }),
}));

export const inventoryLevelsRelations = relations(inventoryLevels, ({ one }) => ({
  product: one(products, {
    fields: [inventoryLevels.productId],
    references: [products.id],
  }),
}));
