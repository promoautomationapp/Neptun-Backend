import "reflect-metadata";
import { Client } from "pg";
import type { ClientConfig } from "pg";
import PgBoss from "pg-boss";
import { Database } from "../../src/database/database";
import { POSTGRES_AUTH_OPTIONS } from "../../src/database/postgres-options";

test("API and pg-boss clients enable SCRAM channel binding without weakening SSL configuration", async () => {
  // Construct only: no database connection, migration, consumer or job is started.
  const connectionString =
    "postgres://runtime:unused@localhost/isolated_test?sslmode=verify-full";
  const database = new Database(connectionString);
  try {
    const client = new Client(database.pool.options);
    expect(client).toMatchObject({ enableChannelBinding: true });
    expect(client).toMatchObject({
      connectionParameters: { ssl: {} },
    });
    const boss = new PgBoss({
      ...POSTGRES_AUTH_OPTIONS,
      connectionString,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    // Pg-boss forwards additional pg options despite its older, narrower type.
    const config = (boss.getDb() as PgBoss.Db & { config: ClientConfig })
      .config;
    expect(new Client(config)).toMatchObject({
      enableChannelBinding: true,
      connectionParameters: { ssl: {} },
    });
    expect(config.ssl).toBeUndefined();
    expect(config.connectionString).toBe(connectionString);
  } finally {
    await database.onModuleDestroy();
  }
});
