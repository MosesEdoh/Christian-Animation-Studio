import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const episodeExportPoolsTable = pgTable("episode_export_pools", {
  name: text("name").primaryKey(),
  capacity: integer("capacity").notNull(),
}, table => [check("episode_export_capacity_positive", sql`${table.capacity} > 0`)]);

export const episodeExportLeasesTable = pgTable("episode_export_leases", {
  owner: uuid("owner").primaryKey(),
  pool: text("pool").notNull().references(() => episodeExportPoolsTable.name),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [index("episode_export_leases_pool").on(table.pool)]);

export const insertEpisodeExportPoolSchema = createInsertSchema(episodeExportPoolsTable);
export const insertEpisodeExportLeaseSchema = createInsertSchema(episodeExportLeasesTable);
export type EpisodeExportPool = typeof episodeExportPoolsTable.$inferSelect;
export type EpisodeExportLease = typeof episodeExportLeasesTable.$inferSelect;
