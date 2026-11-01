import { HttpException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";
import type { PoolClient } from "pg";
import type { Database } from "../database/database";
import { env } from "../config/environment";

export interface RateRule {
  namespace: string;
  identity: string;
  limit: number;
  seconds: number;
}
interface RateRow {
  retry_after_seconds: number;
}
type RateQuery = (sql: string, values: unknown[]) => Promise<RateRow[]>;
export interface ApiRateLimits {
  generalPerSecond: number;
  generalPerMinute: number;
  assetsPerSecond: number;
  assetsPerMinute: number;
}
export interface AiRateLimits {
  per15Minutes: number;
  perHour: number;
}

function rateKey(rule: RateRule): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`request-rate:${rule.namespace}:${rule.seconds}:${rule.identity}`)
    .digest("hex");
}
/** One atomic statement updates both windows across API instances. The table and
 * existing expiry cleanup are shared with account protection; no raw IP is stored. */
async function reserve(
  query: RateQuery,
  rules: readonly RateRule[],
): Promise<number> {
  for (const rule of rules)
    if (
      !Number.isSafeInteger(rule.limit) ||
      rule.limit < 1 ||
      !Number.isSafeInteger(rule.seconds) ||
      rule.seconds < 1
    )
      throw new Error("Invalid rate limit policy.");
  const [row] = await query(
    `WITH policy AS (
    SELECT * FROM unnest($1::text[],$2::int[],$3::int[]) AS p(key_hash,allowance,seconds)
  ), counts AS (
    INSERT INTO identity_rate_limits(key_hash,attempts,expires_at)
    SELECT key_hash,1,now()+make_interval(secs=>seconds) FROM policy ORDER BY key_hash
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts=CASE WHEN identity_rate_limits.expires_at<=now() THEN 1
        WHEN identity_rate_limits.attempts<2147483647 THEN identity_rate_limits.attempts+1 ELSE 2147483647 END,
      expires_at=CASE WHEN identity_rate_limits.expires_at<=now() THEN EXCLUDED.expires_at ELSE identity_rate_limits.expires_at END
    RETURNING key_hash,attempts,expires_at
  ) SELECT coalesce(max(greatest(1,ceil(extract(epoch FROM (c.expires_at-now())))::int))
    FILTER (WHERE c.attempts>p.allowance),0)::int retry_after_seconds
    FROM counts c JOIN policy p USING(key_hash)`,
    [
      rules.map(rateKey),
      rules.map((rule) => rule.limit),
      rules.map((rule) => rule.seconds),
    ],
  );
  return row?.retry_after_seconds ?? 0;
}

/** Normalize literal addresses only. Forwarded headers are deliberately never
 * read here; a verified edge resolver can provide its authenticated address. */
export function normalizeClientIp(value: string | undefined): string {
  if (!value || value.includes("%") || !isIP(value)) return "unknown";
  if (value.toLowerCase().startsWith("::ffff:") && isIP(value.slice(7)) === 4)
    return value.slice(7);
  if (isIP(value) !== 6) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i.exec(normalized);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16),
      low = Number.parseInt(mapped[2]!, 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return normalized;
}
export function isAssetRead(
  request: Pick<Request, "method" | "originalUrl">,
): boolean {
  return (
    ["GET", "HEAD"].includes(request.method) &&
    request.originalUrl.split("?")[0]!.toLowerCase().startsWith("/api/assets/")
  );
}

/** Install after the verified edge gate and before any JSON/raw body parser.
 * Health checks and browser metadata do not consume API budgets. */
