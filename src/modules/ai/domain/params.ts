import { z } from "zod";
import { jsonObject } from "../../../shared/json";
import type { JsonObject } from "../../../shared/json";
import type { AiOperation } from "./request";
import { proofreadRequestSchema, proofreadLabel } from "./proofread";
import { productImageSearchInputSchema } from "./product-image-search";
export const imageInputSchema = z.object({
  image: z.string().min(1),
  orientation: z.enum(["portrait", "landscape", "square"]).optional(),
  name: z
    .string()
    .max(6000)
    .transform((value) => value.slice(0, 160))
    .optional(),
  brand: z
    .string()
    .max(6000)
    .transform((value) => value.slice(0, 80))
    .optional(),
  category: z
    .string()
    .max(6000)
    .transform((value) => value.slice(0, 100))
    .optional(),
  description: z.string().max(20000).optional(),
  screenType: z.string().optional(),
  screenInches: z.number().nullable().optional(),
  backgroundContext: z
    .object({
      kind: z.string(),
      image: z.string().optional(),
      color: z.string().optional(),
      description: z.string().optional(),
      gradient: z
        .object({ from: z.string(), to: z.string(), angle: z.number() })
        .optional(),
    })
    .optional(),
});
export const backgroundInputSchema = z.object({
  image: z.string().min(1).optional(),
  prompt: z.string().max(1000).default(""),
  products: z
    .array(
      z.object({ name: z.string().max(6000), category: z.string().optional() }),
    )
    .max(6)
    .default([]),
  context: z.string().optional(),
  orientation: z.string().optional(),
});
export const textInputSchema = z.object({
  text: z.string().min(1).max(6000),
  instruction: z
    .string()
    .max(1000)
    .default("Correct the text while preserving its meaning and language."),
});
/** Keep cache identities tied to provider inputs. UI positions, prices, product
 * image choices, request IDs and other editor metadata do not affect AI output. */
export function normalizeAiParams(
  operation: AiOperation,
  params: JsonObject,
): JsonObject {
  if (operation === "product_image_search")
    return jsonObject.parse(productImageSearchInputSchema.parse(params));
  if (operation === "proofread") {
    const input = proofreadRequestSchema.parse(params);
    return jsonObject.parse({
      ...input,
      items: input.items.map((item) => ({
        ...item,
        label: proofreadLabel(item.label),
      })),
    });
  }
  if (operation === "text_generate")
    return jsonObject.parse(textInputSchema.parse(params));
  if (operation === "background" || operation === "lifestyle") {
    const input = backgroundInputSchema.parse(params);
    return {
      prompt: input.prompt.trim(),
      ...(input.image ? { image: input.image } : {}),
      context: input.context === "brochure" ? "brochure" : input.context === "tv" ? "tv" : "social",
      orientation: ["portrait", "landscape"].includes(input.orientation ?? "")
        ? (input.orientation ?? "square")
        : "square",
      products: input.products.map((product) => ({
        name: product.name.slice(0, 120),
        category: product.category?.slice(0, 80) ?? "",
      })),
    };
  }
  const input = imageInputSchema.parse(params);
  if (operation === "brand_prep")
    return {
      image: input.image,
      brand: input.brand?.trim().toUpperCase() ?? "",
    };
  if (operation === "detect_screen") return { image: input.image };
  if (operation === "placement")
    return { image: input.image, name: input.name ?? "product" };
  return jsonObject.parse(input);
}
