import { createInsertSchema } from "drizzle-zod";
import { pgTable, serial, text, timestamp, varchar, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { z } from "zod/v4";

export const childProfilesTable = pgTable("child_profiles", {
  id: serial("id").primaryKey(),
  guardianUserId: varchar("guardian_user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 40 }).notNull(),
  ageBand: text("age_band", { enum: ["5-8", "9-12", "13-17"] }).notNull(),
  status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
  childSafeMode: boolean("child_safe_mode").notNull().default(true),
  guardianConsentAt: timestamp("guardian_consent_at", { withTimezone: true }).notNull(),
  guardianNoticeVersion: varchar("guardian_notice_version", { length: 40 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertChildProfileSchema = createInsertSchema(childProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChildProfile = z.infer<typeof insertChildProfileSchema>;
export type ChildProfile = typeof childProfilesTable.$inferSelect;
