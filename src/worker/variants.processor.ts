import sharp from "sharp";
import { createHash } from "node:crypto";
import type { Database } from "../database/database";
import type { StoragePort } from "../modules/storage/storage.port";
import type { AssetRow } from "../modules/assets/assets.repository";
import { ingestAsset } from "../modules/assets/asset-ingest";
import { z } from "zod";
import {
  MAX_STORED_ASSET_BYTES,
  withImageConversion,
} from "../security/image-work";
import { StorageReadLimitError } from "../modules/storage/storage-read-limit";

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
  if (
    !asset ||
    !asset.mime_type.startsWith("image/") ||
    asset.metadata.cutoutRejected === true
  )
    return;
  const sourceSize = Number(asset.size);
  if (
    !Number.isSafeInteger(sourceSize) ||
    sourceSize < 1 ||
    sourceSize > MAX_STORED_ASSET_BYTES
  )
    throw new StorageReadLimitError();
  const missing: { variant: "thumbnail" | "preview"; size: number }[] = [];
  for (const [variant, size] of [
    ["thumbnail", 300],
    ["preview", 1200],
  ] as const) {
    const exists = await db.query(
      "SELECT 1 FROM asset_variants v JOIN assets a ON a.organization_id=v.organization_id AND a.id=v.asset_id AND a.deleted_at IS NULL WHERE v.organization_id=$1 AND v.source_asset_id=$2 AND v.variant=$3 AND v.transform_version=1",
      [organizationId, assetId, variant],
    );
    if (exists.length) continue;
    missing.push({ variant, size });
  }
  if (!missing.length) return;
  // Reserve native image capacity before reading the original. Waiting jobs
  // must not retain full image buffers beside an active cutout/conversion.
  await withImageConversion(async () => {
    const bytes = await storage.read(asset.storage_key, sourceSize);
    if (!bytes.length || bytes.length > sourceSize)
      throw new StorageReadLimitError();
    for (const { variant, size } of missing) {
      const output = await sharp(bytes, {
        limitInputPixels: 67_000_000,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: size,
          height: size,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 90, alphaQuality: 100 })
        .toBuffer();
      // Generate pixels outside locks. Lock parent and content-addressed output
      // keys together before registering either DB relationship, matching cleanup.
      const sha256 = createHash("sha256").update(output).digest("hex");
      const childKey = `org/${organizationId}/assets/${sha256}.webp`;
      await db.transaction(async (client) => {
        for (const key of [...new Set([asset.storage_key, childKey])].sort())
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`${organizationId}:asset:${key}`],
          );
        const available = await client.query(
          "SELECT id FROM assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL AND metadata->>'cutoutRejected' IS DISTINCT FROM 'true' FOR SHARE",
          [organizationId, assetId],
        );
        if (!available.rowCount) return;
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
            client,
          },
        );
        await client.query(
          "INSERT INTO asset_variants(organization_id,source_asset_id,asset_id,variant) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [organizationId, assetId, stored.id, variant],
        );
      });
    }
  });
}
