import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonObject, JsonValue } from "../../../shared/json";
import { jsonObject } from "../../../shared/json";
export const operations = [
  "cutout",
  "brand_prep",
  "background",
  "proofread",
  "text_generate",
  "placement",
  "detect_screen",
  "lifestyle",
  "product_image_search",
] as const;
export type AiOperation = (typeof operations)[number];
export const aiRequestSchema = z.object({
  operation: z.enum(operations),
  params: jsonObject,
  regenerate: z.boolean().default(false),
});
export type AiRequest = z.infer<typeof aiRequestSchema>;
export interface AiResultRow {
  id: string;
  organization_id: string;
  operation: AiOperation;
  cache_key: string;
  model: string;
  quality: string | null;
  params_json: JsonObject;
  prompt_version: string;
  source_sha256: string | null;
  output_asset_id: string | null;
  output_text: string | null;
  output_json: JsonObject | null;
  status: "pending" | "completed" | "failed" | "uncertain";
  created_by: string | null;
}
export interface AiJobRow {
  id: string;
  organization_id: string;
  result_id: string;
  status:
    "queued" | "running" | "succeeded" | "failed" | "cancelled" | "uncertain";
  attempts: number;
  payload: JsonObject;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}
export type AiTicket = {
  cached: boolean;
  status: string;
  resultId: string;
  jobId?: string;
  result?: JsonObject;
};
export function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
      .join(",")}}`;
  return JSON.stringify(
    typeof value === "string" ? value.normalize("NFC").trim() : value,
  );
}
export function cacheKey(input: {
  organizationId: string;
  operation: AiOperation;
  sourceSha256: string | null;
  params: JsonObject;
  model: string;
  quality: string | null;
  promptVersion: string;
  nonce?: string;
}): string {
  return createHash("sha256")
    .update(stableJson({ ...input, nonce: input.nonce ?? null }))
    .digest("hex");
}
export function belgradeMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  return `${parts.find((x) => x.type === "year")?.value}-${parts.find((x) => x.type === "month")?.value}`;
}
export function isImageOperation(operation: AiOperation): boolean {
  return ["cutout", "brand_prep", "background", "lifestyle"].includes(
    operation,
  );
}
export const PROMPT_VERSION = "reference-2026-09-image-revision-3-v1";
export function promptVersion(operation: AiOperation): string {
  return operation === "product_image_search"
    ? "exact-product-web-image-v1"
    : PROMPT_VERSION;
}
