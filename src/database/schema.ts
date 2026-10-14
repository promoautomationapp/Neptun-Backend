import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import type { JsonObject } from "../shared/json";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings: jsonb("settings").$type<JsonObject>().notNull().default({}),
});
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  emailVerifiedAt: timestamp("email_verified_at", {
    withTimezone: true,
  }).defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
});
export const campaigns = pgTable("campaigns", {
  id: text("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  layout: jsonb("layout").$type<JsonObject>().notNull(),
  version: integer("version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  storageKey: text("storage_key").notNull(),
  sha256: text("sha256").notNull(),
  mimeType: text("mime_type").notNull(),
  metadata: jsonb("metadata").$type<JsonObject>().notNull(),
});
