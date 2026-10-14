import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Database } from "../../database/database";
import { STORAGE } from "../storage/storage.port";
import type { StoragePort } from "../storage/storage.port";
import type { JsonValue, JsonObject } from "../../shared/json";
import { ingestAsset, assetUrl } from "./asset-ingest";
import { embeddedImageInput } from "./image-input";
function sourceReference(
  value: string,
): { id?: string; alias?: string } | null {
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.pathname.startsWith("/api/assets/")) path = url.pathname;
      else if (
        url.protocol === "https:" &&
        url.hostname === "www.neptun-ks.com"
      )
        return { alias: value };
      else return null;
    } catch {
      return null;
    }
  }
  if (path === "/api/assets/app/logo")
    return { alias: "/assets/381662507fc2.png" };
  if (path.startsWith("/api/assets/app/fonts/"))
    return { alias: path.slice("/api/assets/app".length) };
  if (
    path.startsWith("/api/assets/") &&
    !path.startsWith("/api/assets/legacy/")
  ) {
    const parsed = z.uuid().safeParse(path.slice("/api/assets/".length));
    if (!parsed.success)
      throw new BadRequestException("Invalid asset reference.");
    return { id: parsed.data };
  }
  if (path.startsWith("/api/assets/legacy/"))
    path = path.slice("/api/assets/legacy".length);
  if (
    /^\/(?:assets|fonts|catalog-images|images)\//.test(path) ||
    /^\/api\/(?:ai-cutouts|brand-logos)\//.test(path)
  ) {
    try {
      return { alias: decodeURIComponent(path.split("?")[0] ?? path) };
    } catch {
      throw new BadRequestException("Invalid asset path.");
    }
  }
  return null;
}
@Injectable()
export class DocumentAssets {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}
  async externalize(
    organizationId: string,
    value: JsonObject,
    userId?: string,
  ): Promise<JsonObject> {
    const ids = new Set<string>();
    const aliases = new Set<string>();
    const saved = new Map<string, string>();
    const collect = (input: JsonValue): void => {
      if (Array.isArray(input)) {
        input.forEach(collect);
        return;
      }
      if (input && typeof input === "object") {
        Object.values(input).forEach(collect);
        return;
      }
      if (typeof input !== "string") return;
      const reference = sourceReference(input);
      if (reference?.id) ids.add(reference.id);
      if (reference?.alias) aliases.add(reference.alias);
    };
    collect(value);
    // All referenced assets are validated in one batched tenant query; no per-product reads.
    if (ids.size) {
      const found = await this.db.query<{ id: string }>(
        "SELECT id FROM assets WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
        [organizationId, [...ids]],
      );
      if (found.length !== ids.size)
        throw new BadRequestException(
          "Document refers to an unavailable asset.",
        );
    }
    const aliasRows = aliases.size
      ? await this.db.query<{
          source_path: string;
          asset_id: string;
          available: boolean;
        }>(
          "SELECT x.source_path,x.asset_id,a.deleted_at IS NULL available FROM asset_aliases x JOIN assets a ON a.organization_id=x.organization_id AND a.id=x.asset_id WHERE x.organization_id=$1 AND x.source_path=ANY($2::text[])",
          [organizationId, [...aliases]],
        )
      : [];
    if (aliasRows.some((row) => !row.available))
      throw new BadRequestException("Document refers to an unavailable asset.");
    const byAlias = new Map(
      aliasRows.map((row) => [row.source_path, row.asset_id]),
    );
    const visit = async (input: JsonValue): Promise<JsonValue> => {
      if (Array.isArray(input)) {
        const output: JsonValue[] = [];
        for (const item of input) output.push(await visit(item));
        return output;
      }
      if (input && typeof input === "object") {
        const output: JsonObject = {};
        for (const [key, item] of Object.entries(input))
          output[key] = await visit(item);
        return output;
      }
      if (typeof input !== "string") return input;
      const known = saved.get(input);
      if (known) return known;
      const data = embeddedImageInput(input);
      if (data) {
        const { bytes, mimeType } = data;
        if (bytes.length > 32 * 1024 * 1024)
          throw new BadRequestException("An embedded image is too large.");
        const asset = await ingestAsset(
          this.db,
          this.storage,
          organizationId,
          bytes,
          mimeType,
          { createdBy: userId },
        );
        const url = assetUrl(asset.id);
        saved.set(input, url);
        return url;
      }
      const reference = sourceReference(input);
      if (reference?.id) return assetUrl(reference.id);
      const id = reference?.alias ? byAlias.get(reference.alias) : undefined;
      if (id) {
        const url = assetUrl(id);
        saved.set(input, url);
        return url;
      }
      return input;
    };
    return (await visit(value)) as JsonObject;
  }
}
