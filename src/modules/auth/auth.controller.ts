import { Body, Controller, Get, Post, Req, Res, Inject } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { Response, Request } from "express";
import { z } from "zod";
import { IdentityService } from "../users/identity.service";
import { env } from "../../config/environment";
import { COOKIE, Public, sessionToken } from "./auth.guard";
import { publicUser } from "./domain/actor";
import type { AuthenticatedRequest } from "./domain/actor";
import {
  LoginCommand,
  LogoutCommand,
  SessionQuery,
  MembersQuery,
} from "./application/handlers";

@Controller("api/team")
export class AuthController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(QueryBus) private readonly queries: QueryBus,
  ) {}
  @Get("session")
  @Public()
  async session(@Req() request: Request) {
    const actor = await this.queries.execute(
      new SessionQuery(sessionToken(request)),
    );
    return { configured: true, user: actor ? publicUser(actor) : null };
  }
  @Post("login")
  @Public()
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = z
      .object({
        email: z.email().transform((x) => x.trim().toLowerCase()),
        password: z.string().min(1).max(512),
      })
      .parse(body);
    const result = await this.commands.execute(
      new LoginCommand(input.email, input.password, request.ip ?? "local"),
    );
    response.cookie(COOKIE, result.token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api",
      maxAge: 14 * 86400_000,
    });
    return { user: publicUser(result.actor) };
  }
  @Post("logout")
  @Public()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.commands.execute(new LogoutCommand(sessionToken(request)));
    response.clearCookie(COOKIE, { path: "/api" });
    return { signedOut: true };
  }
  @Post("change-password")
  async changePassword(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = z
      .object({
        currentPassword: z.string().min(1).max(512),
        password: z.string().min(12).max(512),
      })
      .strict()
      .parse(body);
    const result = await this.identity.changePassword(
      request.actor,
      input.currentPassword,
      input.password,
    );
    response.clearCookie(COOKIE, { path: "/api" });
    return result;
  }
  @Get("members")
  async members(@Req() request: AuthenticatedRequest) {
    return {
      members: await this.queries.execute(
        new MembersQuery(request.actor.organizationId),
      ),
    };
  }
}
