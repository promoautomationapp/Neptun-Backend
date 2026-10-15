import { normalizeAiParams } from "./domain/params";
import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  ConflictException,
} from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import { Database } from "../../database/database";
import { env } from "../../config/environment";
import { DocumentAssets } from "../assets/document-assets";
import { LifestyleRepository } from "./lifestyle.repository";
import type { Actor } from "../auth/domain/actor";
import type { JsonObject, JsonValue } from "../../shared/json";
import { proofreadFields, assembleProofread } from "./domain/proofread";
import type { ProofreadCheckRow } from "./domain/proofread";
import {
  cacheKey,
  isImageOperation,
  PROMPT_VERSION,
  promptVersion,
} from "./domain/request";
import type {
  AiRequest,
  AiResultRow,
  AiJobRow,
  AiTicket,
} from "./domain/request";
@Injectable()
export class AiRepository {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DocumentAssets) private readonly assets: DocumentAssets,
    @Inject(LifestyleRepository)
    private readonly lifestyle: LifestyleRepository,
  ) {}
  async enqueue(actor: Actor, request: AiRequest): Promise<AiTicket> {
    const input = normalizeAiParams(request.operation, request.params);
    const params = [
      "proofread",
      "text_generate",
      "product_image_search",
    ].includes(request.operation)
      ? input
      : await this.assets.externalize(
          actor.organizationId,
          input,
          actor.userId,
        );
    delete params.retry;
    delete params.regenerate;
    const assetIds = new Set<string>();
    const collect = (value: JsonValue): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value && typeof value === "object") {
        Object.values(value).forEach(collect);
        return;
      }
      if (
        typeof value === "string" &&
        /^\/api\/assets\/[a-f0-9-]{36}$/.test(value)
      )
        assetIds.add(value.slice("/api/assets/".length));
    };
    collect(params);
    const sourceAssets = assetIds.size
      ? await this.db.query<{ id: string; sha256: string }>(
          "SELECT id,sha256 FROM assets WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
          [actor.organizationId, [...assetIds]],
        )
      : [];
    if (sourceAssets.length !== assetIds.size)
      throw new NotFoundException("Source image not found.");
    const byId = new Map(sourceAssets.map((row) => [row.id, row.sha256]));
    const convert = (value: JsonValue): JsonValue => {
      if (Array.isArray(value)) return value.map(convert);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, convert(item)]),
        );
      if (typeof value === "string" && value.startsWith("/api/assets/")) {
        const sha = byId.get(value.slice("/api/assets/".length));
        if (sha) return `sha256:${sha}`;
      }
      return value;
    };
    const normalized = convert(params) as JsonObject;
    const hashes = [...new Set(sourceAssets.map((row) => row.sha256))].sort();
    const sourceSha256 = hashes.length
      ? createHash("sha256").update(hashes.join(":")).digest("hex")
      : null;
    const image = isImageOperation(request.operation);
    const model =
      request.operation === "product_image_search"
        ? env.OPENAI_SEARCH_MODEL
        : image
          ? env.OPENAI_IMAGE_MODEL
          : env.OPENAI_TEXT_MODEL;
    const version = promptVersion(request.operation);
    const quality = image ? "high" : null;
    const key = cacheKey({
      organizationId: actor.organizationId,
      operation: request.operation,
      sourceSha256,
      params: normalized,
      model,
      quality,
      promptVersion: version,
      ...(request.regenerate ? { nonce: randomUUID() } : {}),
    });
    const fields =
      request.operation === "proofread"
        ? proofreadFields(actor.organizationId, params, model, PROMPT_VERSION)
        : [];
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${actor.organizationId}:ai:${key}`],
      );
      const existing = (
        await client.query<AiResultRow>(
          "SELECT * FROM ai_results WHERE organization_id=$1 AND cache_key=$2 FOR UPDATE",
          [actor.organizationId, key],
        )
      ).rows[0];
      if (existing?.status === "completed")
        return {
          cached: true,
          status: "succeeded",
          resultId: existing.id,
          result: this.result(existing),
        };
      const active = (
        await client.query<AiJobRow>(
          "SELECT * FROM ai_jobs WHERE organization_id=$1 AND cache_key=$2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
          [actor.organizationId, key],
        )
      ).rows[0];
      if (active)
        return {
          cached: true,
          status: active.status,
          resultId: active.result_id,
          jobId: active.id,
        };
      if (existing?.status === "uncertain")
        throw new ConflictException({
          error:
            "The provider response was interrupted. Check this job before explicitly regenerating.",
          code: "AI_RESULT_UNCERTAIN",
          resultId: existing.id,
        });
      if (existing?.status === "failed")
        throw new ConflictException({
          error: "This AI request failed. Use Retry to start a new version.",
          code: "AI_JOB_FAILED",
          resultId: existing.id,
        });
      if (request.operation === "proofread" && !request.regenerate) {
        const checks = (
          await client.query<ProofreadCheckRow>(
            "SELECT cache_key,status,result_id,suggestion FROM ai_proofread_checks WHERE organization_id=$1 AND cache_key=ANY($2::text[]) AND status='completed'",
            [actor.organizationId, fields.map((field) => field.key)],
          )
        ).rows;
        const byKey = new Map(checks.map((check) => [check.cache_key, check]));
        if (fields.every((field) => byKey.has(field.key))) {
          const output = assembleProofread(fields, byKey);
          const saved = (
            await client.query<AiResultRow>(
              "INSERT INTO ai_results(organization_id,operation,cache_key,model,quality,params_json,prompt_version,status,created_by,output_json,input_tokens,output_tokens,cost_usd,completed_at) VALUES($1,'proofread',$2,$3,NULL,$4,$5,'completed',$6,$7,0,0,0,now()) RETURNING *",
              [
                actor.organizationId,
                key,
                model,
                params,
                PROMPT_VERSION,
                actor.userId,
                output,
              ],
            )
          ).rows[0];
          if (!saved)
            throw new Error("Reusable text result registration failed.");
          return {
            cached: true,
            status: "succeeded",
            resultId: saved.id,
            result: this.result(saved),
          };
        }
      }
      if (!env.OPENAI_API_KEY)
        throw new ServiceUnavailableException(
          "Add OPENAI_API_KEY to the backend environment first. Saved results remain available.",
        );
      if (request.operation === "lifestyle")
        await this.lifestyle.reserveAttempt(client, actor.organizationId);
      const result = (
        await client.query<AiResultRow>(
          "INSERT INTO ai_results(organization_id,operation,cache_key,model,quality,params_json,prompt_version,source_sha256,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *",
          [
            actor.organizationId,
            request.operation,
            key,
            model,
            quality,
            params,
            version,
            sourceSha256,
            actor.userId,
          ],
        )
      ).rows[0];
      if (!result) throw new Error("AI result registration failed.");
      const job = (
        await client.query<AiJobRow>(
          "INSERT INTO ai_jobs(organization_id,result_id,cache_key,payload,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            actor.organizationId,
            result.id,
            key,
            {
              operation: request.operation,
              params,
              regenerate: request.regenerate,
            },
            actor.userId,
          ],
        )
      ).rows[0];
      if (!job) throw new Error("AI job registration failed.");
      await client.query(
        "INSERT INTO job_outbox(organization_id,queue,job_key,payload) VALUES($1,$2,$3,$4)",
        [
          actor.organizationId,
          image ? "ai-image" : "ai-text",
          `ai:${job.id}`,
          { organizationId: actor.organizationId, jobId: job.id },
        ],
      );
      return {
        cached: false,
        status: "queued",
        jobId: job.id,
        resultId: result.id,
      };
    });
  }
  async job(org: string, id: string) {
    const row = (
      await this.db.query<AiJobRow>(
        "SELECT * FROM ai_jobs WHERE organization_id=$1 AND id=$2",
        [org, id],
      )
    )[0];
    if (!row) throw new NotFoundException("Job not found.");
    const result = (
      await this.db.query<AiResultRow>(
        "SELECT * FROM ai_results WHERE organization_id=$1 AND id=$2",
        [org, row.result_id],
      )
    )[0];
    return {
      jobId: row.id,
      resultId: row.result_id,
      status: row.status,
      attempts: row.attempts,
      error: row.last_error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      elapsedSeconds: Math.max(
        0,
        Math.floor(
          ((row.finished_at?.getTime() ?? Date.now()) -
            (row.started_at ?? row.created_at).getTime()) /
            1000,
        ),
      ),
      stage:
        row.status === "queued"
          ? "queued"
          : row.status === "running"
            ? "preparing"
            : "finished",
      result: result?.status === "completed" ? this.result(result) : null,
    };
  }
  async usage(org: string, month: string) {
    return {
      month,
      operations: await this.db.query<{
        operation: string;
        model: string;
        requests: string;
        input_tokens: string | null;
        output_tokens: string | null;
        cost_usd: string | null;
      }>(
        "SELECT operation,model,count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(cost_usd) cost_usd FROM ai_usage WHERE organization_id=$1 AND month=$2 GROUP BY operation,model",
        [org, month],
      ),
    };
  }
  async brandLogos(org: string) {
    const rows = await this.db.query<{ brand: string; asset_id: string }>(
      "SELECT DISTINCT ON (brand) brand,asset_id FROM brand_assets WHERE organization_id=$1 ORDER BY brand,version DESC",
      [org],
    );
    return Object.fromEntries(
      rows.map((x) => [x.brand, `/api/assets/${x.asset_id}`]),
    );
  }
  result(row: AiResultRow): JsonObject {
    return {
      ...(row.operation === "lifestyle" ? { resultId: row.id } : {}),
      ...(row.output_json ?? {}),
      ...(row.output_asset_id
        ? {
            image: `/api/assets/${row.output_asset_id}`,
            ...(row.operation === "brand_prep"
              ? { url: `/api/assets/${row.output_asset_id}` }
              : {}),
          }
        : {}),
      ...(row.output_text ? { text: row.output_text } : {}),
    };
  }
}
