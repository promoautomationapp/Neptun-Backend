import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../database/database";
import type { StoragePort } from "../modules/storage/storage.port";
import { UNREFERENCED_CUTOUT_SQL } from "../modules/ai/cutout-references";

const payloadSchema = z.object({ organizationId: z.uuid() });
const BATCH_SIZE = 100;
interface CleanupAsset {
  id: string;
  storage_key: string;
}

/** Invalid cutouts are immediately excluded from reuse. Their bytes are removed
 * once no document, history snapshot or saved asset still refers to them. */
export async function cleanupRejectedCutouts(
  db: Database,
  storage: StoragePort,
  payload: unknown,
): Promise<void> {
  const { organizationId } = payloadSchema.parse(payload);
  const candidates = await db.query<CleanupAsset>(
    `SELECT a.id,a.storage_key FROM assets a
     WHERE a.organization_id=$1 AND a.kind IN ('cutout','design')
       AND a.metadata->>'cutoutRejected'='true'
       AND a.metadata->>'cutoutRemoved' IS DISTINCT FROM 'true'
       AND EXISTS(SELECT 1 FROM ai_results r WHERE r.organization_id=a.organization_id AND r.operation='cutout' AND r.output_asset_id=a.id)
       AND ${UNREFERENCED_CUTOUT_SQL}
     ORDER BY a.created_at LIMIT ${BATCH_SIZE}`,
    [organizationId],
  );
  let needsContinuation = candidates.length === BATCH_SIZE;
  for (const asset of candidates) {
    const retry = await db.transaction(async (client) => {
      const findVariants = async () =>
        (
          await client.query<CleanupAsset>(
            `SELECT a.id,a.storage_key FROM asset_variants v JOIN assets a ON a.organization_id=v.organization_id AND a.id=v.asset_id
           WHERE v.organization_id=$1 AND v.source_asset_id=$2
             AND a.source_asset_id=$2 AND a.kind IN ('thumbnail','preview')
             AND NOT EXISTS(SELECT 1 FROM asset_variants shared WHERE shared.organization_id=a.organization_id AND shared.asset_id=a.id AND shared.source_asset_id<>$2)`,
            [organizationId, asset.id],
          )
        ).rows;
      const variants = await findVariants();
      const outputs = [...variants, asset];
      // Ingest takes this same lock before checking or writing content-addressed
      // bytes. Hold it until removal commits so a valid replacement cannot race.
      for (const key of [
        ...new Set(outputs.map((output) => output.storage_key)),
      ].sort())
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${organizationId}:asset:${key}`],
        );
      // A variant may have finished while the parent key lock was pending.
      // Retry with its key included, preserving the global key-lock order.
      const currentVariants = await findVariants();
      const variantIds = new Set(variants.map((variant) => variant.id));
      if (currentVariants.some((variant) => !variantIds.has(variant.id)))
        return true;
      const ids = [...new Set(outputs.map((output) => output.id))].sort();
      await client.query(
        "SELECT id FROM assets WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
        [organizationId, ids],
      );
      // All eligibility checks run again after locks. Document saves hold SHARE
      // locks on their references, and a new validated ingest clears rejection.
      const eligible = await client.query(
        `SELECT a.id FROM assets a WHERE a.organization_id=$1 AND a.id=$2
           AND a.kind IN ('cutout','design')
           AND a.metadata->>'cutoutRejected'='true'
           AND a.metadata->>'cutoutRemoved' IS DISTINCT FROM 'true'
           AND EXISTS(SELECT 1 FROM ai_results r WHERE r.organization_id=a.organization_id AND r.operation='cutout' AND r.output_asset_id=a.id)
           AND ${UNREFERENCED_CUTOUT_SQL}
           AND NOT EXISTS(SELECT 1 FROM asset_variants v WHERE v.organization_id=$1 AND v.asset_id=ANY($3::uuid[]) AND v.source_asset_id<>$2)`,
        [organizationId, asset.id, ids],
      );
      if (!eligible.rowCount) return false;
      await client.query(
        "UPDATE assets SET deleted_at=coalesce(deleted_at,now()) WHERE organization_id=$1 AND id=ANY($2::uuid[])",
        [organizationId, ids],
      );
      // Removal is idempotent. On storage failure the transaction rolls back,
      // while the result remains rejected and the durable job can try again.
      for (const output of outputs) await storage.remove(output.storage_key);
      await client.query(
        "UPDATE assets SET metadata=metadata || '{\"cutoutRemoved\":true}'::jsonb WHERE organization_id=$1 AND id=$2",
        [organizationId, asset.id],
      );
      return false;
    });
    needsContinuation ||= retry;
  }
  if (needsContinuation)
    await db.query(
      "INSERT INTO job_outbox(organization_id,queue,job_key,payload) VALUES($1,'cutout-cleanup',$2,$3)",
      [
        organizationId,
        `cutout-cleanup:${organizationId}:${randomUUID()}`,
        { organizationId },
      ],
    );
}
