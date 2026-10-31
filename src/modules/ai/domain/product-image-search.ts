import { z } from "zod";

export const productImageSearchInputSchema = z.object({
  code: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(600),
  brand: z.string().trim().max(100).default(""),
  details: z.array(z.string().trim().max(600)).max(30).default([]),
  category: z.string().trim().max(160).default(""),
  model: z.string().trim().max(160).default(""),
  ean: z.string().trim().max(40).default(""),
  subcategory: z.string().trim().max(160).default(""),
  sourceUrl: z.string().trim().max(2048).default(""),
  variants: z.array(z.string().trim().max(160)).max(12).default([]),
  bundle: z.boolean().default(false),
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
    /\b(?:iphone\s*\d+e?(?:\s*(?:pro|max|plus|mini|air)){0,2}|galaxy\s*[asz]\s*\d+(?:[a-z](?![a-z]))?(?:\s*(?:ultra|plus|fe))?|free\s*buds\s*(?:(?:se|pro)\s*)?\d+[a-z]?|free\s*clip(?:\s*2)?|air\s*pods\s*(?:(?:pro|max)(?:\s*\d+)?|\d+))/i,
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
    (/\p{N}/u.test(model) ||
      productIdentityText(namedFamily || "") === model ||
      (Boolean(input.model) &&
        productIdentityText(input.model) === model &&
        !/^(?:soundbar|headphones|earbuds|smartphone|television|laptop|tablet|accessories|black|white|beige)$/i.test(
          model,
        ))) &&
    !/^\d+(?:gb|tb|w|kg|hz|inch|btu|mah|k(?:uhd)?|uhd|fullhd)$/i.test(model) &&
    [
      input.code,
      input.name,
      input.model,
      ...input.details.filter((detail) =>
        /^(?:model|modeli|mpn|manufacturer part number)\s*:/i.test(detail),
      ),
    ].some((text) => hasExactModelIdentifier(text, model))
  );
}

const colorGroups = [
  ["black", "zi", "zezë", "zeze"],
  ["white", "bardhë", "bardhe"],
  ["beige", "bej"],
  ["gray", "grey", "gri"],
  ["silver", "argjendtë", "argjendte"],
  ["blue", "blu", "kaltër", "kalter"],
  ["green", "gjelbër", "gjelber"],
  ["purple", "vjollcë", "vjollce"],
  ["pink", "rozë", "roze"],
  ["orange", "portokalli"],
  ["red", "kuqe"],
  ["gold", "artë", "arte"],
  ["graphite"],
  ["natural titanium"],
];
export const imageIdentityText = (input: ProductImageSearchInput): string =>
  [input.name, input.model, ...input.details, ...input.variants].join(" ");
