import sharp from "sharp";
import type { Database } from "../database/database";
import type { StoragePort } from "../modules/storage/storage.port";
import type { AssetRow } from "../modules/assets/assets.repository";
import { ingestAsset } from "../modules/assets/asset-ingest";
import { z } from "zod";

const payloadSchema = z.object({ organizationId: z.uuid(), assetId: z.uuid() });
export async function generateVariants(
  db: Database,
  storage: StoragePort,
  payload: unknown,
): Promise<void> {
  const { organizationId, assetId } = payloadSchema.parse(payload);
  const asset = (
    await db.query<AssetRow>(
      "SELECT * FROM assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL",
      [organizationId, assetId],
    )
  )[0];
  if (!asset || !asset.mime_type.startsWith("image/")) return;
  const bytes = await storage.read(asset.storage_key);
  for (const [variant, size] of [
    ["thumbnail", 300],
    ["preview", 1200],
  ] as const) {
    const exists = await db.query(
      "SELECT 1 FROM asset_variants WHERE organization_id=$1 AND source_asset_id=$2 AND variant=$3 AND transform_version=1",
      [organizationId, assetId, variant],
    );
    if (exists.length) continue;
    const output = await sharp(bytes, { limitInputPixels: 67_000_000 })
      .rotate()
      .resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer();
    const stored = await ingestAsset(
      db,
      storage,
      organizationId,
      output,
      "image/webp",
      {
        kind: variant,
        sourceAssetId: assetId,
        enqueueVariants: false,
        metadata: { variant, size, transformVersion: 1 },
      },
    );
    await db.query(
      "INSERT INTO asset_variants(organization_id,source_asset_id,asset_id,variant) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [organizationId, assetId, stored.id, variant],
    );
  }
}
