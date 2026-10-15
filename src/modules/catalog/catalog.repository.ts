import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Database } from "../../database/database";
import { normalizeHierarchy, type SourceProduct } from "./neptun-source";
import type { JsonObject } from "../../shared/json";

export interface CatalogStatus {
  status: "idle" | "queued" | "running" | "completed" | "failed";
  runId: string | null;
  lastSuccessfulAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  processed: number;
  total: number;
  added: number;
  updated: number;
  missing: number;
  unchanged: number;
  failedProducts: number;
  phase: string;
  error: string | null;
  daily: boolean;
  imagesPending: number;
  revision: string | null;
}
interface RunRow {
  id: string;
  status: CatalogStatus["status"];
  processed: number;
  total: number;
  added: number;
  updated: number;
  missing: number;
  unchanged: number;
  failed_products: number;
  phase: string;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}
@Injectable()
export class CatalogRepository {
  constructor(@Inject(Database) readonly db: Database) {}
  async status(organizationId: string): Promise<CatalogStatus> {
    const rows = await this.db.query<RunRow>(
      "SELECT * FROM catalog_sync_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1",
      [organizationId],
    );
    const last = await this.db.query<{ last: Date | null }>(
      "SELECT COALESCE((SELECT max(completed_at) FROM catalog_sync_runs WHERE organization_id=$1 AND status='completed'),(SELECT max(imported_at) FROM import_sources WHERE organization_id=$1 AND source_key LIKE 'catalog%')) last",
      [organizationId],
    );
    const row = rows[0];
    const media = await this.db.query<{
      pending: string;
      revision: Date | null;
    }>(
      `SELECT count(*) FILTER (WHERE source->>'runId'=$2 AND coalesce(source->'imageUrls'->>0,'')<>'' AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.organization_id=products.organization_id AND pi.product_id=products.id AND pi.asset_id=products.primary_asset_id AND pi.source_url=source->'imageUrls'->>0)) pending,max(updated_at) revision FROM products WHERE organization_id=$1 AND deleted_at IS NULL`,
      [organizationId, row?.id ?? ""],
    );
    return {
      status: row?.status ?? "idle",
      runId: row?.id ?? null,
      lastSuccessfulAt: last[0]?.last?.toISOString() ?? null,
      startedAt: row?.started_at?.toISOString() ?? null,
      completedAt: row?.completed_at?.toISOString() ?? null,
      processed: row?.processed ?? 0,
      total: row?.total ?? 0,
      added: row?.added ?? 0,
      updated: row?.updated ?? 0,
      missing: row?.missing ?? 0,
      unchanged: row?.unchanged ?? 0,
      failedProducts: row?.failed_products ?? 0,
      phase: row?.phase ?? "idle",
      error: row?.error ?? null,
      daily: true,
      imagesPending: Number(media[0]?.pending ?? 0),
      revision: media[0]?.revision?.toISOString() ?? null,
    };
  }
  async enqueue(
    organizationId: string,
    trigger: "manual" | "daily",
    userId?: string,
  ) {
    await this.db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `catalog:${organizationId}`,
      ]);
      // A worker crash must not permanently disable the button. Heartbeats run throughout a crawl.
      await client.query(
        "UPDATE catalog_sync_runs SET status='failed',error='The previous refresh was interrupted. Start a new refresh.',completed_at=now() WHERE organization_id=$1 AND status IN ('queued','running') AND heartbeat_at<now()-interval '2 hours'",
        [organizationId],
      );
      if (
        (
          await client.query(
            "SELECT id FROM catalog_sync_runs WHERE organization_id=$1 AND status IN ('queued','running')",
            [organizationId],
          )
        ).rows.length
      )
        return;
      // Scheduled delivery/restarts must not create a second daily crawl.
      // Manual refreshes remain available even after today's scheduled run.
      if (
        trigger === "daily" &&
        (
          await client.query(
            "SELECT id FROM catalog_sync_runs WHERE organization_id=$1 AND trigger='daily' AND (created_at AT TIME ZONE 'Europe/Belgrade')::date=(now() AT TIME ZONE 'Europe/Belgrade')::date LIMIT 1",
            [organizationId],
          )
        ).rows.length
      )
        return;
      const run = (
        await client.query<{ id: string }>(
          "INSERT INTO catalog_sync_runs(organization_id,trigger,created_by) VALUES($1,$2,$3) RETURNING id",
          [organizationId, trigger, userId ?? null],
        )
      ).rows[0]!;
      await client.query(
        "INSERT INTO job_outbox(organization_id,queue,job_key,payload) VALUES($1,'catalog-refresh',$2,$3)",
        [
          organizationId,
          `catalog:${run.id}`,
          { organizationId, runId: run.id },
        ],
      );
    });
    return this.status(organizationId);
  }
  async repairHierarchy(organizationId: string) {
    const rows = await this.db.query<{
      id: string;
      category_path: string;
      category: string;
      subcategory: string;
    }>(
      "SELECT id,category_path,category,subcategory FROM products WHERE organization_id=$1 AND deleted_at IS NULL",
      [organizationId],
    );
    let changed = 0;
    for (const row of rows) {
      const path = normalizeHierarchy(
        row.category_path,
        row.category,
        row.subcategory,
      );
      if (!path.length) continue;
      if (
        row.category !== path[0] ||
        row.subcategory !== path.at(-1) ||
        row.category_path !== path.join(" > ")
      ) {
        await this.db.query(
          "UPDATE products SET category=$3,subcategory=$4,category_path=$5,updated_at=now(),version=version+1 WHERE organization_id=$1 AND id=$2",
          [organizationId, row.id, path[0], path.at(-1), path.join(" > ")],
        );
        changed++;
      }
    }
    return changed;
  }
  async existing(organizationId: string) {
    return this.db.query<{
      id: string;
      code: string;
      source: JsonObject;
      primary_asset_id: string | null;
      source_missing: boolean;
    }>(
      "SELECT id,code,source,primary_asset_id,source_missing FROM products WHERE organization_id=$1 AND deleted_at IS NULL",
      [organizationId],
    );
  }
  async upsert(organizationId: string, product: SourceProduct, runId: string) {
    return this.db.transaction(async (client) => {
      const old = (
        await client.query<{ source: JsonObject }>(
          "SELECT source FROM products WHERE organization_id=$1 AND code=$2",
          [organizationId, product.code],
        )
      ).rows[0]?.source;
      const source = {
        ...product,
        site: "neptun-ks.com",
        runId,
        all_image_urls:
          typeof old?.all_image_urls === "string" ? old.all_image_urls : "",
      };
      const result = (
        await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO products(organization_id,code,name,brand,model,ean,category,subcategory,category_path,description,warranty,regular,currency,specs,availability,product_url,source,source_last_seen_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
        ON CONFLICT(organization_id,code) DO UPDATE SET name=EXCLUDED.name,brand=EXCLUDED.brand,model=EXCLUDED.model,ean=EXCLUDED.ean,category=EXCLUDED.category,subcategory=EXCLUDED.subcategory,category_path=EXCLUDED.category_path,description=EXCLUDED.description,warranty=EXCLUDED.warranty,regular=EXCLUDED.regular,currency=EXCLUDED.currency,specs=EXCLUDED.specs,availability=EXCLUDED.availability,product_url=EXCLUDED.product_url,source=EXCLUDED.source,source_missing=false,source_missing_since=NULL,source_last_seen_at=now(),updated_at=now(),version=products.version+1
        RETURNING id,(xmax=0) inserted`,
          [
            organizationId,
            product.code,
            product.name,
            product.brand,
            product.model,
            product.ean,
            product.category,
            product.subcategory,
            product.categoryPath,
            product.description,
            product.warranty,
            product.regular,
            product.currency,
            product.specs,
            product.availability,
            product.url,
            source,
          ],
        )
      ).rows[0]!;
      if (product.imageUrls.length)
        await client.query(
          "INSERT INTO job_outbox(organization_id,queue,job_key,payload) VALUES($1,'catalog-images',$2,$3) ON CONFLICT(job_key) DO NOTHING",
          [
            organizationId,
            `catalog-images:${organizationId}:${product.code}:${createHash("sha256").update(product.imageUrls.join("|")).digest("hex")}`,
            {
              organizationId,
              productId: result.id,
              imageUrls: product.imageUrls,
            },
          ],
        );
      return result.inserted;
    });
  }
}
