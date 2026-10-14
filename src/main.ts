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

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(
    "/api/assets/uploads",
    express.raw({
      type: [...UPLOAD_IMAGE_TYPES],
      limit: "12mb",
    }),
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(browserMetadata());
  app.use(compression());
  app.enableCors({
    origin: env.CORS_ORIGIN.split(",").map((x) => x.trim()),
    credentials: true,
  });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const host =
    env.HOST ?? (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  await app.listen(env.PORT, host);
  logger.info({ port: env.PORT }, "Neptun Broshura API ready");
}
void main().catch((error) => {
  logger.fatal({ err: error }, "API startup failed");
  process.exitCode = 1;
});
