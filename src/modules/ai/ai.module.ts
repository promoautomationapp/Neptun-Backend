import {
  Controller,
  Module,
  Get,
  Post,
  Req,
  Param,
  Query as QueryParam,
  Body,
  Inject,
  Res,
  ForbiddenException,
} from "@nestjs/common";
import type { Response } from "express";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { z } from "zod";
import { env } from "../../config/environment";
import { jsonObject } from "../../shared/json";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { DocumentAssets } from "../assets/document-assets";
import { AiRepository } from "./ai.repository";
import { LifestyleRepository } from "./lifestyle.repository";
import { aiRequestSchema, belgradeMonth } from "./domain/request";
import type { AiOperation } from "./domain/request";
import {
  EnqueueAiCommand,
  GetAiJobQuery,
  GetAiUsageQuery,
  GetBrandLogosQuery,
  GetLifestyleQuotaQuery,
  AcceptLifestyleCommand,
  aiHandlers,
} from "./application/handlers";
@Controller("api")
export class AiController {
  constructor(
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(QueryBus) private readonly queries: QueryBus,
  ) {}
  @Get("ai-status") status() {
    return { configured: Boolean(env.OPENAI_API_KEY) };
  }
  @Post("ai/jobs") async enqueue(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ticket = await this.commands.execute(
      new EnqueueAiCommand(req.actor, aiRequestSchema.parse(body)),
    );
    res.status(ticket.status === "succeeded" ? 200 : 202);
    return ticket.status === "succeeded"
      ? { ...ticket.result, ...ticket, cached: true }
      : { ...ticket, pollUrl: `/api/ai/jobs/${ticket.jobId}` };
  }
  @Get("ai/jobs/:id") job(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.queries.execute(
      new GetAiJobQuery(
        req.actor.organizationId,
        z.uuid().parse(id),
        req.actor,
      ),
    );
  }
  @Get("ai/usage") usage(
    @Req() req: AuthenticatedRequest,
    @QueryParam("month") month?: string,
  ) {
    if (req.actor.accountRole !== "superadmin")
      throw new ForbiddenException("Only superadmins can view AI usage.");
    return this.queries.execute(
      new GetAiUsageQuery(
        req.actor.organizationId,
        z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .parse(month ?? belgradeMonth()),
      ),
    );
  }
  @Get("brand-logos") logos(@Req() req: AuthenticatedRequest) {
    return this.queries.execute(
      new GetBrandLogosQuery(req.actor.organizationId),
    );
  }
  @Get("ai/lifestyle/quota") quota(@Req() req: AuthenticatedRequest) {
    return this.queries.execute(
      new GetLifestyleQuotaQuery(req.actor.organizationId),
    );
  }
  @Post("ai/lifestyle/:id/accept") accept(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.commands.execute(
      new AcceptLifestyleCommand(
        req.actor.organizationId,
        z.uuid().parse(id),
        req.actor,
      ),
    );
  }
  @Post("ai-remove-background") cutout(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "cutout");
  }
  @Post("ai-white-brand-logo") brand(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "brand_prep");
  }
  @Post("ai-proofread") proofread(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "proofread");
  }
  @Post("ai-generate-background") background(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "background");
  }
  @Post("ai-lifestyle") lifestyle(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "lifestyle");
  }
  @Post("ai-suggest-placement") placement(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "placement");
  }
  @Post("ai-detect-screen") screen(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "detect_screen");
  }
  @Post("ai-find-product-image") productImage(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.legacy(req, body, res, "product_image_search");
  }
  private async legacy(
    req: AuthenticatedRequest,
    body: unknown,
    res: Response,
    operation: AiOperation,
  ) {
    const params = jsonObject.parse(body);
    return this.enqueue(
      req,
      {
        operation,
        params,
        regenerate: params.retry === true || params.regenerate === true,
        commandId: params.commandId,
      },
      res,
    );
  }
}
@Module({
  controllers: [AiController],
  providers: [AiRepository, LifestyleRepository, DocumentAssets, ...aiHandlers],
  exports: [AiRepository, LifestyleRepository],
})
export class AiModule {}
