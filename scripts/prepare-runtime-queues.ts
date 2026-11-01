import "dotenv/config";
import PgBoss from "pg-boss";
import { directConnection } from "../src/database/direct-connection";
import { RUNTIME_QUEUES } from "../src/database/runtime-role-plan";
import { POSTGRES_AUTH_OPTIONS } from "../src/database/postgres-options";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--execute" && !arg.startsWith("--database=")))
    throw new Error(
      "Usage: prepare-runtime-queues.ts [--execute --database=EXPECTED_DATABASE].",
    );
  if (!args.includes("--execute")) {
    console.log(
      JSON.stringify({
        dryRun: true,
        action:
          "Install/upgrade the pinned pg-boss schema and create required queue partitions only",
        queues: RUNTIME_QUEUES,
        consumers: false,
        scheduling: false,
        applicationMigrations: false,
      }),
    );
    return;
  }
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl)
    throw new Error(
      "MIGRATION_DATABASE_URL is required; runtime credentials are never used for queue provisioning.",
    );
  const expected = args.find((arg) => arg.startsWith("--database="))?.slice(11);
  const selected = directConnection(migrationUrl);
  if (
    !expected ||
    decodeURIComponent(new URL(selected).pathname.slice(1)) !== expected
  )
    throw new Error(
      "Provide --database matching the intended migration database.",
    );
  const boss = new PgBoss({
    ...POSTGRES_AUTH_OPTIONS,
    connectionString: selected,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => undefined);
  try {
    await boss.start();
    for (const queue of RUNTIME_QUEUES) await boss.createQueue(queue);
    console.log(
      JSON.stringify({
        prepared: true,
        queues: RUNTIME_QUEUES.length,
        consumers: false,
        scheduling: false,
      }),
    );
  } finally {
    await boss.stop();
  }
}
void main().catch(() => {
  console.error(
    "Queue provisioning did not complete. Check the explicit owner connection, database guard and schema permissions. No consumers were started.",
  );
  process.exitCode = 1;
});
