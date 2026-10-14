import { Inject, Injectable } from "@nestjs/common";
import { Database } from "../../database/database";
import type { StoragePort } from "../storage/storage.port";
import { downloadPublic } from "../../shared/public-download";
import { assetUrl, ingestAsset } from "../assets/asset-ingest";
import { siteUrl, type SourceBrand } from "./neptun-source";
@Injectable()
export class CatalogBrandsRepository {
  constructor(@Inject(Database) readonly db: Database) {}
  async list(organizationId: string) {
    const brands = await this.db.query<{
      source_id: number;
      name: string;
      source_url: string;
      asset_id: string | null;
      error: string | null;
    }>(
      "SELECT source_id,name,source_url,asset_id,error FROM catalog_source_brands WHERE organization_id=$1 ORDER BY name",
      [organizationId],
    );
    return {
      brands: brands.map((brand) => ({
        id: brand.source_id,
        name: brand.name,
        sourceImageUrl: brand.source_url,
        image: brand.asset_id ? assetUrl(brand.asset_id) : "",
        error: brand.error,
      })),
    };
  }
  async record(organizationId: string, brand: SourceBrand) {
    if (!brand.id || !brand.name || !brand.sourceImageUrl) return;
    await this.db.query(
      "INSERT INTO catalog_source_brands(organization_id,source_id,name,source_url) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,source_id) DO UPDATE SET name=EXCLUDED.name,asset_id=CASE WHEN catalog_source_brands.source_url=EXCLUDED.source_url THEN catalog_source_brands.asset_id ELSE NULL END,source_url=EXCLUDED.source_url,last_seen_at=now()",
      [organizationId, brand.id, brand.name, siteUrl(brand.sourceImageUrl)],
    );
    await this.db.query(
      "INSERT INTO job_outbox(organization_id,queue,job_key,payload) VALUES($1,'catalog-brand-images',$2,$3) ON CONFLICT(job_key) DO NOTHING",
      [
        organizationId,
        `catalog-brand:${organizationId}:${brand.id}:${brand.sourceImageUrl}`,
        {
          organizationId,
          brandId: brand.id,
          sourceImageUrl: brand.sourceImageUrl,
        },
      ],
    );
  }
}
export async function processCatalogBrandImage(
  db: Database,
  storage: StoragePort,
  payload: { organizationId: string; brandId: number; sourceImageUrl: string },
) {
  const { organizationId, brandId } = payload;
  const url = siteUrl(payload.sourceImageUrl);
  try {
    const existing = await db.query<{ id: string; storage_key: string }>(
      "SELECT a.id,a.storage_key FROM assets a JOIN asset_aliases aa ON aa.organization_id=a.organization_id AND aa.asset_id=a.id WHERE aa.organization_id=$1 AND aa.source_path=$2 AND a.deleted_at IS NULL",
      [organizationId, url],
    );
    let assetId = existing[0]?.id;
    if (!assetId || !(await storage.exists(existing[0]!.storage_key))) {
      const download = await downloadPublic(
        url,
        8_000_000,
        undefined,
        (source) => {
          if (!["www.neptun-ks.com", "neptun-ks.com"].includes(source.hostname))
            throw new Error("Brand logos must come from Neptun.");
        },
      );
      if (
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/avif",
          "image/svg+xml",
        ].includes(download.mimeType)
      )
        throw new Error("Neptun brand logo is not an image.");
      const asset = await ingestAsset(
        db,
        storage,
        organizationId,
        download.bytes,
        download.mimeType,
        {
          kind: "design",
          metadata: { sourceUrl: url, catalogBrandId: brandId },
        },
      );
      assetId = asset.id;
      await db.query(
        "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,source_path) DO UPDATE SET asset_id=EXCLUDED.asset_id",
        [organizationId, url, assetId],
      );
    }
    await db.query(
      "UPDATE catalog_source_brands SET asset_id=$3,error=NULL WHERE organization_id=$1 AND source_id=$2 AND source_url=$4",
      [organizationId, brandId, assetId, url],
    );
  } catch (error) {
    await db.query(
      "UPDATE catalog_source_brands SET error=$3 WHERE organization_id=$1 AND source_id=$2 AND source_url=$4",
      [
        organizationId,
        brandId,
        error instanceof Error ? error.message : "Brand image unavailable.",
        url,
      ],
    );
    throw error;
  }
}
