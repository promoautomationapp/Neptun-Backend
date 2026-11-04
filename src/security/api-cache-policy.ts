import type { RequestHandler } from "express";

/** API responses contain session and workspace state. Set the safe default
 * before admission/body/auth middleware so their rejections cannot be cached.
 * Successful immutable media routes explicitly replace this header. */
export function apiCachePolicy(): RequestHandler {
  return (request, response, next) => {
    const path = request.originalUrl.split("?")[0]!.toLowerCase();
    if (path === "/api" || path.startsWith("/api/")) {
      response.setHeader("Cache-Control", "private, no-store");
      response.vary("Cookie").vary("Authorization");
    }
    next();
  };
}
