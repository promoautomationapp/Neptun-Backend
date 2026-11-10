import "reflect-metadata";
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { Database } from "../../src/database/database";
import { logger } from "../../src/shared/logger";

jest.mock("../../src/config/environment", () => ({
  env: { DATABASE_URL: "postgres://runtime:unused@localhost/isolated_test" },
}));
jest.mock("../../src/shared/logger", () => ({ logger: { warn: jest.fn() } }));

function transactionClient() {
  const events = new EventEmitter();
  return Object.assign(events, {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  });
}

test("an idle-pool disconnect is handled without stopping the application", async () => {
  const db = new Database();
  try {
    const error = Object.assign(new Error("read ECONNABORTED"), {
      code: "ECONNABORTED",
    });
    expect(() => db.pool.emit("error", error)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      { err: error },
      expect.stringContaining("pool will replace"),
    );
    const query = jest
      .spyOn(db.pool, "query")
      .mockResolvedValueOnce({ rows: [{ available: true }] } as never);
    await expect(db.query("SELECT true AS available")).resolves.toEqual([
      { available: true },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    await db.onModuleDestroy();
  }
});

test("a disconnect between transaction queries fails once, discards the client and does not replay work", async () => {
  const db = new Database();
  const client = transactionClient();
  jest.spyOn(db.pool, "connect").mockResolvedValue(client as unknown as never);
  const error = new Error("connection terminated");
  const operation = jest.fn(async (_client: PoolClient) => {
    client.emit("error", error);
    return "must not commit";
  });
  try {
    await expect(db.transaction(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN"]);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount("error")).toBe(0);
  } finally {
    await db.onModuleDestroy();
  }
});

test("rollback failure preserves the operation error and evicts the unusable connection", async () => {
  const db = new Database();
  const client = transactionClient();
  client.query
    .mockResolvedValueOnce({ rows: [] })
    .mockRejectedValueOnce(new Error("socket closed"));
  jest.spyOn(db.pool, "connect").mockResolvedValue(client as unknown as never);
  const error = new Error("operation failed");
  try {
    await expect(
      db.transaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount("error")).toBe(0);
  } finally {
    await db.onModuleDestroy();
  }
});

test("successful transactions release normally and remove their scoped listener", async () => {
  const db = new Database();
  const client = transactionClient();
  jest.spyOn(db.pool, "connect").mockResolvedValue(client as unknown as never);
  try {
    await expect(db.transaction(async () => "saved")).resolves.toBe("saved");
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledWith(false);
    expect(client.listenerCount("error")).toBe(0);
  } finally {
    await db.onModuleDestroy();
  }
});
