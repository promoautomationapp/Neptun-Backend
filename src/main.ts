import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import compression from "compression";
import helmet from "helmet";
import express from "express";
import { AppModule } from "./app.module";
import { env } from "./config/environment";
import { ErrorFilter } from "./shared/error.filter";
import { logger } from "./shared/logger";
import { UPLOAD_IMAGE_TYPES } from "./modules/assets/image-input";
import { browserMetadata } from "./shared/browser-metadata";
import { Database } from "./database/database";
import { edgeProxyMiddleware, verifiedClientIp } from "./security/edge-proxy";
import { apiRateLimitMiddleware } from "./security/request-limits";
import { apiCachePolicy } from "./security/api-cache-policy";
import { bodyBudget, accountJsonParser } from "./security/body-budget";
import type { Server } from "node:http";
import { configureImageRuntime } from "./shared/image-runtime";
import { startMemoryTelemetry } from "./shared/memory-telemetry";
import { authenticatedBodyAdmission } from "./security/body-auth";
import { AuthRepository } from "./modules/auth/auth.repository";
import { sessionToken } from "./modules/auth/auth.guard";

async function main(): Promise<void> {
  configureImageRuntime();
  startMemoryTelemetry("api");
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(
    helmet({
      crossOriginResourcePolicy: {
        policy: env.NODE_ENV === "production" ? "same-origin" : "cross-origin",
      },
    }),
  );
  app.use(apiCachePolicy());
  app.use(
    edgeProxyMiddleware({
      secret: env.EDGE_PROXY_SECRET,
      allowedOrigins: env.CORS_ORIGIN.split(",").map((value) => value.trim()),
    }),
  );
  app.use(apiRateLimitMiddleware(app.get(Database), verifiedClientIp));
  app.use(
    authenticatedBodyAdmission((request) =>
      app.get(AuthRepository).session(sessionToken(request)),
    ),
  );
  app.use(bodyBudget());
  app.use(accountJsonParser());
  app.use(
    "/api/assets/uploads",
    express.raw({
      type: [...UPLOAD_IMAGE_TYPES],
      limit: "12mb",
      inflate: false,
    }),
  );
  app.use(express.json({ limit: "10mb", inflate: false }));
  app.use(browserMetadata());
  app.use(compression());
  app.enableCors({
    origin: env.CORS_ORIGIN.split(",").map((x) => x.trim()),
    credentials: true,
  });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  if (env.NODE_ENV === "production" && !env.EDGE_PROXY_SECRET)
    logger.warn(
      "Direct backend access is not gated: configure EDGE_PROXY_SECRET on Render and the Cloudflare Worker.",
    );
  const host =
    env.HOST ?? (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  const server = (await app.listen(env.PORT, host)) as Server;
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  logger.info({ port: env.PORT }, "Neptun Broshura API ready");
}
void main().catch((error) => {
  logger.fatal({ err: error }, "API startup failed");
  process.exitCode = 1;
});
