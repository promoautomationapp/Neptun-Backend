import type { RequestHandler } from "express";
import { Router, json } from "express";

/** Account forms are small. Documents/settings share /api/team, so their larger
 * parser allowance must remain separate from these identity routes. */
export function accountJsonParser(): RequestHandler {
  const router = Router();
  router.use(
    [
      "login",
      "logout",
      "change-password",
      "users",
      "accept-invitation",
      "request-invitation-code",
      "verify-invitation",
      "forgot-password",
      "request-reset-code",
      "reset-password",
    ].map((path) => `/api/team/${path}`),
    json({ limit: "64kb", inflate: false }),
  );
  return router;
}

/** Bound simultaneously buffered request bodies on the small combined service.
 * Reject rather than queue untrusted streams. Parsers still enforce byte caps. */
export function bodyBudget(
  options = { maxConcurrent: 4, maxBytes: 32 * 1024 * 1024 },
): RequestHandler {
  let active = 0,
    bytes = 0;
  return (request, response, next) => {
    if (
      !request.headers["transfer-encoding"] &&
      !request.headers["content-length"]
    )
      return next();
    const declared = Number(request.headers["content-length"]);
    const reserved = Math.min(
      12 * 1024 * 1024,
      Number.isFinite(declared) && declared > 0 ? declared : 12 * 1024 * 1024,
    );
    if (
      active >= options.maxConcurrent ||
      bytes + reserved > options.maxBytes
    ) {
      response
        .set("Retry-After", "1")
        .set("Connection", "close")
        .status(429)
        .json({
          error: "Too many requests. Please try again later.",
          code: "BODY_CAPACITY",
          retryAfterSeconds: 1,
        });
      return;
    }
    active += 1;
    bytes += reserved;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      bytes -= reserved;
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
}
