import { Inject, Injectable } from "@nestjs/common";
import { Database } from "../../database/database";
import type { JsonObject } from "../../shared/json";
import { normalizeSearch, searchWords, isPhoneQuery } from "./domain/search";
import { assetUrl } from "../assets/asset-ingest";

export interface ProductView {
  id: string;
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
  sourceMissing: boolean;
  sourceLastSeenAt: string | null;
  sourceMissingSince: string | null;
  description: string;
  warranty: string;
  regular: number | null;
  currency: string;
  specs: JsonObject;
  availability: string;
  url: string;
  image: string;
  localImage: string;
  imageUrl: string;
  thumbnail: string;
  preview: string;
  images: string[];
}
interface ProductRow {
  id: string;
  code: string;
  name: string;
  brand: string;
  model: string;
  ean: string;
  category: string;
  subcategory: string;
  category_path: string;
  source_missing: boolean;
  source_last_seen_at: Date | null;
  source_missing_since: Date | null;
  description: string;
  warranty: string;
  regular: string | null;
  currency: string;
  specs: JsonObject;
  availability: string;
  product_url: string;
  primary_asset_id: string | null;
  source_image_url: string | null;
  source_brand_id: number | null;
  source_brand_image_url: string | null;
  brand_asset_id: string | null;
  thumbnail_id: string | null;
  preview_id: string | null;
  image_ids: string[] | null;
}
export interface ProductFilters {
  q: string;
  code: string;
  category: string;
  subcategory: string;
  categoryPath?: string;
  brand: string;
  limit: number;
  offset: number;
}
const projection = `p.id,p.code,p.name,p.brand,p.model,p.ean,p.category,p.subcategory,p.category_path,p.description,p.warranty,p.source_missing,p.source_last_seen_at,p.source_missing_since,
  p.regular,p.currency,p.specs,p.availability,p.product_url,p.primary_asset_id,p.source->'imageUrls'->>0 source_image_url,brand_source.source_id source_brand_id,brand_source.source_url source_brand_image_url,brand_source.asset_id brand_asset_id,
  thumb.asset_id thumbnail_id,preview.asset_id preview_id,
  NULL::text[] image_ids`;
const variants = `LEFT JOIN LATERAL (SELECT source_id,source_url,asset_id FROM catalog_source_brands WHERE organization_id=p.organization_id AND lower(name)=lower(p.brand) ORDER BY last_seen_at DESC LIMIT 1) brand_source ON true
 LEFT JOIN asset_variants thumb ON thumb.organization_id=p.organization_id AND thumb.source_asset_id=p.primary_asset_id AND thumb.variant='thumbnail' AND thumb.transform_version=1
  LEFT JOIN asset_variants preview ON preview.organization_id=p.organization_id AND preview.source_asset_id=p.primary_asset_id AND preview.variant='preview' AND preview.transform_version=1`;
