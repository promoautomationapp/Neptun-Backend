import {
  Inject,
  Injectable,
  Module,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Req,
  Res,
  Body,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  Query,
  QueryHandler,
  QueryBus,
  Command,
  CommandHandler,
} from "@nestjs/cqrs";
import type { IQueryHandler, ICommandHandler } from "@nestjs/cqrs";
import type { Response } from "express";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AssetsRepository } from "./assets.repository";
import type { AssetRow } from "./assets.repository";
import { ingestAsset, assetUrl } from "./asset-ingest";
import { STORAGE } from "../storage/storage.port";
import type { StoragePort } from "../storage/storage.port";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { Database } from "../../database/database";
import { Public } from "../auth/auth.guard";
import { env } from "../../config/environment";
import { UPLOAD_IMAGE_TYPES } from "./image-input";
import {
  ExportImageController,
  ExportImageService,
  CacheExportImageHandler,
  exportImageDownloaderProvider,
} from "./export-image";

export class GetAssetQuery extends Query<AssetRow | null> {
  constructor(
    readonly organizationId: string,
    readonly id: string,
  ) {
    super();
  }
}
@QueryHandler(GetAssetQuery)
export class GetAssetHandler implements IQueryHandler<GetAssetQuery> {
  constructor(
    @Inject(AssetsRepository) private readonly repository: AssetsRepository,
  ) {}
  execute(query: GetAssetQuery) {
    return this.repository.find(query.organizationId, query.id);
  }
}
export class IngestAssetCommand extends Command<AssetRow> {
  constructor(
    readonly organizationId: string,
    readonly bytes: Buffer,
    readonly mimeType: string,
    readonly createdBy: string,
  ) {
    super();
  }
}
@CommandHandler(IngestAssetCommand)
export class IngestAssetHandler implements ICommandHandler<IngestAssetCommand> {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}
  execute(command: IngestAssetCommand) {
    return ingestAsset(
      this.db,
      this.storage,
      command.organizationId,
      command.bytes,
      command.mimeType,
      { createdBy: command.createdBy },
    );
  }
}
@Injectable()
export class UploadService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}
  private signature(id: string, organizationId: string): string {
    return createHmac("sha256", env.UPLOAD_SECRET)
      .update(`${organizationId}:${id}`)
      .digest("hex");
  }
  async create(request: AuthenticatedRequest, body: unknown) {
    const input = z
      .object({
        size: z
          .number()
          .int()
          .min(1)
          .max(12 * 1024 * 1024),
        mimeType: z.enum(UPLOAD_IMAGE_TYPES),
      })
      .parse(body);
    const organizationId = request.actor.organizationId;
    const rows = await this.db.query<{ id: string }>(
      "INSERT INTO upload_intents(organization_id,storage_key,max_size,mime_type,expires_at,created_by) VALUES($1,'pending',$2,$3,now()+interval '5 minutes',$4) RETURNING id",
      [organizationId, input.size, input.mimeType, request.actor.userId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("Upload intent creation failed.");
    const key = `org/${organizationId}/staging/${id}`;
    await this.db.query(
      "UPDATE upload_intents SET storage_key=$2 WHERE organization_id=$1 AND id=$3",
      [organizationId, key, id],
    );
    const url = await this.storage.signedUpload(key, input.mimeType);
    return {
      id,
      uploadUrl:
        url ??
        `/api/assets/uploads/${id}?token=${this.signature(id, organizationId)}`,
      method: "PUT",
      expiresIn: 300,
      headers: { "Content-Type": input.mimeType },
    };
  }
  async put(
    request: AuthenticatedRequest,
    id: string,
    token: string,
    bytes: unknown,
  ): Promise<void> {
    if (env.STORAGE_DRIVER !== "local")
      throw new BadRequestException("Use the provided R2 URL.");
    const expected = Buffer.from(
      this.signature(id, request.actor.organizationId),
    );
    const provided = Buffer.from(token);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      throw new BadRequestException("Invalid upload token.");
    await this.db.transaction(async (client) => {
      const row = (
        await client.query<{
          storage_key: string;
          max_size: string;
          mime_type: string;
        }>(
          "SELECT storage_key,max_size,mime_type FROM upload_intents WHERE organization_id=$1 AND id=$2 AND expires_at>clock_timestamp() AND asset_id IS NULL FOR UPDATE",
          [request.actor.organizationId, id],
        )
      ).rows[0];
      if (
        !row ||
        !Buffer.isBuffer(bytes) ||
        !bytes.length ||
        bytes.length > Number(row.max_size)
      )
        throw new BadRequestException("Invalid or oversized upload.");
      await this.storage.put(row.storage_key, bytes, row.mime_type);
    });
  }
  async confirm(request: AuthenticatedRequest, id: string) {
    const result = await this.db.transaction(async (client) => {
      // A row lock serializes PUT and confirmation across API instances. All writes use
      // this same connection so concurrent confirmations cannot exhaust the pool.
      const row = (
        await client.query<{
          storage_key: string;
          max_size: string;
          mime_type: string;
          asset_id: string | null;
          valid: boolean;
        }>(
          "SELECT storage_key,max_size,mime_type,asset_id,expires_at>clock_timestamp() valid FROM upload_intents WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [request.actor.organizationId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Upload not found.");
      if (row.asset_id) {
        const asset = (
          await client.query<{ sha256: string }>(
            "SELECT sha256 FROM assets WHERE organization_id=$1 AND id=$2",
            [request.actor.organizationId, row.asset_id],
          )
        ).rows[0];
        return {
          assetId: row.asset_id,
          url: assetUrl(row.asset_id),
          sha256: asset?.sha256,
          stagingKey: row.storage_key,
        };
      }
      if (!row.valid) throw new BadRequestException("Upload expired.");
      if (!(await this.storage.exists(row.storage_key)))
        throw new BadRequestException("Upload the image before confirming.");
      const bytes = await this.storage.read(row.storage_key);
      if (!bytes.length || bytes.length > Number(row.max_size))
        throw new BadRequestException("Invalid or oversized upload.");
      const asset = await ingestAsset(
        this.db,
        this.storage,
        request.actor.organizationId,
        bytes,
        row.mime_type,
        { createdBy: request.actor.userId, client },
      );
      await client.query(
        "UPDATE upload_intents SET asset_id=$3 WHERE organization_id=$1 AND id=$2",
        [request.actor.organizationId, id, asset.id],
      );
      return {
        assetId: asset.id,
        url: assetUrl(asset.id),
        sha256: asset.sha256,
        stagingKey: row.storage_key,
      };
    });
    await this.storage.remove(result.stagingKey);
    return { assetId: result.assetId, url: result.url, sha256: result.sha256 };
  }
}
@Controller("api/assets")
export class AssetsController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(UploadService) private readonly uploads: UploadService,
    @Inject(AssetsRepository) private readonly repository: AssetsRepository,
  ) {}
  @Post("uploads") create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.uploads.create(request, body);
  }
  @Put("uploads/:id") async put(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.uploads.put(
      request,
      z.uuid().parse(id),
      String(request.query.token ?? ""),
      body,
    );
    return { uploaded: true };
  }
  @Post("uploads/:id/confirm") confirm(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.uploads.confirm(request, z.uuid().parse(id));
  }
  @Public()
  @Get("app/fonts/*path")
  async font(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    const sourcePath = decodeURIComponent(
      request.path.replace("/api/assets/app", ""),
    );
    if (
      !/^\/fonts\/brochure\/(?:SkolaSans-(?:Light|Regular|Medium|Bold|Black)\.otf|TSTAR-(?:Regular|Bold|Headline)\.ttf)$/.test(
        sourcePath,
      )
    )
      throw new NotFoundException("Font not found.");
    const rows = await this.repository.appAsset(sourcePath);
    if (!rows) throw new NotFoundException("Font not found.");
    await this.send(rows, response, false);
  }
  @Public()
  @Get("app/logo")
  async logo(@Res() response: Response) {
    const asset = await this.repository.appAsset("/assets/381662507fc2.png");
    if (!asset) throw new NotFoundException("Logo not found.");
    await this.send(asset, response, false);
  }
  @Get("legacy/*path") async legacy(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const sourcePath = decodeURIComponent(
      request.path.replace("/api/assets/legacy", ""),
    );
    const asset = await this.repository.byAlias(
      request.actor.organizationId,
      sourcePath,
    );
    if (!asset) throw new NotFoundException("Asset not found.");
    return this.send(asset, response);
  }
  @Get(":id") async get(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Res() response: Response,
  ) {
    const asset = await this.queries.execute(
      new GetAssetQuery(request.actor.organizationId, z.uuid().parse(id)),
    );
    if (!asset) throw new NotFoundException("Asset not found.");
    return this.send(asset, response);
  }
  private async send(
    asset: AssetRow,
    response: Response,
    privateAsset = true,
  ): Promise<void> {
    if (privateAsset) response.vary("Cookie");
    // Keep authenticated images on the API origin. Browser image inspection
    // uses credentials, which cannot follow an R2 redirect without credential
    // CORS support. The storage adapter still reads the unchanged R2 bytes.
    response
      .set("Cache-Control", "private, max-age=31536000, immutable")
      .type(asset.mime_type)
      .send(await this.storage.read(asset.storage_key));
  }
}
@Module({
  controllers: [AssetsController, ExportImageController],
  providers: [
    AssetsRepository,
    UploadService,
    GetAssetHandler,
    IngestAssetHandler,
    ExportImageService,
    CacheExportImageHandler,
    exportImageDownloaderProvider,
  ],
  exports: [AssetsRepository],
})
export class AssetsModule {}
