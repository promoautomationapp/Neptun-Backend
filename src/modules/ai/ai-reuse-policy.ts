import { z } from "zod";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { Database } from "../../database/database";
import type { JsonObject } from "../../shared/json";
import type { AiResultRow } from "./domain/request";
import { stableJson } from "./domain/request";
import {
  productIdentityText,
  productImageSearchCacheIdentity,
  productImageSearchInputSchema,
} from "./domain/product-image-search";

export const AI_NEGATIVE_CACHE_SECONDS = 14 * 24 * 60 * 60;
const transientSearchSeconds = 30;
export const negativeCacheEpoch = (now = Date.now()) =>
  Math.floor(now / (AI_NEGATIVE_CACHE_SECONDS * 1000));
export interface ReuseHistoryRow extends AiResultRow {
  completed_at?: Date | string | null;
  created_at?: Date | string;
  available?: boolean;
}
const milliseconds = (value: Date | string | null | undefined) =>
  value ? new Date(value).getTime() : 0;
export function stableSearchMiss(row: AiResultRow): boolean {
  const json = row.output_json;
  if (
    json?.found !== false ||
    json.retryable === true ||
    json.searchOutcome === "verification_unavailable"
  )
    return false;
  if (json.searchOutcome === "not_found") return true;
  // Historical outputs used the same found:false shape for blocked downloads.
  // Those are infrastructure/verification failures, never a fortnight-long no-match.
  return !/could not be safely downloaded|page could not be read|could not be verified|format is unsupported|connection|timeout|timed out|unavailable|temporar/i.test(
    String(json.reason || ""),
  );
}
export function searchReuseIdentity(
  raw: JsonObject,
  includeSource = true,
): string {
  const input = productImageSearchInputSchema.parse(raw);
  return stableJson({
    ...productImageSearchCacheIdentity(input),
    ...(includeSource ? { sourceUrl: input.sourceUrl.trim() } : {}),
  });
}
/** No result/usage rows are modified by reuse. Category/position/retry/UI IDs do
 * not purchase another search; changed model/edition/source facts remain distinct. */
export async function searchReuseHistory(
  db: Pick<Database, "query">,
  org: string,
  params: JsonObject,
) {
  const input = productImageSearchInputSchema.parse(params);
  const identity = searchReuseIdentity(params);
  const positiveIdentity = searchReuseIdentity(params, false);
  const rows = await db.query<ReuseHistoryRow>(
    `SELECT r.*,a.id IS NOT NULL available FROM ai_results r
     LEFT JOIN assets a ON a.organization_id=r.organization_id AND a.id=r.output_asset_id AND a.deleted_at IS NULL
     WHERE r.organization_id=$1::uuid AND r.operation='product_image_search' AND r.status='completed'
       AND lower(regexp_replace(normalize(coalesce(r.params_json->>'code',''),NFKC),'[^[:alnum:]]','','g'))=$2
       AND (r.output_json->>'found'='true' OR r.completed_at>now()-interval '14 days')
     ORDER BY CASE WHEN r.output_json->>'found'='true' THEN 0 ELSE 1 END,r.completed_at DESC NULLS LAST,r.id DESC LIMIT 500`,
    [org, productIdentityText(input.code)],
  );
  let negative: ReuseHistoryRow | undefined;
  let transient: ReuseHistoryRow | undefined;
  for (const row of rows) {
    try {
      if (
        row.output_json?.found === true &&
        row.available &&
        searchReuseIdentity(row.params_json, false) === positiveIdentity
      )
        return { success: row };
      if (searchReuseIdentity(row.params_json) !== identity) continue;
      if (stableSearchMiss(row)) negative ??= row;
      else if (row.output_json?.found === false) transient ??= row;
    } catch {
      /* Malformed historical requests cannot establish identity. */
    }
  }
  if (negative) {
    const until =
      milliseconds(negative.completed_at) + AI_NEGATIVE_CACHE_SECONDS * 1000;
    if (until > Date.now()) return { negative, until };
  }
  if (transient) {
    const until =
      milliseconds(transient.completed_at) + transientSearchSeconds * 1000;
    if (until > Date.now())
      throw new ServiceUnavailableException({
        error:
          "Photo verification is temporarily unavailable. Your original images are unchanged. Try again shortly.",
        code: "AI_SEARCH_UNAVAILABLE",
        retryAfterSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
        retryable: true,
      });
  }
  return { transient };
}

