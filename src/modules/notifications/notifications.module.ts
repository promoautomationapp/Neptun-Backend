import {
  Controller,
  Get,
  Inject,
  Module,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { EmailModule } from "../email/email.module";
import { NotificationsRepository } from "./notifications.repository";

@Controller("api/notifications")
export class NotificationsController {
  constructor(
    @Inject(NotificationsRepository)
    private readonly notifications: NotificationsRepository,
  ) {}
  @Get() list(
    @Req() request: AuthenticatedRequest,
    @Query("filter") filter?: string,
  ) {
    return this.notifications.list(
      request.actor,
      z.enum(["all", "unread"]).default("all").parse(filter) === "unread",
    );
  }
  @Post("read-all") readAll(@Req() request: AuthenticatedRequest) {
    return this.notifications.read(request.actor, null, request.ip);
  }
  @Post(":id/read") read(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.notifications.read(
      request.actor,
      z.uuid().parse(id),
      request.ip,
    );
  }
}
@Module({
  imports: [EmailModule],
  controllers: [NotificationsController],
  providers: [NotificationsRepository],
  exports: [NotificationsRepository],
})
export class NotificationsModule {}
