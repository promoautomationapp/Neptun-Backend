import { z } from "zod";

export const productImageSearchInputSchema = z.object({
  code: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(600),
  brand: z.string().trim().max(100).default(""),
  details: z.array(z.string().trim().max(600)).max(30).default([]),
  category: z.string().trim().max(160).default(""),
});
export type ProductImageSearchInput = z.infer<
  typeof productImageSearchInputSchema
>;
export const productImageCandidateSchema = z.object({
  found: z.boolean(),
  reason: z.string().max(600),
  sourceUrl: z.string().max(2048),
  imageUrl: z.string().max(2048),
  matchedName: z.string().max(600),
  matchedModel: z.string().max(160),
  evidence: z.string().max(1200),
});
export type ProductImageCandidate = z.infer<typeof productImageCandidateSchema>;

export const productIdentityText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export function hasExactModelIdentifier(text: string, model: string): boolean {
  const characters = [...productIdentityText(model)].map((character) =>
    character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${characters.join("[\\s\\-_/]*")}(?:$|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text.normalize("NFKC"));
}
export function namedProductFamily(name: string): string | undefined {
  return name.match(
    /\b(?:iphone\s*\d+e?(?:\s*(?:pro|max|plus|mini|air)){0,2}|galaxy\s*[asz]\s*\d+(?:[a-z](?![a-z]))?(?:\s*(?:ultra|plus|fe))?)/i,
  )?.[0];
}

/** An Excel catalog code is often an internal SKU. Require a specific model
 * identifier actually supplied in its name or code, never one invented by AI. */
export function hasSuppliedModel(
  input: ProductImageSearchInput,
  candidate: ProductImageCandidate,
): boolean {
  const model = productIdentityText(candidate.matchedModel);
  const namedFamily = namedProductFamily(input.name);
  if (
    namedFamily &&
    productIdentityText(namedFamily).includes(model) &&
    productIdentityText(namedFamily) !== model
  )
    return false;
  return (
    model.length >= 4 &&
    /\p{L}/u.test(model) &&
    /\p{N}/u.test(model) &&
    !/^\d+(?:gb|tb|w|kg|hz|inch|btu|mah)$/i.test(model) &&
    [input.code, input.name].some((text) =>
      hasExactModelIdentifier(text, model),
    )
  );
}
