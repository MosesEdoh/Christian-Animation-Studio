import {
  bigint,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const studioProjectsTable = pgTable("studio_projects", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  logline: text("logline").notNull(),
  audience: text("audience").notNull(),
  seasonLabel: text("season_label").notNull(),
  activeEpisodeId: integer("active_episode_id").notNull().default(1),
});

export const studioEpisodesTable = pgTable("studio_episodes", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull(),
  progress: integer("progress").notNull().default(0),
  duration: text("duration").notNull(),
});

export const studioScenesTable = pgTable("studio_scenes", {
  id: serial("id").primaryKey(),
  episodeId: integer("episode_id").notNull(),
  number: integer("number").notNull(),
  heading: text("heading").notNull(),
  synopsis: text("synopsis").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull(),
  duration: text("duration").notNull(),
});

export const studioCharactersTable = pgTable("studio_characters", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  personality: text("personality").notNull(),
  arc: text("arc").notNull(),
  faithLesson: text("faith_lesson").notNull(),
  visualNotes: text("visual_notes").notNull(),
  referenceImageUrl: text("reference_image_url"),
});

export const studioShotsTable = pgTable("studio_shots", {
  id: serial("id").primaryKey(),
  sceneId: integer("scene_id").notNull(),
  number: integer("number").notNull(),
  description: text("description").notNull(),
  shotType: text("shot_type").notNull(),
  movement: text("movement").notNull(),
  angle: text("angle").notNull(),
  beat: text("beat").notNull(),
  duration: text("duration").notNull(),
  referenceImageUrl: text("reference_image_url"),
  status: text("status").notNull(),
});

export const studioClipsTable = pgTable("studio_clips", {
  id: serial("id").primaryKey(),
  shotId: integer("shot_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  url: text("url"),
  thumbnailUrl: text("thumbnail_url"),
  duration: text("duration").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const studioAssetsTable = pgTable("studio_assets", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  episodeId: integer("episode_id"),
  sceneId: integer("scene_id"),
  characterId: integer("character_id"),
  kind: text("kind").notNull(),
  objectPath: text("object_path").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const studioExportsTable = pgTable("studio_exports", {
  id: serial("id").primaryKey(),
  requestId: text("request_id").unique(),
  episodeId: integer("episode_id"),
  aspectRatio: text("aspect_ratio").notNull(),
  quality: text("quality").notNull(),
  status: text("status", { enum: ["queued", "rendering", "ready", "failed", "cancelled"] }).notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  objectPath: text("object_path"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStudioProjectSchema = createInsertSchema(
  studioProjectsTable,
).omit({ id: true });
export const insertStudioEpisodeSchema = createInsertSchema(
  studioEpisodesTable,
).omit({ id: true });
export const insertStudioSceneSchema = createInsertSchema(
  studioScenesTable,
).omit({ id: true });
export const insertStudioCharacterSchema = createInsertSchema(
  studioCharactersTable,
).omit({ id: true });
export const insertStudioShotSchema = createInsertSchema(
  studioShotsTable,
).omit({ id: true });
export const insertStudioClipSchema = createInsertSchema(
  studioClipsTable,
).omit({ id: true, createdAt: true });
export const insertStudioAssetSchema = createInsertSchema(
  studioAssetsTable,
).omit({ id: true, createdAt: true });

export type StudioProject = typeof studioProjectsTable.$inferSelect;
export type StudioEpisode = typeof studioEpisodesTable.$inferSelect;
export type StudioScene = typeof studioScenesTable.$inferSelect;
export type StudioCharacter = typeof studioCharactersTable.$inferSelect;
export type StudioShot = typeof studioShotsTable.$inferSelect;
export type StudioClip = typeof studioClipsTable.$inferSelect;
export type StudioAsset = typeof studioAssetsTable.$inferSelect;
export type InsertStudioCharacter = z.infer<typeof insertStudioCharacterSchema>;