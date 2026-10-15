import type PgBoss from "pg-boss";
import type { JsonObject } from "../../shared/json";

/** Independent consumers refill a free slot while another image is still slow. */
export async function registerAiConsumers(
  boss: Pick<PgBoss, "work">,
  queue: string,
  concurrency: number,
  pollingIntervalSeconds: number,
  process: (data: JsonObject) => Promise<void>,
): Promise<void> {
  for (let slot = 0; slot < concurrency; slot++)
    await boss.work<JsonObject>(
      queue,
      { batchSize: 1, pollingIntervalSeconds },
      async (jobs) => {
        for (const job of jobs) await process(job.data);
      },
    );
}
