import { z } from "zod";
import type { Database } from "../../database/database";
import type { JsonObject } from "../../shared/json";
import { sourceReference } from "../assets/document-assets";
import { imageInputSchema } from "./domain/params";
import {
  CUTOUT_VALIDATION_VERSION,
  validatedCutoutResult,
} from "./domain/cutout-validation";
import type { AiResultRow } from "./domain/request";

export const cutoutReuseInputSchema = z.object({
  items: z
    .array(imageInputSchema.extend({ key: z.string().min(1).max(256) }))
    .max(200),
});
export type CutoutReuseItem = z.infer<
  typeof cutoutReuseInputSchema
>["items"][number];
export interface CutoutReuseHit {
  key: string;
  resultId: string;
  result: JsonObject;
}
interface ReuseRow extends AiResultRow {
  matched_key: string;
}

/** Cache-only lookup. No downloads, ingestion, queue reservations or provider
 * calls belong here. Finished physical cutouts are independent of page design,
 * labels, canvas orientation and later model settings; annotations remain editable.
 * Nonempty designer instructions require that exact cleanup, while a fresh import
 * with no instructions may reuse the latest validated correction for its source. */
export async function findReusableCutouts(
  db: Pick<Database, "query">,
  organizationId: string,
  items: CutoutReuseItem[],
): Promise<CutoutReuseHit[]> {
  const sources = items.flatMap((item) => {
    let reference: ReturnType<typeof sourceReference>;
    try {
      reference = sourceReference(item.image);
    } catch {
      return [];
    } // One malformed/stale source is a miss, not a failed batch.
    if (!reference && !/^https?:\/\//i.test(item.image)) return [];
    return [
      {
        key: item.key,
        image: item.image,
        source_id: reference?.id ?? null,
        source_alias: reference?.alias ?? null,
        external:
          reference === null ||
          Boolean(reference.alias && /^https?:\/\//i.test(reference.alias)),
        instructions: (item.instructions ?? "").trim(),
      },
    ];
  });
  if (!sources.length) return [];
  const rows = await db.query<ReuseRow>(
    `WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb)
        AS i(key text,image text,source_id uuid,source_alias text,external boolean,instructions text)
    )
    SELECT saved.*,i.key AS matched_key FROM incoming i
    LEFT JOIN asset_aliases alias ON alias.organization_id=$1::uuid AND alias.source_path=i.source_alias
    LEFT JOIN assets original ON original.organization_id=$1::uuid
      AND original.id=coalesce(i.source_id,alias.asset_id) AND original.deleted_at IS NULL
    JOIN LATERAL (
      SELECT r.* FROM ai_results r
      JOIN assets output ON output.organization_id=r.organization_id AND output.id=r.output_asset_id
        AND output.deleted_at IS NULL
        AND output.metadata->>'cutoutRejected' IS DISTINCT FROM 'true'
        AND output.metadata->>'cutoutRemoved' IS DISTINCT FROM 'true'
        AND output.metadata->>'cutoutInvalidated' IS DISTINCT FROM 'true'
      LEFT JOIN assets source ON source.organization_id=r.organization_id
        AND r.params_json->>'image'='/api/assets/' || source.id::text
      WHERE r.organization_id=$1::uuid AND r.operation='cutout' AND r.status='completed'
        AND r.output_json @> jsonb_build_object('cutoutValidated',true,'cutoutValidationVersion',$3::int,
          'annotationCleanup',true,'annotationHandling','editable-overlays')
        AND r.output_json->>'cutoutRejected' IS DISTINCT FROM 'true'
        AND (
          (original.id IS NOT NULL AND (source.sha256=original.sha256 OR r.params_json->>'image'='/api/assets/' || original.id::text))
          OR (i.external AND r.params_json->>'image'=i.image)
        )
        AND (i.instructions='' OR btrim(coalesce(r.params_json->>'instructions',''))=i.instructions)
      ORDER BY r.completed_at DESC NULLS LAST,r.created_at DESC,r.id DESC LIMIT 1
    ) saved ON true`,
    [organizationId, JSON.stringify(sources), CUTOUT_VALIDATION_VERSION],
  );
  // Retain an application guard too: a future SQL edit must not turn mere image
  // existence or a completed job into a byte-validation receipt.
  return rows
    .filter(
      (row) =>
        validatedCutoutResult(row) &&
        row.output_json?.annotationCleanup === true &&
        row.output_json.annotationHandling === "editable-overlays",
    )
    .map((row) => ({
      key: row.matched_key,
      resultId: row.id,
      result: {
        ...row.output_json,
        image: `/api/assets/${row.output_asset_id}`,
      },
    }));
}
