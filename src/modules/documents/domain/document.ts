import { z } from "zod";
import {
  pageDecorationSchema,
  settingsColorSchema,
} from "../../settings/domain/settings.schema";
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
    mentions: z.array(z.string()).max(20).optional(),
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
    mentions: z.array(z.string()).max(20).optional(),
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
export const brochureFooterSchema = z.object({
  style: z.enum(["bar", "reference"]).optional(),
  visible: z.boolean().optional(),
  fadeEnd: z.boolean().optional(),
  showAwards: z.boolean().optional(),
  dateText: z.string().max(2000).optional(),
  bottom: z.number().min(0).max(80).optional(),
  height: z.number().min(2).max(12).optional(),
  dateWidth: z.number().min(15).max(55).optional(),
  dateSize: z.number().min(0.8).max(3.5).optional(),
  paymentSize: z.number().min(0.7).max(3).optional(),
  from: z
    .string()
    .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
    .optional(),
  to: z
    .string()
    .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
    .optional(),
});
export const pageArtworkSchema = z
  .object({
    layoutRole: z.literal("banner").optional(),
    referenceSource: z.string().max(500).optional(),
    referenceRole: z
      .enum(["person", "wifi", "inverter", "energy", "promotion"])
      .optional(),
    textRuns: z
      .array(
        z
          .object({
            text: z.string().max(2000),
            fontScale: z.number().min(0.1).max(5),
            verticalAlign: z.enum(["baseline", "super", "top"]).optional(),
            fontWeight: z.number().int().min(100).max(1000).optional(),
            fontStyle: z.enum(["normal", "italic"]).optional(),
            color: z
              .string()
              .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
              .optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    wordSpacing: z.number().min(-1).max(5).optional(),
    whiteSpace: z.enum(["nowrap", "pre-wrap"]).optional(),
    shapePath: z
      .string()
      .max(20000)
      .regex(/^[MmLlHhVvCcSsQqTtAaZzEe0-9.,+\s-]*$/)
      .optional(),
    fill: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
      .optional(),
    stroke: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
      .optional(),
    strokeWidth: z.number().min(0).max(10).optional(),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
      .optional(),
    textVerticalAlign: z.enum(["top", "center", "bottom"]).optional(),
    padding: z.number().min(0).max(10).optional(),
  })
  .catchall(jsonValue)
  .superRefine((artwork, context) => {
    if (artwork.layoutRole !== "banner") return;
    for (const [key, minimum, maximum] of [
      ["x", 0, 100],
      ["y", 0, 100],
      ["width", 1, 100],
      ["height", 1, 70],
    ] as const) {
      const value = artwork[key];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum
      )
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Banner ${key} must be between ${minimum} and ${maximum}.`,
        });
    }
  });
const brochureInstallmentSchema = z
  .object({
    amount: z.number().positive().finite(),
    count: z.number().int().min(1).max(60),
    sale: z.number().positive().finite(),
  })
  .strict();
const brochureSavingsSchema = z
  .object({
    value: z.number().positive().finite(),
    type: z.enum(["amount", "percentage"]),
    regular: z.number().positive().finite(),
    sale: z.number().positive().finite(),
  })
  .strict();
const documentProductSchema = jsonObject.superRefine((product, context) => {
  if (product.brochureSavings !== undefined) {
    const result = brochureSavingsSchema.safeParse(product.brochureSavings);
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({
          ...issue,
          path: ["brochureSavings", ...issue.path],
        });
  }
  if (product.productArtworks !== undefined) {
    const result = z
      .array(pageArtworkSchema)
      .max(200)
      .safeParse(product.productArtworks);
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({
          ...issue,
          path: ["productArtworks", ...issue.path],
        });
  }
  if (product.brochureInstallment === undefined) return;
  const result = brochureInstallmentSchema.safeParse(
    product.brochureInstallment,
  );
  if (!result.success)
    for (const issue of result.error.issues)
      context.addIssue({
        ...issue,
        path: ["brochureInstallment", ...issue.path],
      });
});
export const campaignSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(300),
    brochureFooter: brochureFooterSchema.optional(),
    brochurePresetId: z.string().max(100).optional(),
    brochureReferenceDesign: z
      .enum(["black-friday", "black-collection"])
      .optional(),
    coverBrandTagline: z.string().max(500).optional(),
    coverRibbonColors: z
      .object({
        from: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i),
        to: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i),
      })
      .optional(),
    brochureVisualStyle: z.enum(["current", "october"]).optional(),
    brandLogoMode: z.enum(["auto", "white", "dark", "original"]).optional(),
    brandLogoColor: settingsColorSchema.optional(),
    pageDecorationDefaults: pageDecorationSchema.optional(),
    pages: z
      .record(
        z.string(),
        pageDecorationSchema
          .extend({
            headerText: z.string().max(2000).optional(),
            footerNumber: z.string().max(40).optional(),
            showFooter: z.boolean().optional(),
            showFooterPageNumber: z.boolean().optional(),
          })
          .catchall(jsonValue),
      )
      .optional(),
    showFooterPageNumber: z.boolean().optional(),
    products: z.array(documentProductSchema).max(2000),
    showCoverBand: z.boolean().default(false),
    coverMessageColor: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
      .default("#ffffff"),
    coverHeadlineColor: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
      .default("#ffffff"),
    coverTypeColor: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
      .default("#ffffff"),
    coverFooterColor: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
      .default("#ffffff"),
    version: z.number().int().positive().optional(),
    disabledAt: z.iso.datetime().nullable().optional(),
    disabledBy: z.string().max(320).nullable().optional(),
    status: z.enum(statuses).optional(),
    reviewComments: z.array(commentSchema).default([]),
    reviewHistory: z.array(historySchema).default([]),
  })
  .catchall(jsonValue)
  .superRefine((campaign, context) => {
    if (campaign.pageArtworks === undefined) return;
    const result = z
      .record(z.string(), z.array(pageArtworkSchema).max(200))
      .safeParse(campaign.pageArtworks);
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({ ...issue, path: ["pageArtworks", ...issue.path] });
  });
export const postSchema = z
  .object({
    id: identifier,
    name: z.string().max(300).default("Social post"),
    products: z.array(documentProductSchema).max(12),
    version: z.number().int().positive().optional(),
    disabledAt: z.iso.datetime().nullable().optional(),
    disabledBy: z.string().max(320).nullable().optional(),
    reviewComments: z.array(commentSchema).optional(),
    reviewHistory: z.array(historySchema).optional(),
    status: z.enum(statuses).optional(),
    notificationLanguage: z.enum(["sq", "en"]).optional(),
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
