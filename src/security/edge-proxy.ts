import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";

const verifiedAddresses = new WeakMap<Request, string>();
const signatureHeader = "x-neptun-edge-signature";
const timestampHeader = "x-neptun-edge-timestamp";
const addressHeader = "x-neptun-edge-client-ip";
const originHeader = "x-neptun-edge-origin";

export function verifiedClientIp(request: Request): string | undefined {
  return verifiedAddresses.get(request) ?? request.socket.remoteAddress;
}

/** Shared only by the Cloudflare server-side Worker and Render. Browser headers
 * never establish trust. Bind signatures to the request and expire them quickly. */
export function edgeProxyMiddleware(options: {
  secret: string;
  allowedOrigins: readonly string[];
  now?: () => number;
}): RequestHandler {
  const allowed = new Set(options.allowedOrigins);
  return (request, response, next) => {
    const path = request.originalUrl.split("?")[0]!.toLowerCase();
    const publicProbe =
      ["GET", "HEAD"].includes(request.method) &&
      [
        "/health",
        "/ready",
        "/favicon.svg",
        "/favicon.ico",
        "/apple-touch-icon.png",
        "/robots.txt",
      ].includes(path);
    if (publicProbe) return next();

    const origin = request.get("origin");
    if (
      (origin && !allowed.has(origin)) ||
      (!origin && request.get("sec-fetch-site") === "cross-site")
    ) {
      response.status(403).json({ error: "Request origin is not allowed." });
      return;
    }
    // Local development remains usable. Production activates the gate by
    // installing the same dedicated secret on the two server environments.
    if (!options.secret) return next();

    const timestamp = request.get(timestampHeader) ?? "";
    const clientIp = request.get(addressHeader) ?? "";
    const frontendOrigin = request.get(originHeader) ?? "";
    const signature = request.get(signatureHeader) ?? "";
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const validMetadata =
      /^\d{10}$/.test(timestamp) &&
      Math.abs(now - Number(timestamp)) <= 60 &&
      Boolean(isIP(clientIp)) &&
      allowed.has(frontendOrigin) &&
      /^[a-f0-9]{64}$/.test(signature);
    const expected = createHmac("sha256", options.secret)
      .update(
        [
          "v1",
          timestamp,
          request.method,
          request.originalUrl,
          clientIp,
          frontendOrigin,
        ].join("\n"),
      )
      .digest();
    if (
      !validMetadata ||
      !timingSafeEqual(expected, Buffer.from(signature, "hex"))
    ) {
      response
        .status(403)
        .json({
          error: "Open the workspace to continue.",
          code: "EDGE_REQUIRED",
        });
      return;
    }
    verifiedAddresses.set(request, clientIp);
    // Existing audit handlers use Express's ip property. Set it only after a
    // valid signature; trust proxy stays disabled for all other requests.
    Object.defineProperty(request, "ip", {
      value: clientIp,
      configurable: true,
    });
    next();
  };
}
