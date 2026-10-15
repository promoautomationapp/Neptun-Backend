import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";
import { registerAiConsumers } from "../../src/worker/ai/consumer";
import { Database } from "../../src/database/database";

test("a slow image does not prevent the other worker slot from accepting the next image", async () => {
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
  const queue = `ai-slots-${randomUUID()}`;
  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let finishFast: () => void = () => {};
  const fast = new Promise<void>((resolve) => {
    finishFast = resolve;
  });
  let fastCount = 0;
  let slowFinished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await boss.start();
    await boss.createQueue(queue);
    await boss.send(queue, { slow: true });
    await boss.send(queue, { slow: false });
    await boss.send(queue, { slow: false });
    await registerAiConsumers(boss, queue, 2, 0.5, async (data) => {
      if (data.slow) {
        await slow;
        slowFinished = true;
      } else if (++fastCount === 2) finishFast();
    });
    await Promise.race([
      fast,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The fast slot did not refill.")),
          10_000,
        );
      }),
    ]);
    expect(fastCount).toBe(2);
    expect(slowFinished).toBe(false);
  } finally {
    clearTimeout(timer);
    releaseSlow();
    await boss.stop({ graceful: true, timeout: 5000 });
    const cleanup = new PgBoss({ connectionString: process.env.DATABASE_URL! });
    const db = new Database();
    try {
      await cleanup.start();
      await db.query("DELETE FROM pgboss.job WHERE name=$1", [queue]);
      await cleanup.deleteQueue(queue);
    } finally {
      await cleanup.stop();
      await db.onModuleDestroy();
    }
  }
});
