import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const peerRooms = sqliteTable('peer_rooms', {
  code: text('code').primaryKey(), ownerHash: text('owner_hash').notNull(), expiresAt: integer('expires_at').notNull()
},table=>[index('peer_rooms_expiry').on(table.expiresAt)]);
export const peerOffers = sqliteTable('peer_offers', {
  id:text('id').primaryKey(),roomCode:text('room_code').notNull().references(()=>peerRooms.code,{onDelete:'cascade'}),
  guestHash:text('guest_hash').notNull(),offer:text('offer').notNull(),answer:text('answer'),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull()
},table=>[index('peer_offers_room').on(table.roomCode),index('peer_offers_expiry').on(table.expiresAt)]);
