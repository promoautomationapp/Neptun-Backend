import {
  Module,
  Controller,
  Get,
  Post,
  Delete,
  Req,
  Body,
  Param,
  Query as QueryParam,
  Inject,
} from "@nestjs/common";
import { z } from "zod";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { campaignSchema, postSchema } from "./domain/document";
import { identifier } from "../../shared/json";
import { reviewInput } from "./domain/review";
import { DocumentAssets } from "../assets/document-assets";
import { DocumentsRepository } from "./documents.repository";
import {CampaignPresenceController, CampaignPresenceRepository, CampaignPresenceCommandHandler, CampaignPresenceQueryHandler} from "./campaign-presence";
import {
  ListDocumentsQuery,
  GetDocumentQuery,
  SaveDocumentCommand,
  RemoveDocumentCommand,
  ReviewCampaignCommand,
  documentHandlers,
} from "./application/handlers";
@Controller("api/team")
export class DocumentsController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(CommandBus) private readonly commands: CommandBus,
  ) {}
  @Get("campaigns") async campaigns(@Req() req: AuthenticatedRequest) {
    return {
      campaigns: await this.queries.execute(
        new ListDocumentsQuery(req.actor.organizationId, "campaign"),
      ),
    };
  }
  @Get("campaigns/:id") async campaign(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return {
      campaign: await this.queries.execute(
        new GetDocumentQuery(
          req.actor.organizationId,
          "campaign",
          identifier.parse(id),
        ),
      ),
    };
  }
  @Post("campaigns") async saveCampaign(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const { campaign } = z.object({ campaign: campaignSchema }).parse(body);
    return {
      campaign: await this.commands.execute(
        new SaveDocumentCommand(req.actor, "campaign", campaign),
      ),
    };
  }
  @Delete("campaigns/:id") removeCampaign(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @QueryParam("version") version?: string,
  ) {
    return this.commands.execute(
      new RemoveDocumentCommand(
        req.actor.organizationId,
        "campaign",
        identifier.parse(id),
        version ? z.coerce.number().int().positive().parse(version) : undefined,
      ),
    );
  }
  @Post("campaigns/:id/review") async review(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return {
      campaign: await this.commands.execute(
        new ReviewCampaignCommand(
          req.actor,
          identifier.parse(id),
          reviewInput.parse(body),
        ),
      ),
    };
  }
  @Get("posts") async posts(@Req() req: AuthenticatedRequest) {
    return {
      posts: await this.queries.execute(
        new ListDocumentsQuery(req.actor.organizationId, "post"),
      ),
    };
  }
  @Get("posts/:id") async post(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return {
      post: await this.queries.execute(
        new GetDocumentQuery(
          req.actor.organizationId,
          "post",
          identifier.parse(id),
        ),
      ),
    };
  }
  @Post("posts") async savePost(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const { post } = z.object({ post: postSchema }).parse(body);
    return {
      post: await this.commands.execute(
        new SaveDocumentCommand(req.actor, "post", post),
      ),
    };
  }
  @Delete("posts/:id") removePost(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @QueryParam("version") version?: string,
  ) {
    return this.commands.execute(
      new RemoveDocumentCommand(
        req.actor.organizationId,
        "post",
        identifier.parse(id),
        version ? z.coerce.number().int().positive().parse(version) : undefined,
      ),
    );
  }
}
@Module({
  controllers: [DocumentsController, CampaignPresenceController],
  providers: [DocumentsRepository, DocumentAssets, CampaignPresenceRepository, CampaignPresenceCommandHandler, CampaignPresenceQueryHandler, ...documentHandlers],
  exports: [DocumentsRepository],
})
export class DocumentsModule {}