export function apiRateLimitMiddleware(
  db: Pick<Database, "query">,
  resolveClientIp: (request: Request) => string | undefined = (request) =>
    request.socket.remoteAddress,
  limits: ApiRateLimits = {
    generalPerSecond: env.API_RATE_LIMIT_PER_SECOND,
    generalPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
    assetsPerSecond: env.ASSET_RATE_LIMIT_PER_SECOND,
    assetsPerMinute: env.ASSET_RATE_LIMIT_PER_MINUTE,
  },
): RequestHandler {
  // A flood rejected here never queues another database query. PostgreSQL remains
  // authoritative across processes; this cache is only an emergency load shield.
  const recent = new Map<string, { pending: number; blockedUntil: number }>();
  let pending = 0;
  const maxEntries = 4096,
    maxPending = 256;
  return (request, response, next) => {
    const reject = (retryAfterSeconds: number) => {
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response
        .status(429)
        .json({
          error: "Too many requests. Please try again later.",
          code: "API_RATE_LIMITED",
          retryAfterSeconds,
        });
    };
    if (!request.originalUrl.split("?")[0]!.toLowerCase().startsWith("/api/")) {
      next();
      return;
    }
    const assets = isAssetRead(request);
    const namespace = assets ? "asset-read" : "api";
    const identity = normalizeClientIp(resolveClientIp(request));
    const key = `${namespace}:${identity}`,
      now = Date.now();
    let entry = recent.get(key);
    if (entry) {
      recent.delete(key);
      recent.set(key, entry);
    }
    if (entry && entry.blockedUntil > now) {
      reject(Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)));
      return;
    }
    if (pending >= maxPending) {
      reject(1);
      return;
    }
    if (!entry) {
      if (recent.size >= maxEntries) {
        for (const [oldKey, old] of recent)
          if (!old.pending) {
            recent.delete(oldKey);
            break;
          }
      }
      entry = { pending: 0, blockedUntil: 0 };
      recent.set(key, entry);
    }
    const state = entry;
    const clientPendingLimit = assets
      ? limits.assetsPerSecond
      : limits.generalPerSecond;
    if (state.pending >= clientPendingLimit) {
      state.blockedUntil = now + 1000;
      reject(1);
      return;
    }
    pending += 1;
    state.pending += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      pending -= 1;
      state.pending -= 1;
      if (
        !state.pending &&
        state.blockedUntil <= Date.now() &&
        recent.get(key) === state
      )
        recent.delete(key);
    };
    void reserve(
      (sql, values) => db.query<RateRow>(sql, values),
      [
        {
          namespace,
          identity,
          seconds: 1,
          limit: assets ? limits.assetsPerSecond : limits.generalPerSecond,
        },
        {
          namespace,
          identity,
          seconds: 60,
          limit: assets ? limits.assetsPerMinute : limits.generalPerMinute,
        },
      ],
    )
      .then((retryAfterSeconds) => {
        if (retryAfterSeconds)
          state.blockedUntil = Date.now() + retryAfterSeconds * 1000;
        release();
        if (response.destroyed) return;
        if (!retryAfterSeconds) {
          next();
          return;
        }
        reject(retryAfterSeconds);
      })
      .catch((error: unknown) => {
        state.blockedUntil = Date.now() + 1000;
        release();
        next(error);
      });
  };
}

/** Reserve only after every reuse path and within the same transaction as the
 * new job. Rejected or rolled-back jobs never consume billable quota. */
export async function reserveBillableAiRequest(
  client: PoolClient,
  organizationId: string,
  limits: AiRateLimits = {
    per15Minutes: env.AI_NEW_JOBS_LIMIT_15_MINUTES,
    perHour: env.AI_NEW_JOBS_LIMIT_PER_HOUR,
  },
): Promise<void> {
  const retryAfterSeconds = await reserve(
    async (sql, values) => (await client.query<RateRow>(sql, values)).rows,
    [
      {
        namespace: "new-ai-job",
        identity: organizationId,
        seconds: 900,
        limit: limits.per15Minutes,
      },
      {
        namespace: "new-ai-job",
        identity: organizationId,
        seconds: 3600,
        limit: limits.perHour,
      },
    ],
  );
  if (retryAfterSeconds)
    throw new HttpException(
      {
        error: "Too many new AI requests. Please wait and try again.",
        code: "AI_RATE_LIMITED",
        retryAfterSeconds,
      },
      429,
    );
}
