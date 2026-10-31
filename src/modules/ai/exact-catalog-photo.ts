import type { Database } from "../../database/database";
import type { Actor } from "../auth/domain/actor";
import {
  actorWorkspaceAccess,
  categoryScopeSql,
} from "../auth/domain/workspace-access";
import {
  hasExactModelIdentifier,
  hasSuppliedModel,
  namedProductFamily,
  productIdentityText,
  productImageSearchInputSchema,
  productPageIdentityMatches,
  productVariantFacts,
  type ProductImageSearchInput,
} from "./domain/product-image-search";

export interface CatalogPhotoIdentity {
  id: string;
  code: string;
  name: string;
  brand: string;
  model: string;
  specs: Record<string, string>;
  product_url: string;
  image_url: string;
  primary_asset_id: string;
}
export function exactCatalogPhotoMatches(
  input: ProductImageSearchInput,
  row: CatalogPhotoIdentity,
): boolean {
  const sameCode =
    productIdentityText(input.code) === productIdentityText(row.code);
  const suppliedModel = input.model || namedProductFamily(input.name) || "";
  const model = suppliedModel || row.model;
  const rowFacts = [
    row.name,
    row.brand,
    row.model,
    ...Object.entries(row.specs || {}).map(
      ([key, value]) => `${key}: ${value}`,
    ),
  ].join(" ");
  // A duplicate SKU can refer to a component and a promotional set. Require the
  // same identity scope and model/name even for an exact normalized SKU.
  const requestedBundle =
    input.bundle || /\b(?:bundle|set|pako|paket)\b|\s\+\s/i.test(input.name);
  const actualBundle = /\b(?:bundle|set|pako|paket)\b|\s\+\s/i.test(row.name);
  if (requestedBundle !== actualBundle) return false;
  if (
    !sameCode &&
    (!suppliedModel ||
      !hasExactModelIdentifier(row.model || row.name, suppliedModel))
  )
    return false;
  if (
    productIdentityText(input.brand) &&
    productIdentityText(input.brand) !== productIdentityText(row.brand)
  )
    return false;
  if (
    input.model &&
    row.model &&
    productIdentityText(input.model) !== productIdentityText(row.model)
  )
    return false;
  const requestedColors = productVariantFacts(input).filter(
    (fact) => !/\d/.test(fact),
  );
  const actualColors = productVariantFacts({
    ...input,
    name: row.name,
    model: row.model,
    variants: [],
    details: Object.entries(row.specs || {}).map(
      ([key, value]) => `${key}: ${value}`,
    ),
  }).filter((fact) => !/\d/.test(fact));
  if (
    requestedColors.length &&
    actualColors.some((color) => !requestedColors.includes(color))
  )
    return false;
  if (
    requestedBundle &&
    productIdentityText(input.name) !== productIdentityText(row.name)
  )
    return false;
  if (!model) {
    // Exact names permit non-numbered device families without inventing a model.
    return (
      sameCode &&
      productIdentityText(input.name) === productIdentityText(row.name) &&
      productPageIdentityMatches(rowFacts, input, input.name)
    );
  }
  if (
    !hasSuppliedModel(input, {
      found: true,
      reason: "",
      sourceUrl: "",
      imageUrl: "",
      matchedName: row.name,
      matchedModel: model,
      evidence: "",
    })
  )
    return false;
  return productPageIdentityMatches(rowFacts, input, model);
}
const publicUrl = (value: string) => /^https:\/\//i.test(value);

/** No provider command, asset import or write: reuse an already owned exact photo. */
export async function findExactCatalogPhoto(
  db: Database,
  actor: Actor,
  raw: unknown,
) {
  const access = actorWorkspaceAccess(actor);
  if (!access.canViewCatalog) return null;
  const input = productImageSearchInputSchema.parse(raw);
  const values: unknown[] = [
    actor.organizationId,
    productIdentityText(input.code),
    productIdentityText(input.model || namedProductFamily(input.name) || ""),
  ];
  const scope = categoryScopeSql(
    "p.category_path",
    access.catalogCategoryPaths,
    (value) => {
      values.push(value);
      return `$${values.length}`;
    },
  );
  const rows = await db.query<CatalogPhotoIdentity>(
    `SELECT p.id,p.code,p.name,p.brand,p.model,p.specs,p.product_url,p.primary_asset_id,COALESCE(pi.source_url,p.source->'imageUrls'->>0,'') image_url
     FROM products p JOIN assets a ON a.organization_id=p.organization_id AND a.id=p.primary_asset_id AND a.deleted_at IS NULL
     LEFT JOIN LATERAL (SELECT source_url FROM product_images WHERE organization_id=p.organization_id AND product_id=p.id AND asset_id=p.primary_asset_id ORDER BY position LIMIT 1) pi ON true
     WHERE p.organization_id=$1 AND p.deleted_at IS NULL AND a.mime_type IN ('image/png','image/jpeg','image/webp','image/avif')
       AND (p.code_normalized=$2 OR ($3<>'' AND lower(regexp_replace(p.model,'[^[:alnum:]]','','g'))=$3))${scope ? ` AND ${scope}` : ""}
     ORDER BY CASE WHEN p.code_normalized=$2 THEN 0 ELSE 1 END,p.id LIMIT 20`,
    values,
  );
  const row = rows.find(
    (candidate) =>
      exactCatalogPhotoMatches(input, candidate) &&
      publicUrl(candidate.product_url) &&
      publicUrl(candidate.image_url),
  );
  if (!row) return null;
  return {
    cached: true,
    status: "succeeded",
    resultId: row.primary_asset_id,
    result: {
      found: true,
      image: `/api/assets/${row.primary_asset_id}`,
      sourceUrl: row.product_url,
      imageUrl: row.image_url,
      matchedName: row.name,
      matchedModel:
        input.model ||
        namedProductFamily(input.name) ||
        row.model ||
        input.name,
      source: "catalog",
    },
  };
}