export function productVariantFacts(input: ProductImageSearchInput): string[] {
  const text = [
    input.name,
    ...input.variants,
    ...input.details.filter((detail) =>
      /^(?:(?:storage|capacity|memor\w*|ram|ssd|colou?r|ngjyra)\s*:|\d+(?:[.,]\d+)?\s*(?:gb|tb)\b)/i.test(
        detail,
      ),
    ),
  ].join(" ");
  // Color facts must be explicitly supplied in the name, selected variant, or a
  // named color field; descriptions often list every available color.
  const colorText = [
    input.name,
    ...input.variants,
    ...input.details.filter((detail) =>
      /^(?:colou?r|ngjyra)\s*:/i.test(detail),
    ),
  ].join(" ");
  const colors = colorGroups
    .filter((group) =>
      group.some((color) => hasExactModelIdentifier(colorText, color)),
    )
    .map((group) => group[0]!);
  const editionText = [
    input.name,
    ...input.variants,
    ...input.details.filter((detail) =>
      /^(?:noise cancellation|noise cancelling|anc|connector|charging port|connection|usb)\s*:/i.test(
        detail,
      ),
    ),
  ].join(" ");
  const editions = [
    /\bANC\b|active noise cancell?ation/i.test(editionText)
      ? /\b(?:without|no|pa)\s+(?:ANC|active noise cancell?ation)\b|\bnon[- ]?ANC\b/i.test(
          editionText,
        )
        ? "without ANC"
        : "ANC"
      : "",
    /\b(?:USB|Type)[- ]?C\b/i.test(editionText) ? "USB-C" : "",
    /\blightning\b/i.test(editionText) ? "Lightning" : "",
  ].filter(Boolean);
  return [
    ...new Set([
      ...colors,
      ...editions,
      ...[...text.matchAll(/\b\d+(?:[.,]\d+)?\s*(?:gb|tb)\b/gi)].map(
        (match) => match[0],
      ),
    ]),
  ];
}
export function matchesProductVariant(text: string, fact: string): boolean {
  const withoutAnc =
    /\b(?:without|no|pa)\s+(?:ANC|active noise cancell?ation)\b|\bnon[- ]?ANC\b|\b(?:ANC|(?:active )?noise cancell?ation)\s*:?\s*(?:false|no|off|disabled)\b/i.test(
      text,
    );
  if (fact === "ANC")
    return !withoutAnc && /\bANC\b|active noise cancell?ation/i.test(text);
  if (fact === "without ANC") return withoutAnc;
  if (fact === "USB-C")
    return (
      /\b(?:USB|Type)[- ]?C\b/i.test(text) &&
      !/\b(?:without|no|pa)\s+(?:USB|Type)[- ]?C\b|\b(?:USB|Type)[- ]?C\s*:?\s*(?:false|no|off|disabled)\b/i.test(
        text,
      )
    );
  const group = colorGroups.find((colors) => colors[0] === fact);
  return (group || [fact]).some((alias) =>
    hasExactModelIdentifier(text, alias),
  );
}
export function isProductColorFact(fact: string): boolean {
  return colorGroups.some((group) => group[0] === fact);
}
export function productPageIdentityMatches(
  text: string,
  input: ProductImageSearchInput,
  model: string,
): boolean {
  if (
    !hasExactModelIdentifier(text, model) ||
    (input.brand &&
      !productIdentityText(text).includes(productIdentityText(input.brand)))
  )
    return false;
  const family = namedProductFamily(input.name);
  if (family && !hasExactModelIdentifier(text, family)) return false;
  if (
    (input.bundle ||
      /bundle|\b(?:set|pako|paket)\b|\s\+\s/i.test(input.name)) &&
    !/bundle|\b(?:set|pako|paket)\b|\s\+\s/i.test(text)
  )
    return false;
  return productVariantFacts(input).every((fact) =>
    matchesProductVariant(text, fact),
  );
}

/** Query hints supplement rather than replace the exact input used by validation. */
export function productImageSearchQueries(
  input: ProductImageSearchInput,
): string[] {
  const model = input.model || namedProductFamily(input.name) || input.name;
  const variants = productVariantFacts(input).join(" ");
  return [
    ...new Set(
      [
        input.sourceUrl,
        `${input.brand} ${model} ${variants} ${input.bundle ? "bundle" : ""} official product image`,
        `${input.brand} ${input.name} ${variants} ${input.subcategory || input.category}`,
        `${input.brand} ${input.code} ${input.ean} ${model}`,
      ]
        .map((query) => query.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ].slice(0, 4);
}

export function productImageSearchCacheIdentity(
  input: ProductImageSearchInput,
) {
  // Category placement and a category-specific page URL do not create a new
  // product. Keep all supplied identifying facts and bundle scope in the key.
  return {
    code: productIdentityText(input.code),
    name: productIdentityText(input.name),
    brand: productIdentityText(input.brand),
    model: productIdentityText(input.model),
    ean: input.ean,
    bundle: input.bundle,
    details: [...input.details]
      .map((value) => value.normalize("NFKC").trim())
      .sort(),
    variants: [...input.variants].map(productIdentityText).sort(),
  };
}
