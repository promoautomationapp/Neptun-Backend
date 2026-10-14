import { Body, Controller, Get, Inject, Put, Req } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { workspaceSettingsSchema } from "./domain/settings.schema";
import {
  GetSettingsQuery,
  SaveSettingsCommand,
} from "./application/settings.messages";
const saveInput = z.object({
  settings: workspaceSettingsSchema,
  expectedVersion: z.number().int().nonnegative(),
});
@Controller("api/team/settings")
export class SettingsController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(CommandBus) private readonly commands: CommandBus,
  ) {}
  @Get() get(@Req() request: AuthenticatedRequest) {
    return this.queries.execute(
      new GetSettingsQuery(request.actor.organizationId),
    );
  }
  @Put() async save(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const { settings, expectedVersion } = saveInput.parse(body);
    const snapshot = await this.commands.execute(
      new SaveSettingsCommand(
        request.actor.organizationId,
        settings,
        request.actor.userId,
        expectedVersion,
      ),
    );
    return { saved: true, ...snapshot };
  }
}
