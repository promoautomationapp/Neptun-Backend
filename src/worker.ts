import "reflect-metadata";
import {
  processCatalogRefresh,
  processCatalogImages,
} from "./modules/catalog/catalog.processor";
import { processCatalogBrandImage } from "./modules/catalog/catalog-brands";
import { CatalogRepository } from "./modules/catalog/catalog.repository";
import { directConnection } from "./database/direct-connection";
import { OpenAiProvider } from "./worker/ai/provider";
import { processAiJob } from "./worker/ai/processor";
import { z } from "zod";
import PgBoss from "pg-boss";
import { env } from "./config/environment";
import { logger } from "./shared/logger";
import { Database } from "./database/database";
import { LocalStorage } from "./modules/storage/local.storage";
import { R2Storage } from "./modules/storage/r2.storage";
import { generateVariants } from "./worker/variants.processor";
import type { JsonObject } from "./shared/json";
import { recoverInterruptedCatalogJobs } from "./worker/catalog-recovery";
import { recoverInterruptedAiJobs } from "./worker/ai/recovery";
import { registerAiConsumers } from "./worker/ai/consumer";

async function main(): Promise<void> {
  const connectionString = directConnection(
    env.DATABASE_URL,
    env.DIRECT_DATABASE_URL,
  );
  const boss = new PgBoss({
    connectionString,
    pollingIntervalSeconds: env.QUEUE_POLL_SECONDS,
    supervise: true,
    schedule: true,
  });
  boss.on("error", (error) =>
    logger.error({ err: error }, "Worker queue error"),
  );
  await boss.start();
  const db = new Database(connectionString);
  const storage =
    env.STORAGE_DRIVER === "local"
      ? new LocalStorage(env.LOCAL_STORAGE_DIR)
      : new R2Storage();
  await boss.createQueue("catalog-refresh");
  await boss.createQueue("catalog-images");
  await boss.createQueue("catalog-brand-images");
  await recoverInterruptedCatalogJobs(db);
  await recoverInterruptedAiJobs(db);
  await boss.work<{
    organizationId: string;
    brandId: number;
    sourceImageUrl: string;
  }>("catalog-brand-images", { batchSize: 2 }, async (jobs) => {
    await Promise.all(
      jobs.map((job) => processCatalogBrandImage(db, storage, job.data)),
    );
  });
  await boss.createQueue("catalog-daily");
  const catalog = new CatalogRepository(db);
  await boss.work("catalog-daily", async () => {
    for (const organization of await db.query<{ id: string }>(
      "SELECT id FROM organizations WHERE slug='neptun'",
    ))
      await catalog.enqueue(organization.id, "daily");
  });
  await boss.schedule(
    "catalog-daily",
    "0 3 * * *",
    {},
    { tz: "Europe/Belgrade" },
  );
  await boss.work<{ organizationId: string; runId: string }>(
    "catalog-refresh",
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await processCatalogRefresh(db, job.data);
    },
  );
  await boss.work<{
    organizationId: string;
    productId: string;
    imageUrls: string[];
  }>("catalog-images", { batchSize: 2 }, async (jobs) => {
    await Promise.all(
      jobs.map((job) => processCatalogImages(db, storage, job.data)),
    );
  });
  await boss.createQueue("asset-variants");
  await boss.work<JsonObject>(
    "asset-variants",
    { batchSize: 20, pollingIntervalSeconds: env.QUEUE_POLL_SECONDS },
    async (jobs) => {
      for (let index = 0; index < jobs.length; index += 4)
        await Promise.all(
          jobs
            .slice(index, index + 4)
            .map((job) => generateVariants(db, storage, job.data)),
        );
    },
  );
  for (const [queue, concurrency] of [
    ["ai-image", env.AI_IMAGE_CONCURRENCY],
    ["ai-text", env.AI_TEXT_CONCURRENCY],
  ] as const) {
    await boss.createQueue(queue);
    await registerAiConsumers(
      boss,
      queue,
      concurrency,
      Math.min(env.QUEUE_POLL_SECONDS, 2),
      async (data) => {
        const { organizationId } = z
          .object({ organizationId: z.uuid() })
          .parse(data);
        return processAiJob(
          db,
          storage,
          data,
          new OpenAiProvider(db, storage, organizationId),
        );
      },
    );
  }
  let stopping = false;
  let dispatching = false;
  const dispatch = async () => {
    if (stopping || dispatching) return;
    dispatching = true;
    try {
      await db.transaction(async (client) => {
        const rows = await client.query<{
          id: string;
          queue: string;
          job_key: string;
          payload: JsonObject;
        }>(
          "SELECT id,queue,job_key,payload FROM job_outbox WHERE dispatched_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 200",
        );
        for (const row of rows.rows) {
          const sent = await boss.send(row.queue, row.payload, {
            id: row.id,
            singletonKey: row.job_key,
            retryLimit:
              row.queue === "catalog-refresh"
                ? 0
                : row.queue.startsWith("ai-")
                  ? 1
                  : 2,
            retryDelay: 3,
            retryBackoff: true,
            expireInSeconds: row.queue === "catalog-refresh" ? 7200 : 900,
          });
          if (!sent && !(await boss.getJobById(row.queue, row.id)))
            throw new Error(
              `The job queue did not accept ${row.queue}. The outbox will retry.`,
            );
          await client.query(
            "UPDATE job_outbox SET dispatched_at=now() WHERE id=$1",
            [row.id],
          );
        }
      });
    } catch (error) {
      logger.error({ err: error }, "Outbox dispatch failed");
    } finally {
      dispatching = false;
    }
  };
  await dispatch();
  let recovering = false;
  const recoveryTimer = setInterval(() => {
    if (stopping || recovering) return;
    recovering = true;
    void Promise.all([
      recoverInterruptedCatalogJobs(db),
      recoverInterruptedAiJobs(db),
    ])
      .then(([catalogResult, aiResult]) => {
        if (catalogResult.requeued || catalogResult.failed)
          logger.info(catalogResult, "Recovered interrupted catalog jobs");
        if (aiResult.failed || aiResult.uncertain)
          logger.info(aiResult, "Reconciled interrupted AI jobs");
      })
      .catch((error) => logger.error({ err: error }, "Queue recovery failed"))
      .finally(() => {
        recovering = false;
      });
  }, 30_000);
  const timer = setInterval(
    () => {
      void dispatch();
    },
    Math.min(env.QUEUE_POLL_SECONDS, 2) * 1000,
  );
  logger.info("Neptun worker connected to PostgreSQL");
  const stop = async () => {
    stopping = true;
    clearInterval(timer);
    clearInterval(recoveryTimer);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await db.onModuleDestroy();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}
void main().catch((error) => {
  logger.fatal({ err: error }, "Worker startup failed");
  process.exitCode = 1;
});
