/** Neptun's own embedded webshop models are the source of truth. No rendered
 * price guessing: RegularPrice is retail; RatePrice is an instalment. */
export const NEPTUN_ORIGIN = "https://www.neptun-ks.com";
export function normalizeProductCode(value: unknown): string {
  return text(value);
}
export interface SiteObject {
  [key: string]: unknown;
  Category?: SiteObject;
  Manufacturer?: SiteObject;
  NavigationPath?: SiteObject[];
  Images?: SiteObject[];
  Products?: SiteObject[];
  CategoryFeatureGroups?: SiteObject[];
  Characteristics?: SiteObject[];
  Features?: SiteObject[];
  Values?: unknown[];
  ValuesAl?: unknown[];
}
export interface CategoryListing {
  url: string;
  path: string[];
  id?: number;
  parentId?: number;
}
export interface SourceProduct {
  code: string;
  name: string;
  brand: string;
  brandId: number;
  brandImageUrl: string;
  model: string;
  ean: string;
  category: string;
  subcategory: string;
  categoryPath: string;
  categoryId: number;
  description: string;
  warranty: string;
  regular: number | null;
  sale: number | null;
  currency: string;
  specs: Record<string, string>;
  availability: string;
  url: string;
  imageUrls: string[];
  fingerprint: string;
  detailCheckedAt?: string;
}
export function decodeHtml(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (_whole, key: string) => {
      if (key[0] === "#") {
        const n =
          key[1]?.toLowerCase() === "x"
            ? parseInt(key.slice(2), 16)
            : parseInt(key.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      }
      return (
        (
          {
            amp: "&",
            quot: '"',
            apos: "'",
            lt: "<",
            gt: ">",
            nbsp: " ",
          } as Record<string, string>
        )[key.toLowerCase()] ?? ""
      );
    },
  );
}
export function text(value: unknown): string {
  return decodeHtml(
    String(value ?? "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .trim();
}
const norm = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
export function normalizeHierarchy(
  value: string | string[],
  fallbackCategory = "",
  fallbackSubcategory = "",
): string[] {
  const values = Array.isArray(value) ? value : value.split(/\s*>\s*/);
  const cleaned = values
    .map((v) =>
      text(v)
        .replace(/^[\s•·\-*–—]+/, "")
        .trim(),
    )
    .filter(Boolean);
  const result: string[] = [];
  for (const label of cleaned) {
    if (/^(?:shtepia|home|ballina|produktet)$/i.test(norm(label))) continue;
    if (norm(result.at(-1) ?? "") !== norm(label)) result.push(label);
  }
  if (!result.length)
    for (const value of [fallbackCategory, fallbackSubcategory]) {
      const label = text(value)
        .replace(/^[\s•·\-*–—]+/, "")
        .trim();
      if (
        label &&
        !/^(?:shtepia|home|ballina|produktet)$/i.test(norm(label)) &&
        norm(result.at(-1) ?? "") !== norm(label)
      )
        result.push(label);
    }
  return result;
}
function attr(markup: string, key: string): string {
  return decodeHtml(
    markup
      .match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))
      ?.slice(1)
      .find((v) => v !== undefined) ?? "",
  );
}
export function embeddedModel(html: string, name: string): SiteObject {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`\\bdata-${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  if (!match) throw new Error(`Neptun page has no ${name} model.`);
  const model = JSON.parse(decodeHtml(match[1] ?? match[2] ?? ""));
  if (!model || typeof model !== "object" || Array.isArray(model))
    throw new Error("Invalid Neptun model.");
  return model;
}
export function siteUrl(value: unknown): string {
  const url = new URL(String(value ?? ""), NEPTUN_ORIGIN);
  if (
    url.protocol !== "https:" ||
    !["www.neptun-ks.com", "neptun-ks.com"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Untrusted Neptun URL.");
  url.hostname = "www.neptun-ks.com";
  url.hash = "";
  return url.href;
}
/** Walk actual nested <li> structure, keeping any depth; brand/support links
 * are outside the category lists and deliberately excluded. */
export function discoverCategories(html: string): CategoryListing[] {
  const menu = html.match(
    /<nav\b[^>]*id=["']mainNMenu["'][^>]*>([\s\S]*?)<\/nav>/i,
  )?.[1];
  if (!menu) throw new Error("Neptun product navigation could not be read.");
  const explicitProductRoot = /\bid=["']webshop_root["']/i.test(menu);
  const stack: { label: string; category: boolean; inProducts: boolean }[] = [];
  const listings: CategoryListing[] = [];
  const tokens = menu.match(/<[^>]+>|[^<]+/g) ?? [];
  let reading = false;
  let anchor = "";
  let label = "";
  for (const token of tokens) {
    if (/^<li\b/i.test(token)) {
      stack.push({
        label: "",
        category: !/^<li[^>]*class=["'][^"']*(?:menuBrand|banner)/i.test(token),
        inProducts:
          !explicitProductRoot ||
          stack.at(-1)?.inProducts === true ||
          attr(token, "id") === "webshop_root",
      });
    } else if (/^<\/li/i.test(token)) {
      stack.pop();
    } else if (/^<a\b/i.test(token)) {
      reading = true;
      anchor = token;
      label = "";
    } else if (/^<\/a/i.test(token) && reading) {
      reading = false;
      const current = stack.at(-1);
      const cleaned = text(label)
        .replace(/^[\s•·\-*–—]+/, "")
        .trim();
      const href = attr(anchor, "href");
      if (
        current &&
        current.inProducts &&
        cleaned &&
        (attr(anchor, "data-label-parent") ||
          (/\.nspx(?:\?|$)/i.test(href) &&
            !/manufacturers|login|promot|news|content|happy|servis|service|outlet|green/i.test(
              href,
            )))
      ) {
        current.label = cleaned;
        if (href) {
          const url = siteUrl(href);
          const path = normalizeHierarchy(
            stack.map((x) => x.label).filter(Boolean),
          );
          if (path.length) listings.push({ url, path });
        }
      }
    } else if (reading && !token.startsWith("<")) {
      label += token;
    }
  }
  return [...new Map(listings.map((x) => [x.url, x])).values()];
}
export interface SourceBrand {
  id: number;
  name: string;
  sourceImageUrl: string;
}
export function discoverBrands(html: string): SourceBrand[] {
  const brands = new Map<number, SourceBrand>();
  for (const match of html.matchAll(
    /(<a\b[^>]*href=["'][^"']*manufacturer-products\.nspx[^>]*>)([\s\S]*?)<\/a>/gi,
  )) {
    const href = attr(match[1]!, "href");
    const image = match[2]!.match(/<img\b[^>]*>/i)?.[0];
    if (!image) continue;
    const id = Number(new URL(siteUrl(href)).searchParams.get("manId"));
    const name = text(attr(image, "alt") || attr(match[1]!, "title"));
    const source = attr(image, "src");
    if (!id || !name || !source) continue;
    const url = new URL(siteUrl(source));
    url.searchParams.delete("width");
    url.searchParams.delete("height");
    brands.set(id, { id, name, sourceImageUrl: url.href });
  }
  return [...brands.values()];
}
function retail(value: unknown): number | null {
  const result = Number(value);
  return value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(result) &&
    result >= 0
    ? result
    : null;
}
export function productModel(
  model: SiteObject,
  fallbackPath: string[],
  fingerprint = "",
): SourceProduct {
  const rawPath = Array.isArray(model.NavigationPath)
    ? model.NavigationPath.map((x: SiteObject) =>
        String(x.NameAl || x.NameEn || x.Name || ""),
      )
    : fallbackPath;
  const path = normalizeHierarchy(rawPath);
  const leaf = text(model.Category?.NameAl || model.Category?.Name || "");
  if (leaf && norm(path.at(-1) ?? "") !== norm(leaf)) path.push(leaf);
  const code = text(model.CodeNumber);
  const name = text(model.Title);
  if (!code || !name)
    throw new Error("Neptun product is missing its stable code or name.");
  const specs: Record<string, string> = {};
  const short = String(
    model.ShortDescriptionAl ||
      model.ShortDescription ||
      model.DescriptionAl ||
      model.Description ||
      "",
  );
  for (const line of short.replace(/<br\s*\/?\s*>/gi, "\n").split(/[\r\n]+/)) {
    const cleaned = text(line).replace(/^\*\s*/, "");
    if (!cleaned) continue;
    const colon = cleaned.indexOf(":");
    if (colon > 0)
      specs[cleaned.slice(0, colon).trim()] = cleaned.slice(colon + 1).trim();
    else specs[cleaned] = "";
  }
  for (const group of model.CategoryFeatureGroups ?? [])
    for (const feature of group.Features ?? []) {
      const title = text(feature.TitleAl || feature.Title || feature.TitleEn);
      const values = (
        feature.ValuesAl?.length ? feature.ValuesAl : (feature.Values ?? [])
      )
        .map((x: unknown) =>
          text(
            typeof x === "object"
              ? (x as SiteObject)?.ValueAl || (x as SiteObject)?.Value || ""
              : x,
          ),
        )
        .filter(Boolean);
      if (title && values.length) specs[title] = values.join(", ");
    }
  for (const feature of model.Characteristics ?? []) {
    const title = text(feature.Title || feature.Name);
    const value = text(feature.Value || feature.Description);
    if (title && value) specs[title] = value;
  }
  const imageUrls = [
    ...new Set(
      [
        model.Thumbnail,
        ...(model.Images ?? []).map(
          (x: SiteObject) => x.RelativePath || x.url || x.Url,
        ),
      ]
        .filter(Boolean)
        .map(siteUrl),
    ),
  ].slice(0, 20);
  const warrantyMonths = Number(model.Warranty);
  const warranty =
    Number.isFinite(warrantyMonths) && warrantyMonths > 0
      ? `${Number((warrantyMonths / 12).toFixed(2))} ${warrantyMonths === 12 ? "vit" : "vite"}`
      : "";
  const categoryUrl = String(model.Category?.Url || "");
  const slug = String(model.Url || "");
  const url = siteUrl(
    slug.startsWith("/") ? slug : `/categories/${categoryUrl}/${slug}`,
  );
  return {
    code,
    name,
    brand: text(model.Manufacturer?.Name),
    brandId: Number(model.Manufacturer?.Id) || 0,
    brandImageUrl: model.Manufacturer?.Logo
      ? siteUrl(model.Manufacturer.Logo)
      : "",
    model: text(model.ModelNumber || model.ProductCode),
    ean: text(model.Barcode),
    category: path[0] ?? leaf,
    subcategory: path.at(-1) ?? leaf,
    categoryPath: path.join(" > "),
    categoryId: Number(model.Category?.Id) || 0,
    description: text(short),
    warranty,
    regular: retail(model.RegularPrice),
    sale: retail(model.ActualPrice),
    currency: text(model.Currency) || "EUR",
    specs,
    availability:
      model.AvailableWebshop === false || model.Active === false
        ? "out_of_stock"
        : "in_stock",
    url,
    imageUrls,
    fingerprint,
  };
}
export interface SourceTransport {
  get(url: string): Promise<string>;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const siteTransport: SourceTransport = {
  async get(value) {
    const url = siteUrl(value);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
          headers: {
            "User-Agent": "NeptunCampaignCatalog/1.0",
            Accept: "text/html",
          },
        });
        if (!response.ok)
          throw new Error(`Neptun source returned ${response.status}.`);
        if (Number(response.headers.get("content-length")) > 6_000_000)
          throw new Error("Neptun page is oversized.");
        const value = await response.text();
        if (value.length > 6_000_000)
          throw new Error("Neptun page is oversized.");
        return value;
      } catch (error) {
        if (attempt === 2) {
          if (error instanceof Error && error.name === "TimeoutError")
            throw new Error(
              "Neptun did not respond in time. The existing catalog is kept; try again later.",
            );
          throw error;
        }
        await wait(400 * (attempt + 1));
      }
    }
    throw new Error("Neptun source unavailable.");
  },
};
export async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (cursor < items.length && !failure) {
        const index = cursor++;
        try {
          await operation(items[index]!, index);
        } catch (error) {
          failure ??=
            error instanceof Error
              ? error
              : new Error("Catalog operation failed.");
        }
      }
    }),
  );
  // Drain every in-flight operation before releasing the run lock. A retry must
  // never overlap writes from a previous, failed crawl.
  if (failure) throw failure;
}

export function healthyFullCrawl(
  previousCount: number,
  seenCount: number,
  failedListings: number,
): boolean {
  return (
    failedListings === 0 &&
    seenCount > 0 &&
    (previousCount === 0 ||
      seenCount >= Math.max(1, Math.floor(previousCount * 0.85)))
  );
}
