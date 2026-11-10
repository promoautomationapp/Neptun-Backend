import { Injectable, Module, Global, Optional, Inject } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/environment";
import * as schema from "./schema";
import { POSTGRES_AUTH_OPTIONS } from "./postgres-options";
import { logger } from "../shared/logger";

export const DATABASE_CONNECTION = Symbol("DATABASE_CONNECTION");

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;
  readonly orm: ReturnType<typeof drizzle<typeof schema>>;
  constructor(
    @Optional() @Inject(DATABASE_CONNECTION) connectionString?: string,
  ) {
    this.pool = new Pool({
      ...POSTGRES_AUTH_OPTIONS,
      connectionString: connectionString ?? env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // pg has already removed the failed idle client before this event. Handle
    // the event so a transient database disconnect does not terminate either
    // process; the pool opens a fresh connection for subsequent work.
    this.pool.on("error", (error) => {
      logger.warn(
        { err: error },
        "Database idle connection failed; pool will replace it",
      );
    });
    this.orm = drizzle(this.pool, { schema });
  }
  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(text, [...values])).rows;
  }
  async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let connectionError: Error | undefined;
    let discard = false;
    // A checked-out client has no pool idle listener while an operation awaits
    // other work between queries. Keep that disconnect from becoming an
    // unhandled Client error, then fail this transaction without replaying it.
    const disconnected = (error: Error) => {
      connectionError = error;
      discard = true;
      logger.warn(
        { err: error },
        "Database transaction connection interrupted",
      );
    };
    client.on("error", disconnected);
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      if (connectionError) throw connectionError;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (!connectionError) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          discard = true;
          logger.warn(
            { err: rollbackError },
            "Database rollback failed; connection discarded",
          );
        }
      }
      throw error;
    } finally {
      client.release(discard);
      client.removeListener("error", disconnected);
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
