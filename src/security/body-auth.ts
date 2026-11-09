import type { Request, RequestHandler } from "express";
import type { Actor } from "../modules/auth/domain/actor";

const admittedActors = new WeakMap<Request, Actor>();
const publicForms = new Set(
  [
    "login",
    "logout",
    "accept-invitation",
    "request-invitation-code",
    "verify-invitation",
    "forgot-password",
    "request-reset-code",
    "reset-password",
  ].map((path) => `/api/team/${path}`),
);

export const admittedBodyActor = (request: Request) =>
  admittedActors.get(request);

/** Reject unauthenticated large bodies before JSON/raw parsers allocate them.
 * Public account forms still use their separate 64 KiB parser and rate limits. */
export function authenticatedBodyAdmission(
  session: (request: Request) => Promise<Actor | null>,
): RequestHandler {
  let pending = 0;
  return (request, response, next) => {
    if (
      !request.headers["transfer-encoding"] &&
      !Number(request.headers["content-length"])
    )
      return next();
    const reject = (status: number, error: string, code: string) => {
      response.set("Connection", "close").status(status).json({ error, code });
    };
    if (["GET", "HEAD", "OPTIONS"].includes(request.method))
      return reject(
        400,
        "This request does not accept a body.",
        "UNEXPECTED_BODY",
      );
    const path = request.path.toLowerCase().replace(/\/+$/, "");
    if (publicForms.has(path)) return next();
    if (pending >= 16) {
      response.set("Retry-After", "1");
      return reject(
        429,
        "Too many requests. Please try again later.",
        "BODY_AUTH_BUSY",
      );
    }
    pending++;
    void Promise.resolve()
      .then(() => session(request))
      .then((actor) => {
        if (response.destroyed) return;
        if (!actor) return reject(401, "Sign in to continue.", "UNAUTHORIZED");
        if (actor.mustChangePassword && path !== "/api/team/change-password")
          return reject(
            403,
            "Change your password before opening the workspace.",
            "PASSWORD_CHANGE_REQUIRED",
          );
        admittedActors.set(request, actor);
        next();
      })
      .catch((error: unknown) => next(error))
      .finally(() => {
        pending--;
      });
  };
}
