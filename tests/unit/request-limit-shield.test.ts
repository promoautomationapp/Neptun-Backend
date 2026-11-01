import type { Request, Response, RequestHandler } from "express";
import type { Database } from "../../src/database/database";
import { apiRateLimitMiddleware } from "../../src/security/request-limits";

const limits = {
  generalPerSecond: 2,
  generalPerMinute: 20,
  assetsPerSecond: 120,
  assetsPerMinute: 2400,
};
function call(handler: RequestHandler, ip = "203.0.113.10") {
  const req = {
    method: "GET",
    originalUrl: "/api/probe",
    socket: { remoteAddress: ip },
  } as Request;
  const res = {
    destroyed: false,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn();
  handler(req, res, next);
  return { res, next };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => jest.restoreAllMocks());
test("parallel floods beyond the client cap are rejected before creating extra Postgres work", async () => {
  let now = 100000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const resolves: ((rows: { retry_after_seconds: number }[]) => void)[] = [];
  const query = jest.fn(
    () =>
      new Promise<{ retry_after_seconds: number }[]>((resolve) =>
        resolves.push(resolve),
      ),
  );
  const handler = apiRateLimitMiddleware(
    { query } as unknown as Pick<Database, "query">,
    undefined,
    limits,
  );
  const first = call(handler),
    second = call(handler),
    third = call(handler);
  expect(query).toHaveBeenCalledTimes(2);
  expect(third.res.status).toHaveBeenCalledWith(429);
  resolves.forEach((resolve) => resolve([{ retry_after_seconds: 0 }]));
  await flush();
  expect(first.next).toHaveBeenCalledTimes(1);
  expect(second.next).toHaveBeenCalledTimes(1);
  call(handler);
  expect(query).toHaveBeenCalledTimes(2);
  now += 1001;
  call(handler);
  expect(query).toHaveBeenCalledTimes(3);
  resolves[2]!([{ retry_after_seconds: 0 }]);
  await flush();
});
test("a known durable rejection is cached and expires, without counting rejected requests again", async () => {
  let now = 100000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ retry_after_seconds: 60 }])
    .mockResolvedValue([{ retry_after_seconds: 0 }]);
  const handler = apiRateLimitMiddleware(
    { query } as unknown as Pick<Database, "query">,
    undefined,
    limits,
  );
  const first = call(handler);
  await flush();
  expect(first.res.status).toHaveBeenCalledWith(429);
  for (let index = 0; index < 100; index++) call(handler);
  expect(query).toHaveBeenCalledTimes(1);
  now += 60001;
  const refreshed = call(handler);
  await flush();
  expect(query).toHaveBeenCalledTimes(2);
  expect(refreshed.next).toHaveBeenCalledTimes(1);
});
test("the in-memory LRU remains bounded while recent rejected clients keep their cache entry", async () => {
  jest.spyOn(Date, "now").mockReturnValue(100000);
  const query = jest.fn().mockResolvedValue([{ retry_after_seconds: 60 }]);
  const handler = apiRateLimitMiddleware(
    { query } as unknown as Pick<Database, "query">,
    undefined,
    limits,
  );
  for (let index = 1; index <= 4100; index++) {
    call(handler, `192.0.${Math.floor(index / 256)}.${index % 256}`);
    await flush();
  }
  const before = query.mock.calls.length;
  call(handler, "192.0.16.4");
  await flush();
  expect(query).toHaveBeenCalledTimes(before);
  call(handler, "192.0.0.1");
  await flush();
  expect(query).toHaveBeenCalledTimes(before + 1);
});
test("a distributed pending flood is bounded globally before Postgres queues grow without limit", async () => {
  const resolves: ((rows: { retry_after_seconds: number }[]) => void)[] = [];
  const query = jest.fn(
    () =>
      new Promise<{ retry_after_seconds: number }[]>((resolve) =>
        resolves.push(resolve),
      ),
  );
  const handler = apiRateLimitMiddleware(
    { query } as unknown as Pick<Database, "query">,
    undefined,
    { ...limits, generalPerSecond: 10000 },
  );
  const calls = Array.from({ length: 300 }, () => call(handler));
  expect(query).toHaveBeenCalledTimes(256);
  expect(
    calls.filter(
      (item) => (item.res.status as jest.Mock).mock.calls[0]?.[0] === 429,
    ),
  ).toHaveLength(44);
  resolves.forEach((resolve) => resolve([{ retry_after_seconds: 0 }]));
  await flush();
  expect(
    calls.filter((item) => item.next.mock.calls.length === 1),
  ).toHaveLength(256);
});
