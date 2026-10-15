import {
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { Database } from "../../database/database";
import type { Actor } from "../auth/domain/actor";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { DocumentAssets } from "../assets/document-assets";
import {
  campaignSchema,
  postSchema,
  documentSnapshot,
} from "./domain/document";
import type {
  Campaign,
  Post,
  DocumentKind,
  DocumentRow,
} from "./domain/document";
import { applyReview } from "./domain/review";
import type { ReviewInput } from "./domain/review";
import type { JsonObject } from "../../shared/json";
import { databasePrice } from "../../shared/price";
const tables = { campaign: "campaigns", post: "social_posts" } as const;
@Injectable()
export class DocumentsRepository {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DocumentAssets) private readonly assets: DocumentAssets,
    @Inject(NotificationsRepository)
    private readonly notifications: NotificationsRepository,
  ) {}
  async list(
    organizationId: string,
    kind: DocumentKind,
    includeDisabled = false,
  ): Promise<(Campaign | Post)[]> {
    const rows = await this.db.query<DocumentRow>(
      `SELECT id,layout,version,updated_at,deleted_at${kind === "campaign" ? ",status" : ""} FROM ${tables[kind]} WHERE organization_id=$1 ${includeDisabled ? "" : "AND deleted_at IS NULL"} ORDER BY updated_at DESC`,
      [organizationId],
    );
    return rows.map((row) => documentSnapshot(row, kind));
  }
  async get(
    organizationId: string,
    kind: DocumentKind,
    id: string,
    includeDisabled = false,
  ): Promise<Campaign | Post> {
    const row = (
      await this.db.query<DocumentRow>(
        `SELECT id,layout,version,updated_at,deleted_at${kind === "campaign" ? ",status" : ""} FROM ${tables[kind]} WHERE organization_id=$1 AND id=$2 ${includeDisabled ? "" : "AND deleted_at IS NULL"}`,
        [organizationId, id],
      )
    )[0];
    if (!row) throw new NotFoundException("Document not found.");
    return documentSnapshot(row, kind);
  }
  async save(
    actor: Actor,
    kind: DocumentKind,
    input: Campaign | Post,
    importing = false,
  ): Promise<Campaign | Post> {
    const parsed =
      kind === "campaign"
        ? campaignSchema.parse(input)
        : postSchema.parse(input);
    const document = await this.assets.externalize(
      actor.organizationId,
      parsed,
      actor.userId,
    );
    return this.db.transaction(async (client) => {
      // Serializes creation too; row locking alone cannot lock a not-yet-created document.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${actor.organizationId}:${kind}:${input.id}`],
      );
      const existing = (
        await client.query<DocumentRow>(
          `SELECT id,layout,version,updated_at${kind === "campaign" ? ",status" : ""},deleted_at FROM ${tables[kind]} WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
          [actor.organizationId, input.id],
        )
      ).rows[0];
      if (existing?.deleted_at) this.disabled(actor);
      if (importing && existing) return documentSnapshot(existing, kind);
      if (existing && input.version !== existing.version)
        throw new ConflictException({
          error:
            "This document was changed by another team member. Reload it before saving.",
          code: "VERSION_CONFLICT",
          currentVersion: existing.version,
        });
      if (!existing && input.version !== undefined && input.version !== 1)
        throw new ConflictException({
          error: "The document version is no longer available.",
          code: "VERSION_CONFLICT",
        });
      if (kind === "campaign") {
        const prior = existing
          ? campaignSchema.parse(existing.layout)
          : undefined;
        document.status = importing
          ? (parsed.status ?? "in_progress")
          : (existing?.status ??
            (parsed.status === "completed" ? "completed" : "in_progress"));
        if (!importing) {
          document.reviewComments = prior?.reviewComments ?? [];
          document.reviewHistory = prior?.reviewHistory ?? [];
        }
      }
      document.updatedAt =
        importing && typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString();
      document.updatedBy = actor.email;
      // Disable/restore are dedicated server actions. Autosave cannot forge their metadata.
      document.disabledAt = null;
      document.disabledBy = null;
      const version = (existing?.version ?? 0) + 1;
      document.version = version;
      if (kind === "campaign")
        await client.query(
          "INSERT INTO campaigns(organization_id,id,name,type,start_date,end_date,status,layout,version,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,status=EXCLUDED.status,layout=EXCLUDED.layout,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at",
          [
            actor.organizationId,
            input.id,
            document.name,
            document.type ?? "",
            document.startDate ?? "",
            document.endDate ?? "",
            document.status,
            document,
            version,
            document.updatedAt,
          ],
        );
      else
        await client.query(
          "INSERT INTO social_posts(organization_id,id,name,layout,version,updated_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,id) DO UPDATE SET name=EXCLUDED.name,layout=EXCLUDED.layout,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by",
          [
            actor.organizationId,
            input.id,
            document.name,
            document,
            version,
            document.updatedAt,
            actor.userId,
          ],
        );
      await this.version(
        client,
        actor.organizationId,
        kind,
        input.id,
        version,
        document,
      );
      if (kind === "campaign")
        await this.projections(
          client,
          actor.organizationId,
          campaignSchema.parse(document),
        );
      return kind === "campaign"
        ? campaignSchema.parse(document)
        : postSchema.parse(document);
    });
  }
  async remove(
    actor: Actor,
    kind: DocumentKind,
    id: string,
    version?: number,
  ): Promise<{ deleted: boolean }> {
    return this.db.transaction(async (client) => {
      await this.lock(client, actor.organizationId, kind, id);
      const row = (
        await client.query<DocumentRow>(
          `SELECT id,layout,version,updated_at,deleted_at${kind === "campaign" ? ",status" : ""} FROM ${tables[kind]} WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!row || row.deleted_at) {
        if (version !== undefined)
          throw new NotFoundException("Document not found.");
        return { deleted: false };
      }
      this.checkVersion(row, version);
      const at = new Date().toISOString();
      const document = {
        ...documentSnapshot(row, kind),
        disabledAt: at,
        disabledBy: actor.email,
        updatedAt: at,
        updatedBy: actor.email,
        version: row.version + 1,
      };
      await client.query(
        `UPDATE ${tables[kind]} SET deleted_at=$3,layout=$4,version=$5,updated_at=$3 WHERE organization_id=$1 AND id=$2`,
        [actor.organizationId, id, at, document, document.version],
      );
      await this.version(
        client,
        actor.organizationId,
        kind,
        id,
        document.version,
        document,
      );
      return { deleted: true };
    });
  }
  async restore(
    actor: Actor,
    kind: DocumentKind,
    id: string,
    version?: number,
  ): Promise<Campaign | Post> {
    if (actor.accountRole !== "superadmin")
      throw new ForbiddenException(
        "Only support administrators can enable disabled documents.",
      );
    return this.db.transaction(async (client) => {
      await this.lock(client, actor.organizationId, kind, id);
      const row = (
        await client.query<DocumentRow>(
          `SELECT id,layout,version,updated_at,deleted_at${kind === "campaign" ? ",status" : ""} FROM ${tables[kind]} WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Document not found.");
      this.checkVersion(row, version);
      if (!row.deleted_at) return documentSnapshot(row, kind);
      const document = {
        ...documentSnapshot(row, kind),
        disabledAt: null,
        disabledBy: null,
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: actor.email,
      };
      await client.query(
        `UPDATE ${tables[kind]} SET deleted_at=NULL,layout=$3,version=$4,updated_at=$5 WHERE organization_id=$1 AND id=$2`,
        [
          actor.organizationId,
          id,
          document,
          document.version,
          document.updatedAt,
        ],
      );
      await this.version(
        client,
        actor.organizationId,
        kind,
        id,
        document.version,
        document,
      );
      if (kind === "campaign")
        await this.projections(
          client,
          actor.organizationId,
          campaignSchema.parse(document),
        );
      return kind === "campaign"
        ? campaignSchema.parse(document)
        : postSchema.parse(document);
    });
  }
  private async lock(
    client: PoolClient,
    organizationId: string,
    kind: DocumentKind,
    id: string,
  ) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${organizationId}:${kind}:${id}`,
    ]);
  }
  private checkVersion(row: DocumentRow, version?: number) {
    if (version !== undefined && version !== row.version)
      throw new ConflictException({
        error: "The document has changed.",
        code: "VERSION_CONFLICT",
        currentVersion: row.version,
      });
  }
  private disabled(actor: Actor): never {
    if (actor.accountRole !== "superadmin")
      throw new NotFoundException("Document not found.");
    throw new ConflictException({
      error: "Enable this document before editing it.",
      code: "DOCUMENT_DISABLED",
    });
  }
  async review(
    actor: Actor,
    id: string,
    input: ReviewInput,
  ): Promise<Campaign> {
    return this.db.transaction(async (client) => {
      const row = (
        await client.query<DocumentRow>(
          "SELECT id,layout,status,version,updated_at FROM campaigns WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Campaign not found.");
      if (input.version !== undefined && input.version !== row.version)
        throw new ConflictException({
          error: "The campaign has changed.",
          code: "VERSION_CONFLICT",
          currentVersion: row.version,
        });
      const members = (
        await client.query<{ email: string }>(
          "SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.status='active' AND m.account_role<>'superadmin' AND u.email_verified_at IS NOT NULL",
          [actor.organizationId],
        )
      ).rows.map((x) => x.email);
      const campaign = applyReview(
        campaignSchema.parse(documentSnapshot(row, "campaign")),
        actor,
        input,
        members,
      );
      campaign.version = row.version + 1;
      await client.query(
        "UPDATE campaigns SET layout=$3,status=$4,version=$5,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id, campaign, campaign.status, campaign.version],
      );
      await this.version(
        client,
        actor.organizationId,
        "campaign",
        id,
        campaign.version,
        campaign,
      );
      await this.projections(client, actor.organizationId, campaign);
      await this.notifications.review(client, actor, campaign, input);
      return campaign;
    });
  }
  async rebuildProjections(organizationId: string, id: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const row = (
        await client.query<DocumentRow>(
          "SELECT id,layout,status,version,updated_at FROM campaigns WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [organizationId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Campaign not found.");
      await this.projections(
        client,
        organizationId,
        campaignSchema.parse(documentSnapshot(row, "campaign")),
      );
    });
  }
  private async version(
    client: PoolClient,
    org: string,
    kind: DocumentKind,
    id: string,
    version: number,
    snapshot: JsonObject,
  ) {
    await client.query(
      "INSERT INTO document_versions(organization_id,kind,document_id,version,snapshot) VALUES($1,$2,$3,$4,$5)",
      [org, kind, id, version, snapshot],
    );
  }
  private async projections(
    client: PoolClient,
    org: string,
    campaign: Campaign,
  ) {
    await client.query(
      "DELETE FROM campaign_products WHERE organization_id=$1 AND campaign_id=$2",
      [org, campaign.id],
    );
    if (campaign.products.length) {
      const products = campaign.products.map((snapshot, position) => ({
        code: String(snapshot.code ?? ""),
        position,
        sale: databasePrice(snapshot.sale),
        regular: databasePrice(snapshot.regular),
        snapshot,
      }));
      await client.query(
        "INSERT INTO campaign_products(organization_id,campaign_id,code,position,sale,regular,snapshot) SELECT $1,$2,x->>'code',(x->>'position')::int,(x->>'sale')::numeric,(x->>'regular')::numeric,x->'snapshot' FROM jsonb_array_elements($3::jsonb) x",
        [org, campaign.id, JSON.stringify(products)],
      );
    }
    await client.query(
      "INSERT INTO brochures(organization_id,id,campaign_id,layout,version) VALUES($1,$2,$2,$3,$4) ON CONFLICT(organization_id,id) DO UPDATE SET layout=EXCLUDED.layout,version=EXCLUDED.version,updated_at=now()",
      [org, campaign.id, campaign, campaign.version],
    );
    await client.query(
      "DELETE FROM brochure_pages WHERE organization_id=$1 AND brochure_id=$2",
      [org, campaign.id],
    );
    if (
      campaign.pages &&
      typeof campaign.pages === "object" &&
      !Array.isArray(campaign.pages)
    )
      await client.query(
        "INSERT INTO brochure_pages(organization_id,brochure_id,page_key,layout) SELECT $1,$2,key,value FROM jsonb_each($3::jsonb)",
        [org, campaign.id, campaign.pages],
      );
    for (const comment of campaign.reviewComments) {
      await client.query(
        "INSERT INTO review_threads(organization_id,id,campaign_id,page_index,position,fixed,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,id) DO UPDATE SET fixed=EXCLUDED.fixed,metadata=EXCLUDED.metadata",
        [
          org,
          comment.id,
          campaign.id,
          comment.pageIndex,
          comment.position ?? null,
          comment.fixed,
          comment,
        ],
      );
      for (const entry of [comment, ...comment.replies])
        await client.query(
          "INSERT INTO review_comments(organization_id,id,thread_id,text,author_email,mention,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,id) DO NOTHING",
          [
            org,
            entry.id,
            comment.id,
            entry.text,
            entry.authorEmail,
            entry.mention ?? null,
            entry.createdAt,
          ],
        );
    }
    for (const event of campaign.reviewHistory)
      await client.query(
        "INSERT INTO review_history(organization_id,id,campaign_id,event) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [org, event.id, campaign.id, event],
      );
  }
}
