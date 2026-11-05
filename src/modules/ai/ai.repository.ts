import { findReusableCutouts, type CutoutReuseItem } from "./cutout-reuse";
import { normalizeAiParams } from "./domain/params";
import { reserveBillableAiRequest } from "../../security/request-limits";
import { validatedCutoutResult } from "./domain/cutout-validation";
import { rejectSavedCutout } from "./cutout-rejection";
import { findExactCatalogPhoto } from "./exact-catalog-photo";
import {
  productImageSearchInputSchema,
  productImageSearchCacheIdentity,
} from "./domain/product-image-search";
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
import { requireSocialContextAccess } from "../auth/domain/workspace-access";
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
  async reuseCutouts(actor: Actor, items: CutoutReuseItem[]) {
    return {
      items: await findReusableCutouts(this.db, actor.organizationId, items),
    };
  }
  async enqueue(actor: Actor, request: AiRequest): Promise<AiTicket> {
    const input = normalizeAiParams(request.operation, request.params);
    requireSocialContextAccess(actor, input.context);
    if (request.operation === "product_image_search") {
      const existingPhoto = await findExactCatalogPhoto(this.db, actor, input);
      if (existingPhoto) return existingPhoto;
    }
    const params = [
      "proofread",
      "text_generate",
      "product_image_search",
    ].includes(request.operation)
      ? input
      : request.operation === "cutout"
        ? await this.cutoutParams(actor, input)
        : await this.assets.externalize(
            actor.organizationId,
            input,
            actor.userId,
          );
    delete params.retry;
    delete params.regenerate;
    const assetIds = new Set<string>();
    const collect = (value: JsonValue, target: Set<string>): void => {
      if (Array.isArray(value)) {
        value.forEach((item) => collect(item, target));
        return;
      }
      if (value && typeof value === "object") {
        Object.values(value).forEach((item) => collect(item, target));
        return;
      }
      if (
        typeof value === "string" &&
        /^\/api\/assets\/[a-f0-9-]{36}$/.test(value)
      )
        target.add(value.slice("/api/assets/".length));
    };
    collect(params, assetIds);
    const requiredAssetIds = new Set<string>();
    const requiredParams = { ...params };
    if (request.operation === "cutout") delete requiredParams.backgroundContext;
    collect(requiredParams, requiredAssetIds);
    const sourceAssets = assetIds.size
      ? await this.db.query<{ id: string; sha256: string }>(
          "SELECT id,sha256 FROM assets WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
          [actor.organizationId, [...assetIds]],
        )
      : [];
    const byId = new Map(sourceAssets.map((row) => [row.id, row.sha256]));
    if ([...requiredAssetIds].some((id) => !byId.has(id)))
      throw new NotFoundException("Source image not found.");
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
      params:
        request.operation === "product_image_search"
          ? productImageSearchCacheIdentity(
              productImageSearchInputSchema.parse(normalized),
            )
          : normalized,
      model,
      quality,
      promptVersion: version,
      ...(request.regenerate
        ? {
            // A transport retry of the same explicit action must reattach to
            // its durable job rather than purchase another provider request.
            nonce: request.commandId
              ? `${actor.userId}:${request.commandId}`
              : randomUUID(),
          }
        : {}),
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
      if (existing?.status === "completed") {
        if (existing.operation === "cutout") {
          const available = validatedCutoutResult(existing)
            ? await client.query(
                "SELECT id FROM assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL AND metadata->>'cutoutRejected' IS DISTINCT FROM 'true'",
                [actor.organizationId, existing.output_asset_id],
              )
            : null;
          if (!available?.rows.length)
            throw new ConflictException({
              error:
                "This saved photo is not a validated cutout. Use Remove background again to prepare a new version.",
              code: "AI_CUTOUT_NOT_VALIDATED",
              resultId: existing.id,
            });
        }
        return {
          cached: true,
          status: "succeeded",
          resultId: existing.id,
          result: this.result(existing),
        };
      }
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
      if (request.operation === "cutout" && !request.regenerate) {
        // Explicit retries used nonce keys in older clients. Reopening the
        // same preparation must reattach to that paid work, without treating
        // changed instructions or background context as the same request.
        const identity = `r.organization_id=$1 AND r.operation='cutout'
          AND r.source_sha256 IS NOT DISTINCT FROM $2::text
          AND r.model=$3 AND r.quality IS NOT DISTINCT FROM $4::text
          AND r.prompt_version=$5
          AND (r.params_json - 'image')=($6::jsonb - 'image')
          AND ($2::text IS NOT NULL OR r.params_json->'image'=$6::jsonb->'image')`;
        const values = [
          actor.organizationId,
          sourceSha256,
          model,
          quality,
          version,
          params,
        ];
        const reusableJob = (
          await client.query<AiJobRow>(
            `SELECT j.* FROM ai_jobs j JOIN ai_results r ON r.organization_id=j.organization_id AND r.id=j.result_id
             WHERE ${identity} AND j.status IN ('queued','running') ORDER BY j.created_at DESC LIMIT 1`,
            values,
          )
        ).rows[0];
        if (reusableJob)
          return {
            cached: true,
            status: reusableJob.status,
            resultId: reusableJob.result_id,
            jobId: reusableJob.id,
          };
        const reusableResult = (
          await client.query<AiResultRow>(
            `SELECT r.* FROM ai_results r WHERE ${identity} AND r.status='completed'
             AND r.output_json @> '{"cutoutValidated":true,"cutoutValidationVersion":1}'::jsonb
             AND r.output_json->>'cutoutRejected' IS DISTINCT FROM 'true'
             AND EXISTS(SELECT 1 FROM assets a WHERE a.organization_id=r.organization_id AND a.id=r.output_asset_id AND a.deleted_at IS NULL AND a.metadata->>'cutoutRejected' IS DISTINCT FROM 'true')
             ORDER BY r.completed_at DESC LIMIT 1`,
            values,
          )
        ).rows[0];
        if (reusableResult && validatedCutoutResult(reusableResult))
          return {
            cached: true,
            status: "succeeded",
            resultId: reusableResult.id,
            result: this.result(reusableResult),
          };
        const uncertainResult = (
          await client.query<AiResultRow>(
            `SELECT r.* FROM ai_results r WHERE ${identity} AND r.status='uncertain'
             ORDER BY r.created_at DESC LIMIT 1`,
            values,
          )
        ).rows[0];
        if (uncertainResult)
          throw new ConflictException({
            error:
              "The provider response was interrupted. Check this job before explicitly regenerating.",
            code: "AI_RESULT_UNCERTAIN",
            resultId: uncertainResult.id,
          });
      }
      if (existing?.status === "failed")
        throw new ConflictException({
          error:
            request.operation === "cutout"
              ? "This photo preparation failed. Use Remove background again to request a new version."
              : "This AI request failed. Use Retry to start a new version.",
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
      await reserveBillableAiRequest(client, actor.organizationId);
      if (request.operation === "cutout" && request.regenerate)
        await rejectSavedCutout(
          client,
          actor.organizationId,
          request.params.rejectedImage,
          params.image,
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
  private async cutoutParams(
    actor: Actor,
    input: JsonObject,
  ): Promise<JsonObject> {
    const { backgroundContext, ...required } = input;
    // Primary sources remain mandatory, tenant-scoped and authorized. A missing
    // optional background must never prevent preparing that valid product photo.
    const params = await this.assets.externalize(
      actor.organizationId,
      required,
      actor.userId,
    );
    if (backgroundContext !== undefined) {
      try {
        const optional = await this.assets.externalize(
          actor.organizationId,
          { backgroundContext },
          actor.userId,
        );
        params.backgroundContext =
          optional.backgroundContext ?? backgroundContext;
      } catch {
        // Retain descriptive identity for signatures/cache. The provider's own
        // organization-scoped loader will omit any unavailable reference bytes.
        params.backgroundContext = backgroundContext;
      }
    }
    return params;
  }
  async job(org: string, id: string, actor?: Actor) {
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
    if (actor && result)
      requireSocialContextAccess(actor, result.params_json.context);
    const invalidCutout =
      result?.operation === "cutout" &&
      result.status === "completed" &&
      !validatedCutoutResult(result);
    const unavailableCutout =
      result?.operation === "cutout" &&
      result.status === "completed" &&
      !invalidCutout &&
      !(
        await this.db.query(
          "SELECT id FROM assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL AND metadata->>'cutoutRejected' IS DISTINCT FROM 'true'",
          [org, result.output_asset_id],
        )
      ).length;
    const rejectedCutout =
      result?.operation === "cutout" &&
      result.output_json?.cutoutRejected === true;
    const invalid = invalidCutout || unavailableCutout || rejectedCutout;
    return {
      jobId: row.id,
      resultId: row.result_id,
      status: invalid ? "failed" : row.status,
      attempts: row.attempts,
      error: invalid
        ? "This saved photo is not a validated cutout. Use Remove background again to prepare a new version."
        : row.last_error,
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
      result:
        result?.status === "completed" && !invalid ? this.result(result) : null,
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
