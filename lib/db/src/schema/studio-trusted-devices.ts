import { createInsertSchema } from "drizzle-zod";
import { pgTable, serial, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const studioTrustedDevicesTable = pgTable(
  "studio_trusted_devices",
  {
    id: serial("id").primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdByUserId: varchar("created_by_user_id", { length: 255 }).notNull(),
    label: varchar("label", { length: 80 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [uniqueIndex("studio_trusted_devices_token_hash_unique").on(table.tokenHash)],
);

export const insertStudioTrustedDeviceSchema = createInsertSchema(studioTrustedDevicesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertStudioTrustedDevice = z.infer<typeof insertStudioTrustedDeviceSchema>;
export type StudioTrustedDevice = typeof studioTrustedDevicesTable.$inferSelect;
