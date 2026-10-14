import { Injectable, Module, Global, Optional, Inject } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/environment";
import * as schema from "./schema";

export const DATABASE_CONNECTION = Symbol("DATABASE_CONNECTION");

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;
  readonly orm: ReturnType<typeof drizzle<typeof schema>>;
  constructor(
    @Optional() @Inject(DATABASE_CONNECTION) connectionString?: string,
  ) {
    this.pool = new Pool({
      connectionString: connectionString ?? env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
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
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
