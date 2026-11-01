import { EventEmitter } from "node:events";
import type { Request, Response, NextFunction } from "express";
import { bodyBudget, accountJsonParser } from "../../src/security/body-budget";
import express from "express";
import request from "supertest";

function response() {
  const res = new EventEmitter() as EventEmitter & {
    set: jest.Mock;
    status: jest.Mock;
    json: jest.Mock;
  };
  res.set = jest.fn(() => res);
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
test("limits body memory before parsing and releases each slot once on response finish or disconnect", () => {
  const guard = bodyBudget({ maxConcurrent: 2, maxBytes: 100 });
  const enter = (size: string) => {
    const res = response(),
      next = jest.fn();
    guard(
      { headers: { "content-length": size } } as Request,
      res as unknown as Response,
      next as NextFunction,
    );
    return { res, next };
  };
  const first = enter("60");
  expect(first.next).toHaveBeenCalledTimes(1);
  const rejected = enter("60");
  expect(rejected.next).not.toHaveBeenCalled();
  expect(rejected.res.status).toHaveBeenCalledWith(429);
  const second = enter("40");
  expect(second.next).toHaveBeenCalledTimes(1);
  expect(enter("1").next).not.toHaveBeenCalled();
  first.res.emit("finish");
  first.res.emit("close");
  expect(enter("60").next).toHaveBeenCalledTimes(1);
  expect(enter("1").next).not.toHaveBeenCalled();
  second.res.emit("close");
  expect(enter("40").next).toHaveBeenCalledTimes(1);
});
test("chunked streams reserve their full parser allowance, while bodyless probes need no slot", () => {
  const guard = bodyBudget({ maxConcurrent: 1, maxBytes: 12 * 1024 * 1024 });
  const res = response(),
    next = jest.fn();
  guard(
    { headers: { "transfer-encoding": "chunked" } } as Request,
    res as unknown as Response,
    next,
  );
  const blocked = response();
  guard(
    { headers: { "transfer-encoding": "chunked" } } as Request,
    blocked as unknown as Response,
    next,
  );
  expect(blocked.status).toHaveBeenCalledWith(429);
  guard({ headers: {} } as Request, response() as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(2);
});

test("small account limits leave normal 62-product brochure and settings saves available", async () => {
  const app = express();
  app.use(accountJsonParser());
  app.use(express.json({ limit: "10mb", inflate: false }));
  app.post(
    ["/api/team/login", "/api/team/campaigns", "/api/team/settings"],
    (req, res) => res.json({ accepted: Boolean(req.body) }),
  );
  const brochure = {
    products: Array.from({ length: 62 }, () => ({ details: "x".repeat(1400) })),
  };
  for (const path of ["/api/team/campaigns", "/api/team/settings"])
    expect((await request(app).post(path).send(brochure)).status).toBe(200);
  expect(
    (await request(app).post("/api/team/login").send(brochure)).status,
  ).toBe(413);
});
