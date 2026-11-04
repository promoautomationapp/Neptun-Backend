import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { Database } from "../../database/database";
import type { StoragePort } from "../storage/storage.port";
import type { JsonObject } from "../../shared/json";
import type { AssetRow } from "./assets.repository";
import { canonicalAssetInput } from "./image-input";

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
  "font/otf": "otf",
  "font/ttf": "ttf",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
};
export async function ingestAsset(
  db: Database,
  storage: StoragePort,
  organizationId: string,
  bytes: Buffer,
  mimeType: string,
  options: {
    kind?: string;
    metadata?: JsonObject;
    createdBy?: string;
    sourceAssetId?: string;
    enqueueVariants?: boolean;
    client?: PoolClient;
  } = {},
): Promise<AssetRow> {
  const input = await canonicalAssetInput(bytes, mimeType);
  bytes = input.bytes;
  mimeType = input.mimeType;
  const { width, height } = input;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `org/${organizationId}/assets/${sha256}.${extensions[mimeType] ?? "bin"}`;
  const persist = async (client: PoolClient): Promise<AssetRow> => {
    const query = async <T extends QueryResultRow>(
      sql: string,
      values: unknown[],
    ): Promise<T[]> => (await client.query<T>(sql, values)).rows;
    // Cleanup uses this same key lock through its R2 deletion. Checking storage
    // before this lock could resurrect a DB row whose bytes were just removed.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${organizationId}:asset:${key}`,
    ]);
    const previous = await query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM assets WHERE organization_id=$1 AND storage_key=$2 FOR UPDATE",
      [organizationId, key],
    );
    const revived = Boolean(previous[0]?.deleted_at);
    if (!(await storage.exists(key))) await storage.put(key, bytes, mimeType);
    const stored = await query<AssetRow>(
      "INSERT INTO assets(organization_id,storage_key,sha256,size,mime_type,width,height,kind,metadata,created_by,source_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(organization_id,storage_key) DO UPDATE SET deleted_at=NULL,metadata=(CASE WHEN EXCLUDED.metadata->>'cutoutValidated'='true' THEN assets.metadata-'cutoutRejected'-'cutoutRemoved'-'cutoutInvalidated'-'cutoutInvalidatedAt'-'cutoutInvalidationReason' ELSE assets.metadata END) || EXCLUDED.metadata RETURNING *",
      [
        organizationId,
        key,
        sha256,
        bytes.length,
        mimeType,
        width,
        height,
        options.kind ?? "original",
        options.metadata ?? {},
        options.createdBy ?? null,
        options.sourceAssetId ?? null,
      ],
    );
    const asset = stored[0];
    if (!asset) throw new Error("Could not register asset.");
    if (
      options.enqueueVariants !== false &&
      mimeType.startsWith("image/") &&
      !options.sourceAssetId
    ) {
      await query(
        "INSERT INTO job_outbox(organization_id,queue,job_key,payload) VALUES($1,'asset-variants',$2,$3) ON CONFLICT(job_key) DO NOTHING",
        [
          organizationId,
          `variants:${organizationId}:${asset.id}:1${revived ? `:${randomUUID()}` : ""}`,
          { organizationId, assetId: asset.id },
        ],
      );
    }
    return asset;
  };
  return options.client ? persist(options.client) : db.transaction(persist);
}
export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}
