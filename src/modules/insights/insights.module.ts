import {
  Controller,
  Get,
  Inject,
  Module,
  Query,
  Req,
  ForbiddenException,
} from "@nestjs/common";
import { z } from "zod";
import { Database } from "../../database/database";
import { env } from "../../config/environment";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import type { JsonObject } from "../../shared/json";
import {
  estimateAiCost,
  PRICING_URL,
  PRICING_VERSION,
} from "../ai/domain/pricing";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

export const usageFilters = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    group: z.enum(["day", "month"]).default("day"),
    operation: z.string().max(100).default(""),
    model: z.string().max(100).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine(
    (x) => !x.from || !x.to || x.from <= x.to,
    "The end date must follow the start date.",
  );
type Filters = z.infer<typeof usageFilters>;
interface UsageRow {
  id: string;
  operation: string;
  model: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_usd: string | null;
  pricing_version: string | null;
  usage_json: JsonObject;
  created_at: Date;
  status: string;
  email: string | null;
  context: string | null;
  source: string;
  subject: string;
}
function requireSuperadmin(req: AuthenticatedRequest) {
  if (req.actor.accountRole !== "superadmin")
    throw new ForbiddenException("Only superadmins can view project usage.");
  return req.actor.organizationId;
}
export class InsightsRepository {
  private storageCache = new Map<
    string,
    {
      expires: number;
      result: { objects: number; bytes: number; checkedAt: string };
    }
  >();
  constructor(@Inject(Database) private readonly db: Database) {}
  async ai(org: string, filters: Filters) {
    const rows = await this.db.query<UsageRow>(
      `
      WITH history AS (
        SELECT u.id,u.operation,u.model,u.input_tokens,u.output_tokens,u.cost_usd,u.pricing_version,u.usage_json,
          u.created_at,coalesce(j.status,'succeeded') status,usr.email,r.params_json->>'context' context,'provider' source,
          coalesce(r.params_json->>'name',r.params_json->>'brand',r.params_json->'context'->>'campaignName',CASE WHEN jsonb_typeof(r.params_json->'context')='string' THEN r.params_json->>'context' END,'') subject
        FROM ai_usage u LEFT JOIN ai_jobs j ON j.organization_id=u.organization_id AND j.id=u.job_id
        LEFT JOIN ai_results r ON r.organization_id=j.organization_id AND r.id=j.result_id
        LEFT JOIN users usr ON usr.id=u.user_id WHERE u.organization_id=$1
        UNION ALL
        SELECT r.id,r.operation,r.model,r.input_tokens,r.output_tokens,r.cost_usd,NULL,'{}'::jsonb,
          coalesce(r.completed_at,r.created_at),r.status,usr.email,r.params_json->>'context','unmetered',
          coalesce(r.params_json->>'name',r.params_json->>'brand',r.params_json->'context'->>'campaignName',CASE WHEN jsonb_typeof(r.params_json->'context')='string' THEN r.params_json->>'context' END,'')
        FROM ai_results r LEFT JOIN users usr ON usr.id=r.created_by
        WHERE r.organization_id=$1 AND r.status IN ('completed','failed','uncertain')
          AND NOT (coalesce(r.input_tokens,-1)=0 AND coalesce(r.output_tokens,-1)=0 AND coalesce(r.cost_usd,-1)=0)
          AND NOT EXISTS(SELECT 1 FROM ai_jobs j JOIN ai_usage u ON u.organization_id=j.organization_id AND u.job_id=j.id WHERE j.organization_id=r.organization_id AND j.result_id=r.id)
      ) SELECT * FROM history WHERE ($2::date IS NULL OR created_at >= ($2::date::timestamp AT TIME ZONE 'Europe/Belgrade'))
        AND ($3::date IS NULL OR created_at < (($3::date+1)::timestamp AT TIME ZONE 'Europe/Belgrade'))
        AND ($4='' OR (operation=$4 AND ($4<>'background' OR context IS DISTINCT FROM 'tv')) OR ($4='tv_artwork' AND operation='background' AND context='tv'))
        AND ($5='' OR model=$5) ORDER BY created_at DESC,id DESC`,
      [
        org,
        filters.from ?? null,
        filters.to ?? null,
        filters.operation,
        filters.model,
      ],
    );
    const records = rows.map((row) => {
      const usage = {
        inputTokens:
          row.input_tokens === null ? null : Number(row.input_tokens),
        outputTokens:
          row.output_tokens === null ? null : Number(row.output_tokens),
        usageJson: row.usage_json,
      };
      const estimate = estimateAiCost(row.model, row.operation, usage);
      const recorded = row.cost_usd === null ? null : Number(row.cost_usd);
      return {
        id: row.id,
        operation:
          row.operation === "background" && row.context === "tv"
            ? "tv_artwork"
            : row.operation,
        model: row.model,
        ...usage,
        costUsd: recorded ?? estimate.costUsd,
        minimumUsd: recorded ?? estimate.minimumUsd,
        maximumUsd: recorded ?? estimate.maximumUsd,
        costBasis:
          recorded !== null
            ? row.pricing_version
              ? "estimated"
              : "recorded"
            : estimate.basis,
        pricingVersion: row.pricing_version ?? PRICING_VERSION,
        createdAt: row.created_at.toISOString(),
        status: row.status,
        user: row.email,
        source: row.source,
        subject: row.subject,
        requestId:
          typeof row.usage_json.provider_request_id === "string"
            ? row.usage_json.provider_request_id
            : null,
      };
    });
    const empty = () => ({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      minimumUsd: 0,
      maximumUsd: 0 as number | null,
      unknownCosts: 0,
      unknownTokens: 0,
      partialCosts: 0,
    });
    type Totals = ReturnType<typeof empty>;
    const add = (total: Totals, item: (typeof records)[number]) => {
      total.requests++;
      total.inputTokens += item.inputTokens ?? 0;
      total.outputTokens += item.outputTokens ?? 0;
      total.costUsd += item.costUsd ?? 0;
      total.minimumUsd += item.minimumUsd ?? 0;
      if (item.minimumUsd !== null && item.maximumUsd === null)
        total.maximumUsd = null;
      else if (total.maximumUsd !== null)
        total.maximumUsd += item.maximumUsd ?? 0;
      if (item.costBasis === "unknown") total.unknownCosts++;
      else if (item.costUsd === null) total.partialCosts++;
      if (item.inputTokens === null || item.outputTokens === null)
        total.unknownTokens++;
    };
    const summary = empty(),
      operations = new Map<
        string,
        Totals & { operation: string; model: string }
      >(),
      timeline = new Map<string, Totals & { date: string }>();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    for (const item of records) {
      add(summary, item);
      const key = item.operation + ":" + item.model;
      const group = operations.get(key) ?? {
        ...empty(),
        operation: item.operation,
        model: item.model,
      };
      add(group, item);
      operations.set(key, group);
      const date = formatter
        .format(new Date(item.createdAt))
        .slice(0, filters.group === "month" ? 7 : 10);
      const bucket = timeline.get(date) ?? { ...empty(), date };
      add(bucket, item);
      timeline.set(date, bucket);
    }
    const options = await this.db.query<{ operation: string; model: string }>(
      "SELECT DISTINCT operation,model FROM ai_results WHERE organization_id=$1 UNION SELECT DISTINCT operation,model FROM ai_usage WHERE organization_id=$1",
      [org],
    );
    return {
      filters,
      timeZone: "Europe/Belgrade",
      currency: "USD",
      pricingUrl: PRICING_URL,
      pricingVersion: PRICING_VERSION,
      summary,
      operations: [...operations.values()],
      timeline: [...timeline.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      options: {
        operations: [
          ...new Set([...options.map((x) => x.operation), "tv_artwork"]),
        ],
        models: [...new Set(options.map((x) => x.model))],
      },
      records: records.slice(
        (filters.page - 1) * filters.limit,
        filters.page * filters.limit,
      ),
      total: records.length,
    };
  }
  async media(org: string) {
    const kinds = await this.db.query<{
      kind: string;
      count: string;
      bytes: string;
    }>(
      "SELECT kind,count(*)::text count,coalesce(sum(size),0)::text bytes FROM assets WHERE organization_id=$1 AND deleted_at IS NULL GROUP BY kind ORDER BY sum(size) DESC",
      [org],
    );
    const prepared = await this.db.query<{ operation: string; count: string }>(
      "SELECT r.operation,count(DISTINCT r.output_asset_id)::text count FROM ai_results r JOIN assets a ON a.organization_id=r.organization_id AND a.id=r.output_asset_id AND a.deleted_at IS NULL WHERE r.organization_id=$1 AND r.status='completed' GROUP BY r.operation",
      [org],
    );
    const [linked] = await this.db.query<{
      products: string;
      brands: string;
      aliases: string;
      variants: string;
    }>(
      `SELECT
      (SELECT count(*) FROM products WHERE organization_id=$1 AND deleted_at IS NULL AND primary_asset_id IS NOT NULL)::text products,
      (SELECT count(DISTINCT brand) FROM brand_assets WHERE organization_id=$1)::text brands,
      (SELECT count(*) FROM asset_aliases WHERE organization_id=$1)::text aliases,
      (SELECT count(*) FROM asset_variants WHERE organization_id=$1)::text variants`,
      [org],
    );
    let bucket: { objects: number; bytes: number; checkedAt: string } | null =
      null;
    let bucketError = false;
    if (env.STORAGE_DRIVER === "r2") {
      const cached = this.storageCache.get(org);
      if (cached && cached.expires > Date.now()) bucket = cached.result;
      else {
        const client = new S3Client({
          region: "auto",
          endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          },
          requestHandler: { requestTimeout: 15000 },
        });
        try {
          let token: string | undefined;
          let objects = 0,
            bytes = 0;
          do {
            const page = await client.send(
              new ListObjectsV2Command({
                Bucket: env.R2_BUCKET,
                Prefix: `org/${org}/`,
                ContinuationToken: token,
              }),
            );
            for (const item of page.Contents ?? []) {
              objects++;
              bytes += item.Size ?? 0;
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined;
          } while (token);
          bucket = { objects, bytes, checkedAt: new Date().toISOString() };
          this.storageCache.set(org, {
            expires: Date.now() + 60000,
            result: bucket,
          });
        } catch {
          bucketError = true;
        } finally {
          client.destroy();
        }
      }
    }
    return {
      driver: env.STORAGE_DRIVER,
      bucketName: env.STORAGE_DRIVER === "r2" ? env.R2_BUCKET : null,
      bucket,
      bucketError,
      registered: {
        objects: kinds.reduce((n, x) => n + Number(x.count), 0),
        bytes: kinds.reduce((n, x) => n + Number(x.bytes), 0),
      },
      kinds: kinds.map((x) => ({
        ...x,
        count: Number(x.count),
        bytes: Number(x.bytes),
      })),
      prepared: prepared.map((x) => ({ ...x, count: Number(x.count) })),
      linked: Object.fromEntries(
        Object.entries(linked ?? {}).map(([k, v]) => [k, Number(v)]),
      ),
    };
  }
  async database(org: string) {
    const [counts] = await this.db.query<{
      products: string;
      campaigns: string;
      posts: string;
      assets: string;
      members: string;
      aiResults: string;
      catalogRuns: string;
    }>(
      `SELECT
      (SELECT count(*) FROM products WHERE organization_id=$1 AND deleted_at IS NULL)::text products,
      (SELECT count(*) FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL)::text campaigns,
      (SELECT count(*) FROM social_posts WHERE organization_id=$1 AND deleted_at IS NULL)::text posts,
      (SELECT count(*) FROM assets WHERE organization_id=$1 AND deleted_at IS NULL)::text assets,
      (SELECT count(*) FROM memberships WHERE organization_id=$1)::text members,
      (SELECT count(*) FROM ai_results WHERE organization_id=$1)::text "aiResults",
      (SELECT count(*) FROM catalog_sync_runs WHERE organization_id=$1)::text "catalogRuns"`,
      [org],
    );
    const [size] = await this.db.query<{ bytes: string }>(
      "SELECT pg_database_size(current_database())::text bytes",
    );
    const tables = await this.db.query<{ name: string; bytes: string }>(
      "SELECT relname name,pg_total_relation_size(relid)::text bytes FROM pg_catalog.pg_statio_user_tables WHERE schemaname='public' ORDER BY pg_total_relation_size(relid) DESC LIMIT 12",
    );
    return {
      counts: Object.fromEntries(
        Object.entries(counts ?? {}).map(([k, v]) => [k, Number(v)]),
      ),
      bytes: Number(size?.bytes ?? 0),
      tables: tables.map((x) => ({ ...x, bytes: Number(x.bytes) })),
      checkedAt: new Date().toISOString(),
    };
  }
}
@Controller("api/insights")
export class InsightsController {
  constructor(
    @Inject(InsightsRepository) private readonly repository: InsightsRepository,
  ) {}
  @Get("ai") ai(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    return this.repository.ai(
      requireSuperadmin(req),
      usageFilters.parse(query),
    );
  }
  @Get("media") media(@Req() req: AuthenticatedRequest) {
    return this.repository.media(requireSuperadmin(req));
  }
  @Get("database") database(@Req() req: AuthenticatedRequest) {
    return this.repository.database(requireSuperadmin(req));
  }
}
@Module({ controllers: [InsightsController], providers: [InsightsRepository] })
export class InsightsModule {}
