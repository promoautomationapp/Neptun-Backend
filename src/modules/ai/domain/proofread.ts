import { z } from "zod";
import { cacheKey } from "./request";
import type { JsonObject } from "../../../shared/json";
export const proofreadItemSchema = z.object({
  id: z.string().regex(/^f\d{1,5}$/),
  label: z.string().default(""),
  text: z.string().max(6000),
  brand: z.string().default(""),
});
export const proofreadRequestSchema = z
  .object({
    items: z.array(proofreadItemSchema).min(1).max(80),
    context: z
      .object({
        campaignType: z.string().optional(),
        campaignName: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (
      JSON.stringify(input.items).length > 50_000 ||
      new Set(input.items.map((item) => item.id)).size !== input.items.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose up to 80 unique short fields.",
      });
  });
export type ProofreadItem = z.infer<typeof proofreadItemSchema>;
export const suggestionSchema = z.object({
  suggested: z.string(),
  reason: z.string(),
});
export type ProofreadSuggestion = z.infer<typeof suggestionSchema>;
export interface ProofreadCheckRow {
  cache_key: string;
  status: "pending" | "completed" | "failed" | "uncertain";
  result_id: string;
  suggestion: ProofreadSuggestion | null;
}
export interface FieldCheck {
  key: string;
  item: ProofreadItem;
  input: JsonObject;
}
export function proofreadLabel(label: string): string {
  const parts = label.split(" · ");
  const role = parts.length >= 3 ? parts.slice(2).join(" · ") : label;
  return role
    .replace(/^(Product|Store)\s+\d+(?:\s*·)?\s*/i, "$1 ")
    .replace(/^Post copy\s+\d+$/i, "Post copy")
    .trim();
}
export function proofreadFields(
  org: string,
  params: JsonObject,
  model: string,
  promptVersion: string,
  regeneration?: string,
): FieldCheck[] {
  const request = proofreadRequestSchema.parse(params);
  return request.items.map((item) => {
    // Transient UI IDs, document field keys, batch order and unrelated fields are
    // absent. Preserve every semantic input used by the proofreading prompt.
    const input: JsonObject = {
      text: item.text,
      brand: item.brand,
      label: proofreadLabel(item.label),
      context: {
        campaignType: request.context?.campaignType?.slice(0, 100) ?? "",
        campaignName: request.context?.campaignName?.slice(0, 160) ?? "",
      },
    };
    return {
      item,
      input,
      key: cacheKey({
        organizationId: org,
        operation: "proofread",
        sourceSha256: null,
        params: input,
        model,
        quality: null,
        promptVersion,
        ...(regeneration ? { nonce: regeneration } : {}),
      }),
    };
  });
}
export function assembleProofread(
  fields: FieldCheck[],
  checks: Map<string, ProofreadCheckRow>,
): JsonObject {
  return {
    changes: fields.flatMap((field) => {
      const suggestion = checks.get(field.key)?.suggestion;
      return suggestion
        ? [{ id: field.item.id, original: field.item.text, ...suggestion }]
        : [];
    }),
  };
}
