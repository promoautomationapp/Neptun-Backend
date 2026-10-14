import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Public } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { IdentityService } from "./identity.service";
const email = z.string().trim().toLowerCase().pipe(z.email());
const name = z.string().trim().min(1).max(120);
const role = z.enum(["staff", "pm", "admin"]);
const token = z.string().min(20).max(256);
const code = z.string().regex(/^\d{6}$/, "Enter the six-digit code.");
const password = z.string().min(12, "Use at least 12 characters.").max(512);
const tokenBody = z.object({ token });
@Controller("api/team")
export class UsersController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  @Get("users") list(@Req() req: AuthenticatedRequest) {
    return this.identity.list(req.actor);
  }
  @Post("users/invite") invite(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.identity.invite(
      req.actor,
      z.object({ email, name, role }).strict().parse(body),
    );
  }
  @Patch("users/:id") update(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.identity.update(
      req.actor,
      z.uuid().parse(id),
      z
        .object({
          name: name.optional(),
          role: role.optional(),
          status: z.enum(["active", "disabled"]).optional(),
        })
        .strict()
        .refine((x) => Object.keys(x).length > 0, "Provide a change.")
        .parse(body),
    );
  }
  @Post("users/:id/resend-invite") resend(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.identity.resend(req.actor, z.uuid().parse(id));
  }
  @Get("account-token") @Public() inspect(
    @Req() req: Request,
    @Query("token") value: string,
  ) {
    return this.identity.inspectToken(token.parse(value), req.ip ?? "local");
  }
  @Post("accept-invitation") @Public() accept(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z.object({ token, password }).strict().parse(body);
    return this.identity.acceptInvitation(
      input.token,
      input.password,
      req.ip ?? "local",
    );
  }
  @Post("request-invitation-code") @Public() invitationCode(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return this.identity.requestInvitationCode(
      tokenBody.parse(body).token,
      req.ip ?? "local",
    );
  }
  @Post("verify-invitation") @Public() verify(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z.object({ token, code }).strict().parse(body);
    return this.identity.verifyInvitation(
      input.token,
      input.code,
      req.ip ?? "local",
    );
  }
  @Post("forgot-password") @Public() forgot(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return this.identity.forgot(
      z.object({ email }).strict().parse(body).email,
      req.ip ?? "local",
    );
  }
  @Post("request-reset-code") @Public() resetCode(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return this.identity.requestResetCode(
      tokenBody.parse(body).token,
      req.ip ?? "local",
    );
  }
  @Post("reset-password") @Public() reset(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z.object({ token, code, password }).strict().parse(body);
    return this.identity.reset(
      input.token,
      input.code,
      input.password,
      req.ip ?? "local",
    );
  }
}