@Injectable()
export class ProductsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}
  async list(organizationId: string, filters: ProductFilters) {
    const values: unknown[] = [organizationId];
    const where = ["p.organization_id=$1", "p.deleted_at IS NULL"];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    for (const field of ["category", "subcategory", "brand"] as const)
      if (filters[field]) where.push(`p.${field}=${bind(filters[field])}`);
    if (filters.categoryPath) {
      const exact = bind(filters.categoryPath);
      const prefix = bind(
        filters.categoryPath.replace(/[\\%_]/g, "\\$&") + " > %",
      );
      where.push(
        `(p.category_path=${exact} OR p.category_path LIKE ${prefix})`,
      );
    }
    if (filters.code)
      where.push(
        `p.code ILIKE ${bind(`%${filters.code.replace(/[\\%_]/g, "\\$&")}%`)}`,
      );
    let ranking = "p.name,p.id";
    const dense = normalizeSearch(filters.q);
    if (dense) {
      const term = bind(dense);
      const original = bind(filters.q.trim());
      const words = searchWords(filters.q);
      const allWords =
        words
          .map((word) => {
            const term = bind(word);
            return word.length >= 3
              ? `(p.search_text LIKE '%'||${term}||'%' OR ${term} <% p.name_tokens)`
              : `p.search_text LIKE '%'||${term}||'%'`;
          })
          .join(" AND ") || "false";
      const phone = isPhoneQuery(filters.q)
        ? " OR lower(p.subcategory) ~ 'smartphone|mobile.?phone|celular'"
        : "";
      where.push(
        `(p.code=${original} OR p.ean=${original} OR p.search_text LIKE '%'||${term}||'%' OR (${allWords})${phone})`,
      );
      ranking = `CASE WHEN p.code_normalized=${term} OR (p.ean<>'' AND p.ean_normalized=${term}) THEN 0
        WHEN p.code_normalized LIKE ${term}||'%' THEN 1 WHEN p.name_normalized=${term} THEN 2
        WHEN p.name_normalized LIKE ${term}||'%' THEN 3 WHEN p.search_text LIKE '%'||${term}||'%' THEN 4 ELSE 5 END,
        similarity(p.name_normalized,${term}) DESC,p.name,p.id`;
    }
    const clause = where.join(" AND ");
    const [counts, rows] = await this.db.transaction(async (client) => {
      await client.query("SET LOCAL pg_trgm.word_similarity_threshold=0.4");
      const counts = await client.query<{ count: string }>(
        `SELECT count(*) count FROM products p WHERE ${clause}`,
        values,
      );
      const rows = await client.query<ProductRow>(
        `SELECT ${projection} FROM products p ${variants} WHERE ${clause} ORDER BY ${ranking} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, filters.limit, filters.offset],
      );
      return [counts.rows, rows.rows] as const;
    });
    const total = Number(counts[0]?.count ?? 0);
    return {
      products: rows.map((row) => this.view(row)),
      total,
      count: total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset:
        filters.offset + rows.length < total
          ? filters.offset + rows.length
          : null,
    };
  }
  async batch(organizationId: string, codes: string[]): Promise<ProductView[]> {
    if (!codes.length) return [];
    const rows = await this.db.query<ProductRow>(
      `SELECT ${projection} FROM products p ${variants} WHERE p.organization_id=$1 AND p.code=ANY($2::text[]) AND p.deleted_at IS NULL`,
      [organizationId, codes],
    );
    const images = await this.db.query<{
      product_id: string;
      image_ids: string[];
    }>(
      "SELECT product_id,array_agg(asset_id::text ORDER BY position) image_ids FROM product_images WHERE organization_id=$1 AND product_id=ANY($2::uuid[]) GROUP BY product_id",
      [organizationId, rows.map((x) => x.id)],
    );
    const byProduct = new Map(images.map((x) => [x.product_id, x.image_ids]));
    return rows.map((row) =>
      this.view({ ...row, image_ids: byProduct.get(row.id) ?? [] }),
    );
  }
  async facets(organizationId: string) {
    const [rows, sourceRows] = await Promise.all([
      this.db.query<{
        category: string;
        subcategory: string;
        brand: string;
        categoryPath: string;
      }>(
        `SELECT DISTINCT category,subcategory,brand,category_path "categoryPath" FROM products WHERE organization_id=$1 AND deleted_at IS NULL`,
        [organizationId],
      ),
      this.db.query<{
        id: number;
        parentId: number;
        name: string;
        categoryPath: string;
        url: string;
        lastSeenAt: Date;
      }>(
        `SELECT source_id id,parent_source_id "parentId",name,path "categoryPath",source_url url,last_seen_at "lastSeenAt" FROM catalog_source_categories WHERE organization_id=$1 ORDER BY path,source_id`,
        [organizationId],
      ),
    ]);
    return {
      categories: [...new Set(rows.map((x) => x.category))].sort(),
      brands: [...new Set(rows.map((x) => x.brand).filter(Boolean))].sort(),
      paths: rows,
      // The website menu also contains empty branches. Do not derive its tree
      // only from products or legacy product-category labels.
      sourceCategories: sourceRows.map((row) => ({
        ...row,
        path: row.categoryPath.split(" > ").filter(Boolean),
        lastSeenAt: row.lastSeenAt.toISOString(),
      })),
    };
  }
  private view(row: ProductRow): ProductView {
    const original = row.primary_asset_id
      ? assetUrl(row.primary_asset_id)
      : (row.source_image_url ?? "");
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      brand: row.brand,
      brandId: row.source_brand_id ?? 0,
      brandImageUrl: row.brand_asset_id
        ? assetUrl(row.brand_asset_id)
        : (row.source_brand_image_url ?? ""),
      model: row.model,
      ean: row.ean,
      category: row.category,
      subcategory: row.subcategory,
      categoryPath: row.category_path,
      sourceMissing: row.source_missing,
      sourceLastSeenAt: row.source_last_seen_at?.toISOString() ?? null,
      sourceMissingSince: row.source_missing_since?.toISOString() ?? null,
      description: row.description,
      warranty: row.warranty,
      regular: row.regular === null ? null : Number(row.regular),
      currency: row.currency,
      specs: row.specs,
      availability: row.availability,
      url: row.product_url,
      image: original,
      imageUrl: original,
      localImage: row.primary_asset_id ? original : "",
      thumbnail: row.thumbnail_id ? assetUrl(row.thumbnail_id) : original,
      preview: row.preview_id ? assetUrl(row.preview_id) : original,
      images: (row.image_ids ?? []).map(assetUrl),
    };
  }
}
