import { pgTable, uuid, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { restaurants } from './index';
import { relations } from 'drizzle-orm';

export const waitlistStatusEnum = pgEnum('waitlist_status', ['waiting', 'notified', 'seated']);

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').references(() => restaurants.id, { onDelete: 'cascade' }).notNull(),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email').notNull(),
  partySize: integer('party_size').notNull(),
  status: waitlistStatusEnum('status').default('waiting').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const waitlistRelations = relations(waitlist, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [waitlist.restaurantId],
    references: [restaurants.id],
  }),
}));
