import { createHash } from "node:crypto";
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
  const query = async <T extends QueryResultRow>(
    sql: string,
    values: unknown[],
  ): Promise<T[]> =>
    options.client
      ? (await options.client.query<T>(sql, values)).rows
      : db.query<T>(sql, values);
  const input = await canonicalAssetInput(bytes, mimeType);
  bytes = input.bytes;
  mimeType = input.mimeType;
  const { width, height } = input;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `org/${organizationId}/assets/${sha256}.${extensions[mimeType] ?? "bin"}`;
  if (!(await storage.exists(key))) await storage.put(key, bytes, mimeType);
  const stored = await query<AssetRow>(
    "INSERT INTO assets(organization_id,storage_key,sha256,size,mime_type,width,height,kind,metadata,created_by,source_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(organization_id,storage_key) DO UPDATE SET storage_key=EXCLUDED.storage_key RETURNING *",
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
        `variants:${organizationId}:${asset.id}:1`,
        { organizationId, assetId: asset.id },
      ],
    );
  }
  return asset;
}
export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}
