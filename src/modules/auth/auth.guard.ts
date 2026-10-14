import {
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthRepository } from "./auth.repository";
import type { AuthenticatedRequest } from "./domain/actor";
import { env } from "../../config/environment";

export const COOKIE = env.SESSION_COOKIE_NAME;
export const Public = () => SetMetadata("public", true);
export function sessionToken(request: {
  headers: { cookie?: string };
}): string {
  const part = request.headers.cookie
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`));
  return part?.slice(COOKIE.length + 1) ?? "";
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthRepository) private readonly repository: AuthRepository,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (
        origin &&
        !env.CORS_ORIGIN.split(",")
          .map((x) => x.trim())
          .includes(origin)
      )
        throw new ForbiddenException("Request origin is not allowed.");
      // Browsers send Origin on credentialed cross-origin mutations; reject untrusted browser sites.
      if (!origin && request.headers["sec-fetch-site"] === "cross-site")
        throw new ForbiddenException("Request origin is required.");
    }
    if (
      this.reflector.getAllAndOverride<boolean>("public", [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const actor = await this.repository.session(sessionToken(request));
    if (!actor) throw new UnauthorizedException("Sign in to continue.");
    if (
      actor.mustChangePassword &&
      request.path !== "/api/team/change-password"
    )
      throw new ForbiddenException({
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "Change your password before opening the workspace.",
      });
    request.actor = actor;
    return true;
  }
}
