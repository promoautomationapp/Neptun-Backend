import "reflect-metadata";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "../../src/modules/health/health.module";
import type { Database } from "../../src/database/database";

afterEach(() => jest.restoreAllMocks());
test("hundreds of concurrent probes share one in-flight query, then reuse success for five seconds", async () => {
  let now = 100000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  let finish!: (value: unknown[]) => void;
  const query = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue([]);
  const health = new HealthController({ query } as unknown as Database);
  const checks = Array.from({ length: 250 }, () => health.ready());
  expect(query).toHaveBeenCalledTimes(1);
  finish([]);
  expect(await Promise.all(checks)).toEqual(
    Array.from({ length: 250 }, () => ({ status: "ready" })),
  );
  now += 4999;
  expect(await health.ready()).toEqual({ status: "ready" });
  expect(query).toHaveBeenCalledTimes(1);
  now += 1;
  await Promise.all(Array.from({ length: 100 }, () => health.ready()));
  expect(query).toHaveBeenCalledTimes(2);
});
test("a failed probe is coalesced, returns a generic unavailable status, then recovers after one second", async () => {
  let now = 100000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const query = jest
    .fn()
    .mockRejectedValueOnce(new Error("private-database-connection-details"))
    .mockResolvedValue([]);
  const health = new HealthController({ query } as unknown as Database);
  const replies = await Promise.allSettled(
    Array.from({ length: 100 }, () => health.ready()),
  );
  expect(query).toHaveBeenCalledTimes(1);
  for (const reply of replies) {
    expect(reply.status).toBe("rejected");
    const error = (reply as PromiseRejectedResult)
      .reason as ServiceUnavailableException;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.message).toBe("Database is not ready.");
  }
  now += 999;
  await expect(health.ready()).rejects.toMatchObject({ status: 503 });
  expect(query).toHaveBeenCalledTimes(1);
  now += 1;
  expect(await health.ready()).toEqual({ status: "ready" });
  expect(query).toHaveBeenCalledTimes(2);
  now += 4999;
  await health.ready();
  expect(query).toHaveBeenCalledTimes(2);
});
test("the inexpensive liveness probe never queries the database, including during a readiness failure", async () => {
  const query = jest.fn().mockRejectedValue(new Error("unavailable"));
  const health = new HealthController({ query } as unknown as Database);
  for (let index = 0; index < 100; index++)
    expect(health.health()).toEqual({ status: "ok" });
  expect(query).not.toHaveBeenCalled();
  await expect(health.ready()).rejects.toMatchObject({ status: 503 });
  expect(health.health()).toEqual({ status: "ok" });
  expect(query).toHaveBeenCalledTimes(1);
});
