import {
  BadRequestException,
  BadGatewayException,
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
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${organizationId}:export-image:${url}`],
      );
      const existing = (
        await client.query<AssetRow & { deleted_at: Date | null }>(
          "SELECT a.* FROM assets a JOIN asset_aliases aa ON aa.organization_id=a.organization_id AND aa.asset_id=a.id WHERE aa.organization_id=$1 AND aa.source_path=$2",
          [organizationId, url],
        )
      ).rows[0];
      if (existing?.deleted_at)
        throw new NotFoundException("This image was removed.");
      if (
        existing &&
        mimeTypes.includes(existing.mime_type) &&
        Number(existing.size) <= maxBytes &&
        (await this.storage.exists(existing.storage_key))
      )
        return existing;
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
      } catch {
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
    response.vary("Cookie").vary("Origin");
    response
      .set({
        "Cache-Control": "private, no-store",
        "Content-Type": asset.mime_type,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
      })
      .send(await this.storage.read(asset.storage_key));
  }
}
