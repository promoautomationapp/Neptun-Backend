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
import { requireWorkspaceAccess } from "../auth/domain/workspace-access";
import { NotificationsModule } from "../notifications/notifications.module";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { campaignSchema, postSchema } from "./domain/document";
import { identifier } from "../../shared/json";
import { reviewInput } from "./domain/review";
import { DocumentAssets } from "../assets/document-assets";
import { DocumentVisibility } from "./document-visibility";
import { DocumentsRepository } from "./documents.repository";
import {
  CampaignPresenceController,
  CampaignPresenceRepository,
  CampaignPresenceCommandHandler,
  CampaignPresenceQueryHandler,
} from "./campaign-presence";
import {
  ListDocumentsQuery,
  GetDocumentQuery,
  SaveDocumentCommand,
  RemoveDocumentCommand,
  RestoreDocumentCommand,
  ReviewCampaignCommand,
  documentHandlers,
} from "./application/handlers";
@Controller("api/team")
export class DocumentsController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(DocumentVisibility) private readonly visibility: DocumentVisibility,
  ) {}
  @Get("campaigns") async campaigns(
    @Req() req: AuthenticatedRequest,
    @QueryParam("includeDisabled") includeDisabled?: string,
  ) {
    return {
      campaigns: await this.visibility.forActor(
        req.actor,
        await this.queries.execute(
          new ListDocumentsQuery(
            req.actor.organizationId,
            "campaign",
            req.actor.accountRole === "superadmin" &&
              includeDisabled === "true",
          ),
        ),
      ),
    };
  }
  @Get("campaigns/:id") async campaign(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return {
      campaign: await this.visibility.forActor(
        req.actor,
        await this.queries.execute(
          new GetDocumentQuery(
            req.actor.organizationId,
            "campaign",
            identifier.parse(id),
            req.actor.accountRole === "superadmin",
          ),
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
      campaign: await this.visibility.forActor(
        req.actor,
        await this.commands.execute(
          new SaveDocumentCommand(req.actor, "campaign", campaign),
        ),
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
        req.actor,
        "campaign",
        identifier.parse(id),
        version ? z.coerce.number().int().positive().parse(version) : undefined,
      ),
    );
  }
  @Post("campaigns/:id/restore") async restoreCampaign(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { version } = z
      .object({ version: z.number().int().positive().optional() })
      .strict()
      .parse(body ?? {});
    return {
      campaign: await this.commands.execute(
        new RestoreDocumentCommand(
          req.actor,
          "campaign",
          identifier.parse(id),
          version,
        ),
      ),
    };
  }
  @Post("campaigns/:id/review") async review(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return {
      campaign: await this.visibility.forActor(
        req.actor,
        await this.commands.execute(
          new ReviewCampaignCommand(
            req.actor,
            identifier.parse(id),
            reviewInput.parse(body),
          ),
        ),
      ),
    };
  }
  @Get("posts") async posts(
    @Req() req: AuthenticatedRequest,
    @QueryParam("includeDisabled") includeDisabled?: string,
  ) {
    requireWorkspaceAccess(req.actor, "canViewSocialPosts");
    return {
      posts: await this.visibility.forActor(
        req.actor,
        await this.queries.execute(
          new ListDocumentsQuery(
            req.actor.organizationId,
            "post",
            req.actor.accountRole === "superadmin" &&
              includeDisabled === "true",
          ),
        ),
      ),
    };
  }
  @Get("posts/:id") async post(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    requireWorkspaceAccess(req.actor, "canViewSocialPosts");
    return {
      post: await this.visibility.forActor(
        req.actor,
        await this.queries.execute(
          new GetDocumentQuery(
            req.actor.organizationId,
            "post",
            identifier.parse(id),
            req.actor.accountRole === "superadmin",
          ),
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
      post: await this.visibility.forActor(
        req.actor,
        await this.commands.execute(
          new SaveDocumentCommand(req.actor, "post", post),
        ),
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
        req.actor,
        "post",
        identifier.parse(id),
        version ? z.coerce.number().int().positive().parse(version) : undefined,
      ),
    );
  }
  @Post("posts/:id/restore") async restorePost(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { version } = z
      .object({ version: z.number().int().positive().optional() })
      .strict()
      .parse(body ?? {});
    return {
      post: await this.commands.execute(
        new RestoreDocumentCommand(
          req.actor,
          "post",
          identifier.parse(id),
          version,
        ),
      ),
    };
  }
}
@Module({
  imports: [NotificationsModule],
  controllers: [DocumentsController, CampaignPresenceController],
  providers: [
    DocumentVisibility,
    DocumentsRepository,
    DocumentAssets,
    CampaignPresenceRepository,
    CampaignPresenceCommandHandler,
    CampaignPresenceQueryHandler,
    ...documentHandlers,
  ],
  exports: [DocumentsRepository],
})
export class DocumentsModule {}
