import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Injectable,
  Module,
  Query,
  Req,
} from "@nestjs/common";
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { catchError, mergeMap } from "rxjs";
import type { Observable } from "rxjs";
import { z, ZodError } from "zod";
import { Database } from "../../database/database";
import { logger } from "../../shared/logger";
import { AuthRepository } from "../auth/auth.repository";
import { sessionToken } from "../auth/auth.guard";
import type { Actor, AuthenticatedRequest } from "../auth/domain/actor";

export const activityFilters = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    actor: z.uuid().optional(),
    action: z.string().max(120).default(""),
    outcome: z.enum(["", "success", "failure"]).default(""),
    search: z.string().trim().max(150).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine(
    (x) => !x.from || !x.to || x.from <= x.to,
    "The end date must follow the start date.",
  );
type Filters = z.infer<typeof activityFilters>;
type AuditActor = Pick<Actor, "organizationId" | "userId" | "accountRole">;
interface Entry {
  action: string;
  targetType: string;
  targetId: string | null;
  method: string;
  route: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identifier = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value
    : null;
const aiOperations = new Set([
  "cutout",
  "brand_prep",
  "background",
  "lifestyle",
  "proofread",
  "text_generate",
  "placement",
  "detect_screen",
  "product_image_search",
]);
const legacyAi: Record<string, string> = {
  "ai-remove-background": "cutout",
  "ai-white-brand-logo": "brand_prep",
  "ai-proofread": "proofread",
  "ai-generate-background": "background",
  "ai-lifestyle": "lifestyle",
  "ai-suggest-placement": "placement",
  "ai-detect-screen": "detect_screen",
  "ai-find-product-image": "product_image_search",
};
/** Only route templates and allowlisted identifiers/operations enter the ledger. Never store bodies or query strings. */
export function activityEntry(request: Request): Entry | null {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return null;
  const raw: unknown = request.route?.path;
  if (typeof raw !== "string") return null;
  const route = raw.split("?")[0] ?? "";
  if (!/^\/api\/[A-Za-z0-9_/:.-]+$/.test(route) || route.includes("/presence"))
    return null;
  const body = object(request.body),
    params = object(request.params);
  const id = identifier(params.id);
  const entry = (action: string, targetType: string, targetId = id): Entry => ({
    action,
    targetType,
    targetId,
    method: request.method,
    route,
  });
  if (route === "/api/team/campaigns")
    return entry(
      "campaign.save",
      "campaign",
      identifier(object(body.campaign).id),
    );
  if (route === "/api/team/posts")
    return entry("post.save", "post", identifier(object(body.post).id));
  if (route === "/api/team/campaigns/:id/review")
    return entry(
      `campaign.${typeof body.action === "string" && ["comment", "reply", "fix", "submit", "complete", "reopen"].includes(body.action) ? body.action : "review"}`,
      "campaign",
    );
  if (route === "/api/team/campaigns/:id")
    return entry("campaign.disable", "campaign");
  if (route === "/api/team/posts/:id") return entry("post.disable", "post");
  if (route === "/api/team/campaigns/:id/restore")
    return entry("campaign.restore", "campaign");
  if (route === "/api/team/posts/:id/restore")
    return entry("post.restore", "post");
  if (route === "/api/team/settings") return entry("settings.save", "settings");
  if (route === "/api/catalog/refresh")
    return entry("catalog.refresh", "catalog");
  if (route === "/api/products/batch")
    return entry("products.load", "products");
  if (route === "/api/assets/uploads")
    return entry("image.upload-request", "upload");
  if (route === "/api/assets/uploads/:id")
    return entry("image.upload", "upload");
  if (route === "/api/assets/uploads/:id/confirm")
    return entry("image.upload-confirm", "upload");
  if (route === "/api/ai/jobs")
    return entry(
      `ai.${typeof body.operation === "string" && aiOperations.has(body.operation) ? body.operation : "request"}`,
      "ai",
    );
  const legacy = legacyAi[route.slice("/api/".length)];
  if (legacy) return entry(`ai.${legacy}`, "ai");
  if (route === "/api/ai/lifestyle/:id/accept")
    return entry("ai.lifestyle-accept", "ai");
  if (route === "/api/team/users/invite") return entry("user.invite", "user");
  if (route === "/api/team/users/:id") return entry("user.update", "user");
  if (route === "/api/team/users/:id/resend-invite")
    return entry("user.resend-invite", "user");
  if (route === "/api/team/login") return entry("account.login", "account");
  if (route === "/api/team/logout") return entry("account.logout", "account");
  if (route === "/api/team/change-password")
    return entry("account.change-password", "account");
  // Cover future authenticated write routes without capturing untrusted strings.
  return entry(`request.${request.method.toLowerCase()}`, "workspace");
}

@Injectable()
export class ActivityRepository {
  constructor(@Inject(Database) private readonly db: Database) {}
  async loginActor(email: unknown): Promise<AuditActor | null> {
    if (typeof email !== "string" || !z.email().safeParse(email.trim()).success)
      return null;
    const [row] = await this.db.query<{
      user_id: string;
      organization_id: string;
      account_role: Actor["accountRole"];
    }>(
      "SELECT u.id user_id,m.organization_id,m.account_role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=$1 ORDER BY m.organization_id LIMIT 1",
      [email.trim().toLowerCase()],
    );
    return row
      ? {
          userId: row.user_id,
          organizationId: row.organization_id,
          accountRole: row.account_role,
        }
      : null;
  }
  async record(
    actor: AuditActor,
    entry: Entry,
    ip: string | undefined,
    status: number,
    started: number,
    requestId: string,
  ) {
    await this.db.query(
      `INSERT INTO activity_audit(organization_id,actor_id,actor_role,action,target_type,target_id,method,route,source_ip,status_code,duration_ms,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        actor.organizationId,
        actor.userId,
        actor.accountRole ?? "staff",
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.method,
        entry.route,
        ip && isIP(ip) ? ip : null,
        status,
        Math.min(2147483647, Math.max(0, Date.now() - started)),
        requestId,
      ],
    );
  }
  async list(actor: Actor, filters: Filters) {
    if (actor.accountRole !== "admin" && actor.accountRole !== "superadmin")
      throw new ForbiddenException(
        "Only workspace administrators can view activity.",
      );
    const includeSupport = actor.accountRole === "superadmin";
    const history = `WITH history AS (
      SELECT a.id,a.organization_id,a.actor_id,a.actor_role,a.action,a.target_type,a.target_id,a.method,a.route,
        host(a.source_ip) source_ip,a.status_code,a.duration_ms,a.request_id,a.created_at,'activity' source
      FROM activity_audit a WHERE ($2 OR a.organization_id=$1)
      UNION ALL
      SELECT a.id,a.organization_id,coalesce(a.actor_id,a.user_id),coalesce(m.account_role,'staff'),a.action,'user',a.user_id::text,
        NULL,NULL,NULL,NULL,NULL,NULL,a.created_at,'account-history'
      FROM account_audit a LEFT JOIN memberships m ON m.organization_id=a.organization_id AND m.user_id=coalesce(a.actor_id,a.user_id)
      WHERE ($2 OR a.organization_id=$1)
    ), visible AS (
      SELECT h.*,u.name actor_name,u.email actor_email,o.name organization_name FROM history h LEFT JOIN users u ON u.id=h.actor_id JOIN organizations o ON o.id=h.organization_id
      WHERE ($2 OR (h.actor_role IN ('admin','staff','pm') AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=h.organization_id AND m.user_id=h.actor_id AND m.account_role='superadmin')
        AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=h.organization_id AND m.user_id::text=h.target_id AND m.account_role='superadmin')))
    )`;
    const conditions = `WHERE ($3::date IS NULL OR created_at>=($3::date::timestamp AT TIME ZONE 'Europe/Belgrade'))
      AND ($4::date IS NULL OR created_at<(($4::date+1)::timestamp AT TIME ZONE 'Europe/Belgrade'))
      AND ($5::uuid IS NULL OR actor_id=$5) AND ($6='' OR action=$6)
      AND ($7='' OR ($7='success' AND (status_code<400 OR source='account-history')) OR ($7='failure' AND status_code>=400))
      AND ($8='' OR concat_ws(' ',actor_name,actor_email,action,target_type,target_id,source_ip) ILIKE '%'||$8||'%')`;
    const values = [
      actor.organizationId,
      includeSupport,
      filters.from ?? null,
      filters.to ?? null,
      filters.actor ?? null,
      filters.action,
      filters.outcome,
      filters.search.replace(/[\\%_]/g, "\\$&"),
    ];
    const [count] = await this.db.query<{ total: string }>(
      `${history} SELECT count(*)::text total FROM visible ${conditions}`,
      values,
    );
    const rows = await this.db.query<{
      id: string;
      organization_id: string;
      organization_name: string;
      actor_id: string | null;
      actor_name: string | null;
      actor_email: string | null;
      actor_role: string;
      action: string;
      target_type: string;
      target_id: string | null;
      method: string | null;
      route: string | null;
      source_ip: string | null;
      status_code: number | null;
      duration_ms: number | null;
      request_id: string | null;
      created_at: Date;
      source: string;
    }>(
      `${history} SELECT * FROM visible ${conditions} ORDER BY created_at DESC,id DESC LIMIT $9 OFFSET $10`,
      [...values, filters.limit, (filters.page - 1) * filters.limit],
    );
    const users = await this.db.query<{
      id: string;
      name: string;
      email: string;
    }>(
      `${history} SELECT DISTINCT actor_id id,coalesce(actor_name,'') name,coalesce(actor_email,'') email FROM visible WHERE actor_id IS NOT NULL ORDER BY email`,
      [actor.organizationId, includeSupport],
    );
    const actions = await this.db.query<{ action: string }>(
      `${history} SELECT DISTINCT action FROM visible ORDER BY action`,
      [actor.organizationId, includeSupport],
    );
    return {
      timeZone: "Europe/Belgrade",
      scope: includeSupport ? "all-organizations" : "organization",
      total: Number(count?.total ?? 0),
      page: filters.page,
      limit: filters.limit,
      users,
      actions: actions.map((row) => row.action),
      records: rows.map((row) => ({
        id: row.id,
        organization: { id: row.organization_id, name: row.organization_name },
        actor: {
          id: row.actor_id,
          name: row.actor_name ?? "",
          email: row.actor_email ?? "",
          role: row.actor_role,
        },
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        method: row.method,
        route: row.route,
        ip: row.source_ip,
        statusCode: row.status_code,
        outcome:
          row.status_code !== null && row.status_code >= 400
            ? "failure"
            : "success",
        durationMs: row.duration_ms,
        requestId: row.request_id,
        createdAt: row.created_at.toISOString(),
        source: row.source,
      })),
    };
  }
}

@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  constructor(
    @Inject(ActivityRepository) private readonly repository: ActivityRepository,
    @Inject(AuthRepository) private readonly auth: AuthRepository,
  ) {}
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>(),
      response = context.switchToHttp().getResponse<Response>();
    const entry = activityEntry(request);
    if (!entry) return next.handle();
    const started = Date.now(),
      requestId = randomUUID();
    let actor: AuditActor | null = request.actor ?? null;
    if (entry.action === "account.logout")
      actor = await this.auth.session(sessionToken(request));
    const save = async (status: number, result?: unknown) => {
      try {
        if (entry.action === "account.login")
          actor = await this.repository.loginActor(object(request.body).email);
        if (!actor) return;
        const data = object(result);
        if (!entry.targetId && entry.targetType === "user")
          entry.targetId = identifier(object(data.user).id);
        if (!entry.targetId && entry.targetType === "ai")
          entry.targetId = identifier(data.jobId);
        await this.repository.record(
          actor,
          entry,
          request.ip,
          status,
          started,
          requestId,
        );
      } catch {
        // A logging outage must not turn a completed write into a misleading retry.
        logger.warn({ requestId }, "Activity record could not be persisted");
      }
    };
    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        await save(response.statusCode, result);
        return result;
      }),
      catchError(async (error: unknown) => {
        await save(
          error instanceof ZodError
            ? 400
            : error instanceof HttpException
              ? error.getStatus()
              : 500,
        );
        throw error;
      }),
    );
  }
}

@Controller("api/activity")
export class ActivityController {
  constructor(
    @Inject(ActivityRepository) private readonly repository: ActivityRepository,
  ) {}
  @Get() list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.repository.list(request.actor, activityFilters.parse(query));
  }
}
@Module({
  controllers: [ActivityController],
  providers: [
    ActivityRepository,
    { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor },
  ],
})
export class ActivityModule {}
