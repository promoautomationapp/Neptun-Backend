import { canonicalAssetInput } from "../../modules/assets/image-input";
import {
  hasSuppliedModel,
  hasExactModelIdentifier,
  productIdentityText,
  productImageCandidateSchema,
  namedProductFamily,
} from "../../modules/ai/domain/product-image-search";
import type { ProductImageSearchInput } from "../../modules/ai/domain/product-image-search";
import type { JsonObject } from "../../shared/json";
import { downloadPublic, publicHttpsUrl } from "./public-download";

const missing = (reason: string) => ({
  json: { found: false, reason } as JsonObject,
});
function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/");
}
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [
      (match[1] ?? "").toLowerCase(),
      decodeHtml(match[2] ?? ""),
    ]),
  );
}
function identityMatches(
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
  const capacities = [
    ...[input.name, ...input.details]
      .join(" ")
      .matchAll(/\b\d+\s*(?:gb|tb)\b/gi),
  ].map((match) => match[0]);
  const colors =
    input.name.match(
      /\b(?:black|white|silver|gold|orange|blue|green|purple|pink|red|graphite|natural titanium|blu|zi|zezë|bardhë)\b/gi,
    ) ?? [];
  return [...capacities, ...colors].every((variant) =>
    hasExactModelIdentifier(text, variant),
  );
}
function productMainImages(
  html: string,
  input: ProductImageSearchInput,
  model: string,
): string[] {
  const images: string[] = [];
  const headings = [
    ...html.matchAll(/<(?:h1|title)\b[^>]*>([\s\S]*?)<\/(?:h1|title)\s*>/gi),
  ].map((match) => decodeHtml(match[1] ?? "").replace(/<[^>]*>/g, " "));
  if (headings.some((heading) => identityMatches(heading, input, model))) {
    for (const tag of html.match(/<(?:meta|img)\b[^>]*>/gi) ?? []) {
      const attrs = attributes(tag);
      if (attrs.property === "og:image" || attrs.name === "twitter:image") {
        if (attrs.content) images.push(attrs.content);
      } else if (attrs.itemprop === "image") {
        if (attrs.src || attrs.content)
          images.push(attrs.src ?? attrs.content ?? "");
      }
    }
  }
  // Product JSON-LD binds a declared photograph to its own exact identity,
  // excluding recommendation images merely occurring elsewhere on the page.
  let visited = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || visited++ > 200) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    const type = item["@type"];
    if (
      type === "Product" ||
      (Array.isArray(type) && type.includes("Product"))
    ) {
      const brand =
        item.brand && typeof item.brand === "object"
          ? (item.brand as Record<string, unknown>).name
          : item.brand;
      const properties = Array.isArray(item.additionalProperty)
        ? item.additionalProperty
        : [];
      const extraFacts = properties.flatMap((property) =>
        property && typeof property === "object"
          ? Object.values(property as Record<string, unknown>).filter(
              (part) => typeof part === "string",
            )
          : [],
      );
      const text = [item.name, item.model, item.sku, brand, ...extraFacts]
        .filter((part) => typeof part === "string")
        .join(" ");
      if (identityMatches(text, input, model)) {
        const imageValues = Array.isArray(item.image)
          ? item.image
          : [item.image];
        for (const image of imageValues) {
          if (typeof image === "string") images.push(image);
          else if (image && typeof image === "object") {
            const url =
              (image as Record<string, unknown>).contentUrl ??
              (image as Record<string, unknown>).url;
            if (typeof url === "string") images.push(url);
          }
        }
      }
    }
    Object.values(item).forEach((part) => visit(part, depth + 1));
  };
  for (const script of html.match(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi,
  ) ?? []) {
    try {
      visit(
        JSON.parse(
          script.replace(/^<script\b[^>]*>|<\/script\s*>$/gi, ""),
        ) as unknown,
      );
    } catch {
      /* Unreadable page metadata cannot establish a match. */
    }
  }
  return images;
}
/** The source page must be one consulted by web search, identify the supplied
 * exact model, and actually reference the selected photograph. */
export async function verifyProductImage(
  input: ProductImageSearchInput,
  output: unknown,
  consultedUrls: string[],
  download: typeof downloadPublic = downloadPublic,
) {
  const parsed = productImageCandidateSchema.safeParse(output);
  if (!parsed.success)
    return missing(
      "No verifiable exact product photo was found. Upload your own image.",
    );
  const candidate = parsed.data;
  if (!candidate.found)
    return missing(
      candidate.reason ||
        "No exact product photo was found. Upload your own image.",
    );
  if (!hasSuppliedModel(input, candidate))
    return missing(
      "The search did not identify the exact supplied model. Upload your own image.",
    );
  try {
    const sourceUrl = publicHttpsUrl(candidate.sourceUrl).href;
    const imageUrl = publicHttpsUrl(candidate.imageUrl).href;
    if (
      !consultedUrls.some((url) => {
        try {
          return publicHttpsUrl(url).href === sourceUrl;
        } catch {
          return false;
        }
      })
    )
      return missing(
        "The image source could not be verified. Upload your own image.",
      );
    const page = await download(sourceUrl, 2_000_000);
    if (!["text/html", "application/xhtml+xml"].includes(page.mimeType))
      return missing(
        "The product page could not be read. Upload your own image.",
      );
    const html = decodeHtml(page.bytes.toString("utf8"));
    const model = productIdentityText(candidate.matchedModel);
    const referenced = productMainImages(html, input, model).some(
      (reference) => {
        try {
          return new URL(reference, page.url).href === imageUrl;
        } catch {
          return false;
        }
      },
    );
    if (!referenced)
      return missing(
        "The exact product page did not confirm this as its main photo. Upload your own image.",
      );
    const image = await download(imageUrl, 12_000_000);
    if (
      ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
      ].includes(image.mimeType)
    )
      return missing(
        "The product photo format is unsupported. Upload your own image.",
      );
    const normalized = await canonicalAssetInput(image.bytes, image.mimeType);
    if ((normalized.width ?? 0) < 150 || (normalized.height ?? 0) < 150)
      return missing(
        "The verified photo is too small for the brochure. Upload your own image.",
      );
    return {
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
      json: {
        found: true,
        sourceUrl: page.url,
        imageUrl: image.url,
        matchedName: candidate.matchedName,
        matchedModel: candidate.matchedModel,
      } as JsonObject,
    };
  } catch {
    return missing(
      "The exact photo could not be safely downloaded. Upload your own image.",
    );
  }
}
