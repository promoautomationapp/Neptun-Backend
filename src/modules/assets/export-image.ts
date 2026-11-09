import {
  BadRequestException,
  BadGatewayException,
  HttpException,
  NotFoundException,
  Injectable,
  Inject,
  Controller,
  Get,
  Req,
  Query as HttpQuery,
  Res,
} from "@nestjs/common";
import { Command, CommandHandler, CommandBus } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import type { Response } from "express";
import { z } from "zod";
import { Database } from "../../database/database";
import { downloadPublic, publicHttpsUrl } from "../../shared/public-download";
import type { PublicDownload } from "../../shared/public-download";
import { ingestAsset } from "./asset-ingest";
import type { AssetRow } from "./assets.repository";
import { STORAGE } from "../storage/storage.port";
import type { StoragePort } from "../storage/storage.port";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { sendStoredAsset } from "./asset-response";
import {
  createImageWorkBudget,
  imageWorkBusy,
} from "../../security/image-work";

export const EXPORT_IMAGE_DOWNLOADER = Symbol("EXPORT_IMAGE_DOWNLOADER");
export type ExportImageDownloader = (source: string) => Promise<PublicDownload>;
const mimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
];
const maxBytes = 12_000_000;
const aliasQuery =
  "SELECT a.* FROM assets a JOIN asset_aliases aa ON aa.organization_id=a.organization_id AND aa.asset_id=a.id WHERE aa.organization_id=$1 AND aa.source_path=$2";
type AliasAsset = AssetRow & { deleted_at: Date | null };
// Misses own downloaded buffers before sendStoredAsset can reserve the later
// response. Admit them separately, before any transaction or image download.
const exportMissWork = createImageWorkBudget({
  maxConcurrent: 2,
  maxBytes: maxBytes * 2,
  maxQueued: 8,
  maxWaitMs: 10_000,
});
export function legacyNeptunImageUrl(source: string): URL {
  try {
    const url = publicHttpsUrl(source);
    if (!["www.neptun-ks.com", "neptun-ks.com"].includes(url.hostname))
      throw new Error("Unsupported image host.");
    return url;
  } catch {
    throw new BadRequestException(
      "Use an original public Neptun HTTPS image URL.",
    );
  }
}
export const exportImageDownloaderProvider = {
  provide: EXPORT_IMAGE_DOWNLOADER,
  useValue: ((source: string) =>
    downloadPublic(source, maxBytes, undefined, (url) => {
      legacyNeptunImageUrl(url.href);
    })) satisfies ExportImageDownloader,
};

/** A GET can populate its immutable owned cache but never dispatches AI. */
export class CacheExportImageCommand extends Command<AssetRow> {
  constructor(
    readonly organizationId: string,
    readonly userId: string,
    readonly source: string,
  ) {
    super();
  }
}
@Injectable()
export class ExportImageService {
  private readonly pending = new Map<string, Promise<AssetRow>>();
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(EXPORT_IMAGE_DOWNLOADER)
    private readonly download: ExportImageDownloader,
  ) {}
  async cached(
    organizationId: string,
    userId: string,
    source: string,
  ): Promise<AssetRow> {
    const url = legacyNeptunImageUrl(source).href;
    const previous = (
      await this.db.query<AliasAsset>(aliasQuery, [organizationId, url])
    )[0];
    const cached = await this.availableAsset(previous);
    if (cached) return cached;
    const key = `${organizationId}:${url}`;
    const running = this.pending.get(key);
    if (running) return running;
    if (this.pending.size >= 64) throw imageWorkBusy();
    const pending = exportMissWork.run(maxBytes, () =>
      this.populate(organizationId, userId, url),
    );
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
  private async availableAsset(
    existing?: AliasAsset,
  ): Promise<AssetRow | null> {
    if (existing?.deleted_at)
      throw new NotFoundException("This image was removed.");
    return existing &&
      mimeTypes.includes(existing.mime_type) &&
      Number(existing.size) <= maxBytes &&
      (await this.storage.exists(existing.storage_key))
      ? existing
      : null;
  }
  private async populate(
    organizationId: string,
    userId: string,
    url: string,
  ): Promise<AssetRow> {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${organizationId}:export-image:${url}`],
      );
      const existing = (
        await client.query<AliasAsset>(aliasQuery, [organizationId, url])
      ).rows[0];
      const cached = await this.availableAsset(existing);
      if (cached) return cached;
      try {
        const input = await this.download(url);
        legacyNeptunImageUrl(input.url);
        if (
          !mimeTypes.includes(input.mimeType) ||
          !input.bytes.length ||
          input.bytes.length > maxBytes
        )
          throw new Error("Unsupported or oversized image.");
        const asset = await ingestAsset(
          this.db,
          this.storage,
          organizationId,
          input.bytes,
          input.mimeType,
          {
            kind: "original",
            createdBy: userId,
            client,
            metadata: { importedFrom: url, resolvedSource: input.url },
          },
        );
        const available = (
          await client.query<{ deleted_at: Date | null }>(
            "SELECT deleted_at FROM assets WHERE organization_id=$1 AND id=$2",
            [organizationId, asset.id],
          )
        ).rows[0];
        if (available?.deleted_at)
          throw new Error("This photograph has been removed.");
        await client.query(
          "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,source_path) DO UPDATE SET asset_id=EXCLUDED.asset_id",
          [organizationId, url, asset.id],
        );
        return asset;
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === 429)
          throw error;
        throw new BadGatewayException(
          "The original product image could not be loaded. Upload your own image or retry.",
        );
      }
    });
  }
}
@CommandHandler(CacheExportImageCommand)
export class CacheExportImageHandler implements ICommandHandler<CacheExportImageCommand> {
  constructor(
    @Inject(ExportImageService) private readonly service: ExportImageService,
  ) {}
  execute(command: CacheExportImageCommand) {
    return this.service.cached(
      command.organizationId,
      command.userId,
      command.source,
    );
  }
}
@Controller("api")
export class ExportImageController {
  constructor(
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}
  @Get("export-image")
  async image(
    @Req() request: AuthenticatedRequest,
    @HttpQuery() query: unknown,
    @Res() response: Response,
  ) {
    const { url } = z.object({ url: z.string().min(1).max(2048) }).parse(query);
    const asset = await this.commands.execute(
      new CacheExportImageCommand(
        request.actor.organizationId,
        request.actor.userId,
        url,
      ),
    );
    await sendStoredAsset(this.storage, asset, response, (reply) => {
      reply.vary("Cookie").vary("Origin");
      reply.set({
        "Cache-Control": "private, no-store",
        "Content-Type": asset.mime_type,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
    });
  }
}
