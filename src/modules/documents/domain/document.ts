import { z } from "zod";
import { identifier, jsonValue, jsonObject } from "../../../shared/json";
export const statuses = [
  "in_progress",
  "in_review",
  "changes_requested",
  "completed",
] as const;
export const replySchema = z
  .object({
    id: identifier,
    text: z.string(),
    authorEmail: z.string(),
    createdAt: z.string(),
    mention: z.string().nullable().optional(),
  })
  .catchall(jsonValue);
export const commentSchema = z
  .object({
    id: identifier,
    pageIndex: z.number().int(),
    pageLabel: z.string().optional(),
    text: z.string(),
    authorEmail: z.string(),
    createdAt: z.string(),
    mention: z.string().nullable().optional(),
    position: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
    replies: z.array(replySchema).default([]),
    fixed: z.boolean().default(false),
    fixedAt: z.string().nullable().optional(),
    fixedBy: z.string().nullable().optional(),
  })
  .catchall(jsonValue);
export const historySchema = z
  .object({
    id: identifier,
    action: z.string(),
    actor: z.string(),
    role: z.string(),
    at: z.string(),
    commentId: z.string().nullable().optional(),
  })
  .catchall(jsonValue);
export const campaignSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(300),
    products: z.array(jsonObject).max(2000),
    showCoverBand: z.boolean().default(false),
    coverMessageColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#ffffff"),
    coverHeadlineColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#ffffff"),
    coverTypeColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#ffffff"),
    coverFooterColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#ffffff"),
    version: z.number().int().positive().optional(),
    disabledAt: z.iso.datetime().nullable().optional(),
    disabledBy: z.string().max(320).nullable().optional(),
    status: z.enum(statuses).optional(),
    reviewComments: z.array(commentSchema).default([]),
    reviewHistory: z.array(historySchema).default([]),
  })
  .catchall(jsonValue);
export const postSchema = z
  .object({
    id: identifier,
    name: z.string().max(300).default("Social post"),
    products: z.array(jsonObject).max(12),
    version: z.number().int().positive().optional(),
    disabledAt: z.iso.datetime().nullable().optional(),
    disabledBy: z.string().max(320).nullable().optional(),
  })
  .catchall(jsonValue);
export type Campaign = z.infer<typeof campaignSchema>;
export type Post = z.infer<typeof postSchema>;
export type DocumentKind = "campaign" | "post";
export interface DocumentRow {
  id: string;
  layout: Campaign | Post;
  version: number;
  status?: Campaign["status"];
  updated_at: Date;
  deleted_at?: Date | null;
}
export function documentSnapshot(
  row: DocumentRow,
  kind: DocumentKind,
): Campaign | Post {
  return {
    ...row.layout,
    // Older layouts did not store this flag. Their covers should use the
    // current opt-in behavior without rewriting the saved JSON document.
    ...(kind === "campaign" && row.layout.showCoverBand === undefined
      ? { showCoverBand: false }
      : {}),
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    disabledAt: row.deleted_at?.toISOString() ?? null,
    disabledBy:
      row.deleted_at && typeof row.layout.disabledBy === "string"
        ? row.layout.disabledBy
        : null,
    ...(row.status ? { status: row.status } : {}),
  };
}