/** A known invalid billable output is not a finished cutout. Block automatic
 * imports of the same physical photo; a deliberate regenerate may try again. */
export async function guardCutoutCooldown(
  db: Pick<Database, "query">,
  org: string,
  params: JsonObject,
) {
  const rows = await db.query<{
    id: string;
    finished_at: Date | string;
    status: string;
  }>(
    `SELECT r.id,j.finished_at,r.status FROM ai_results r
     JOIN ai_jobs j ON j.organization_id=r.organization_id AND j.result_id=r.id
     LEFT JOIN assets original ON original.organization_id=$1::uuid AND '/api/assets/' || original.id::text=$2 AND original.deleted_at IS NULL
     LEFT JOIN assets source ON source.organization_id=r.organization_id AND r.params_json->>'image'='/api/assets/' || source.id::text
     WHERE r.organization_id=$1::uuid AND r.operation='cutout'
       AND r.output_json->>'cutoutInvalidated' IS DISTINCT FROM 'true'
       AND (r.params_json->>'image'=$2 OR (original.id IS NOT NULL AND source.sha256=original.sha256))
       AND ($3='' OR btrim(coalesce(r.params_json->>'instructions',''))=$3)
       AND ((r.status='uncertain' AND j.status='uncertain') OR
         (r.status='failed' AND j.status='failed' AND j.finished_at>now()-interval '14 days'
          AND (r.output_json->>'failureCode'='CUTOUT_INVALID' OR j.last_error=$4)
          AND EXISTS(SELECT 1 FROM ai_usage u WHERE u.organization_id=r.organization_id AND u.job_id=j.id)))
     ORDER BY CASE WHEN r.status='uncertain' THEN 0 ELSE 1 END,j.finished_at DESC NULLS LAST,r.id DESC LIMIT 1`,
    [
      org,
      params.image,
      String(params.instructions || "").trim(),
      "The photo background could not be removed completely. Your original photo is unchanged. Try again or describe what needs fixing.",
    ],
  );
  const row = rows[0];
  if (!row) return;
  if (row.status === "uncertain")
    throw new ConflictException({
      error:
        "The provider response was interrupted. Check this job before explicitly regenerating.",
      code: "AI_RESULT_UNCERTAIN",
      resultId: row.id,
    });
  const until =
    milliseconds(row.finished_at) + AI_NEGATIVE_CACHE_SECONDS * 1000;
  if (until <= Date.now()) return;
  throw new ConflictException({
    error:
      "This photo preparation already failed. Automatic retries are paused for 14 days. Keep the original, choose another photo, or explicitly retry background removal.",
    code: "AI_CUTOUT_COOLDOWN",
    cached: true,
    resultId: row.id,
    cooldownUntil: new Date(until).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
  });
}

const geometrySchema = z
  .object({
    found: z.literal(true),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (value) =>
      value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001,
  );
export async function reusableScreenGeometry(
  db: Pick<Database, "query">,
  org: string,
  params: JsonObject,
) {
  const rows = await db.query<AiResultRow>(
    `SELECT r.* FROM ai_results r
    LEFT JOIN assets original ON original.organization_id=$1::uuid AND '/api/assets/' || original.id::text=$2 AND original.deleted_at IS NULL
    LEFT JOIN assets source ON source.organization_id=r.organization_id AND r.params_json->>'image'='/api/assets/' || source.id::text
    WHERE r.organization_id=$1::uuid AND r.operation='detect_screen' AND r.status='completed' AND r.output_json->>'found'='true'
      AND (r.params_json->>'image'=$2 OR (original.id IS NOT NULL AND source.sha256=original.sha256))
    ORDER BY r.completed_at DESC NULLS LAST,r.id DESC LIMIT 20`,
    [org, params.image],
  );
  return rows.find((row) => geometrySchema.safeParse(row.output_json).success);
}
