import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { UNREFERENCED_CUTOUT_SQL } from "./cutout-references";

/** Durable cleanup runs again after a document save, when its rejected photo
 * has been replaced. Never delete a source upload or break another live draft. */
export async function enqueueRejectedCutoutCleanup(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO job_outbox(organization_id,queue,job_key,payload)
     SELECT $1::uuid,'asset-variants',$2,jsonb_build_object('organizationId',($1::uuid)::text,'cleanupRejected',true)
     WHERE EXISTS(SELECT 1 FROM assets a WHERE a.organization_id=$1::uuid AND a.deleted_at IS NULL AND a.kind IN ('cutout','design') AND a.metadata->>'cutoutRejected'='true' AND a.metadata->>'cutoutRemoved' IS DISTINCT FROM 'true' AND ${UNREFERENCED_CUTOUT_SQL})`,
    [organizationId, `cutout-cleanup:${organizationId}:${randomUUID()}`],
  );
}

export async function rejectSavedCutout(
  client: PoolClient,
  organizationId: string,
  rejectedImage: unknown,
  source: unknown,
): Promise<void> {
  if (typeof rejectedImage !== "string" || typeof source !== "string") return;
  const match = /^(?:https?:\/\/[^/]+)?\/api\/assets\/([a-f0-9-]{36})$/i.exec(
    rejectedImage,
  );
  const sourceMatch =
    /^(?:https?:\/\/[^/]+)?\/api\/assets\/([a-f0-9-]{36})$/i.exec(source);
  if (!match || match[1]?.toLowerCase() === sourceMatch?.[1]?.toLowerCase())
    return;
  // A client cannot discard arbitrary originals/uploads. The rejected output
  // must belong to this tenant and have been generated from this source.
  const rejected = await client.query<{ id: string }>(
    `SELECT a.id FROM assets a
     WHERE a.organization_id=$1 AND a.id=$2 AND a.deleted_at IS NULL AND a.kind IN ('cutout','design')
       AND EXISTS(SELECT 1 FROM ai_results r WHERE r.organization_id=a.organization_id
         AND r.operation='cutout' AND r.output_asset_id=a.id AND r.params_json->>'image'=$3)
     FOR UPDATE`,
    [organizationId, match[1], source],
  );
  if (!rejected.rowCount) return;
  await client.query(
    `UPDATE ai_results SET status='failed',output_json=(coalesce(output_json,'{}'::jsonb)-'cutoutValidated') || '{"cutoutRejected":true}'::jsonb
     WHERE organization_id=$1 AND operation='cutout' AND output_asset_id=$2`,
    [organizationId, match[1]],
  );
  await client.query(
    `UPDATE assets SET metadata=metadata || '{"cutoutRejected":true}'::jsonb
     WHERE organization_id=$1 AND id=$2`,
    [organizationId, match[1]],
  );
  await enqueueRejectedCutoutCleanup(client, organizationId);
}
