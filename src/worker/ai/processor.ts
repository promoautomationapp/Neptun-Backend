import { z } from "zod";
import type { Database } from "../../database/database";
import type { StoragePort } from "../../modules/storage/storage.port";
import type { AiResultRow, AiJobRow } from "../../modules/ai/domain/request";
import { belgradeMonth } from "../../modules/ai/domain/request";
import { ingestAsset } from "../../modules/assets/asset-ingest";
import { env } from "../../config/environment";
import type { AiProvider, ProviderOutput, ProviderUsage } from "./provider";
import {
  PRICING_VERSION,
  estimateAiCost,
} from "../../modules/ai/domain/pricing";
import { ProofreadReuse } from "./proofread-reuse";
import { ProviderHttpError, ProviderUncertainError } from "./provider";
import { providerRetryDelay } from "./retry-policy";
const payloadSchema = z.object({ organizationId: z.uuid(), jobId: z.uuid() });
export async function processAiJob(
  db: Database,
  storage: StoragePort,
  payload: unknown,
  provider: AiProvider,
): Promise<void> {
  const { organizationId: org, jobId } = payloadSchema.parse(payload);
  const row = await db.transaction(async (client) => {
    const job = (
      await client.query<AiJobRow>(
        "SELECT * FROM ai_jobs WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [org, jobId],
      )
    ).rows[0];
    if (
      !job ||
      ["succeeded", "failed", "cancelled", "uncertain"].includes(job.status)
    )
      return null;
    if (job.status === "running") {
      // A previous worker may have reached the provider before dying. Never retry an ambiguous billable call.
      await client.query(
        "UPDATE ai_jobs SET status='uncertain',last_error=$3,finished_at=now() WHERE organization_id=$1 AND id=$2",
        [
          org,
          jobId,
          "Worker interrupted after provider dispatch. Review before regenerating.",
        ],
      );
      await client.query(
        "UPDATE ai_results SET status='uncertain' WHERE organization_id=$1 AND id=$2",
        [org, job.result_id],
      );
      return null;
    }
    await client.query(
      "UPDATE ai_jobs SET status='running',started_at=now() WHERE organization_id=$1 AND id=$2",
      [org, jobId],
    );
    return job;
  });
  if (!row) return;
  const result = (
    await db.query<AiResultRow>(
      "SELECT * FROM ai_results WHERE organization_id=$1 AND id=$2",
      [org, row.result_id],
    )
  )[0];
  if (!result) throw new Error("AI result missing.");
  let usageRecorded = false;
  const recordUsage = async (usage: ProviderUsage) => {
    if (usageRecorded) return;
    const cost =
      usage.costUsd ??
      estimateAiCost(result.model, result.operation, usage).costUsd;
    await db.query(
      "INSERT INTO ai_usage(organization_id,job_id,operation,model,input_tokens,output_tokens,cost_usd,user_id,month,pricing_version,usage_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(organization_id,job_id) WHERE job_id IS NOT NULL DO NOTHING",
      [
        org,
        jobId,
        result.operation,
        result.model,
        usage.inputTokens,
        usage.outputTokens,
        cost,
        result.created_by,
        belgradeMonth(),
        PRICING_VERSION,
        usage.usageJson ?? {},
      ],
    );
    usageRecorded = true;
  };
  let reuse: ProofreadReuse | null = null;
  const fail = async (uncertain: boolean, message: string) => {
    await db.transaction(async (client) => {
      const changed = await client.query(
        "UPDATE ai_jobs SET status=$3,last_error=$4,finished_at=now() WHERE organization_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING id",
        [org, jobId, uncertain ? "uncertain" : "failed", message],
      );
      if (changed.rowCount)
        await client.query(
          "UPDATE ai_results SET status=$3 WHERE organization_id=$1 AND id=$2 AND status='pending'",
          [org, result.id, uncertain ? "uncertain" : "failed"],
        );
    });
    await reuse?.fail(uncertain);
  };
  try {
    if (result.operation === "proofread")
      reuse = await ProofreadReuse.acquire(
        db,
        result,
        row.payload.regenerate === true,
      );
    for (let attempt = row.attempts; attempt < env.AI_MAX_ATTEMPTS; attempt++) {
      await db.query(
        "UPDATE ai_jobs SET attempts=attempts+1 WHERE organization_id=$1 AND id=$2",
        [org, jobId],
      );
      let providerSucceeded = false;
      try {
        const plan = await reuse?.prepare();
        const providerCalled = !plan?.cached;
        const output: ProviderOutput = plan?.cached
          ? { json: plan.cached, inputTokens: 0, outputTokens: 0, costUsd: 0 }
          : await provider.run(
              result.operation,
              {
                ...(plan?.params ?? result.params_json),
                regenerate: row.payload.regenerate === true,
              },
              result.model,
              recordUsage,
            );
        providerSucceeded = providerCalled;
        if (providerCalled) await recordUsage(output);
        if (reuse && plan && providerCalled)
          output.json = await reuse.complete(plan.missing, output);
        const asset = output.bytes
          ? await ingestAsset(
              db,
              storage,
              org,
              output.bytes,
              output.mimeType ?? "image/png",
              {
                kind: result.operation,
                createdBy: result.created_by ?? undefined,
                ...(result.operation === "product_image_search"
                  ? { metadata: output.json }
                  : {}),
              },
            )
          : null;
        await db.transaction(async (client) => {
          await client.query(
            "UPDATE ai_results SET status='completed',output_asset_id=$3,output_text=$4,output_json=$5,input_tokens=$6,output_tokens=$7,cost_usd=$8,completed_at=now() WHERE organization_id=$1 AND id=$2",
            [
              org,
              result.id,
              asset?.id ?? null,
              output.text ?? null,
              output.json,
              output.inputTokens,
              output.outputTokens,
              output.costUsd,
            ],
          );
          await client.query(
            "UPDATE ai_jobs SET status='succeeded',last_error=NULL,finished_at=now() WHERE organization_id=$1 AND id=$2",
            [org, jobId],
          );
          if (result.operation === "brand_prep" && asset) {
            const brand = String(result.params_json.brand ?? "")
              .trim()
              .toUpperCase();
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              [`${org}:brand:${brand}`],
            );
            await client.query(
              "INSERT INTO brand_assets(organization_id,brand,asset_id,version) SELECT $1,$2,$3,coalesce(max(version),0)+1 FROM brand_assets WHERE organization_id=$1 AND brand=$2",
              [org, brand, asset.id],
            );
          }
        });
        return;
      } catch (error) {
        const retryDelay =
          error instanceof ProviderHttpError
            ? providerRetryDelay(error.retryAfterMs, attempt)
            : null;
        if (
          error instanceof ProviderHttpError &&
          (error.status === 429 || error.status >= 500) &&
          attempt + 1 < env.AI_MAX_ATTEMPTS &&
          retryDelay !== null
        ) {
          await db.query(
            "UPDATE ai_jobs SET last_error=$3 WHERE organization_id=$1 AND id=$2",
            [org, jobId, error.message],
          );
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
        const uncertain =
          providerSucceeded ||
          usageRecorded ||
          error instanceof ProviderUncertainError;
        const message = uncertain
          ? "The provider response or result persistence was interrupted. Review before regenerating."
          : error instanceof ProviderHttpError
            ? error.message
            : "AI preparation failed. Review the source and retry explicitly.";
        await fail(uncertain, message);
        return;
      }
    }
    await fail(
      false,
      "The preparation attempt limit was reached. Use Retry to request a new version.",
    );
  } catch (error) {
    await fail(
      usageRecorded || error instanceof ProviderUncertainError,
      "Preparation was interrupted. Review the result before explicitly retrying.",
    );
  } finally {
    await reuse?.release();
  }
}
