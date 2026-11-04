import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { apiCachePolicy } from "../../src/security/api-cache-policy";
import { edgeProxyMiddleware } from "../../src/security/edge-proxy";
import { ErrorFilter } from "../../src/shared/error.filter";

function server() {
  const app = express();
  app.use(apiCachePolicy());
  app.use(express.json({ limit: "1kb" }));
  app.all(["/api", "/api/team/session", "/api/team/campaigns"], (_req, res) =>
    res.json({ user: { id: "private-user" } }),
  );
  app.get("/api/assets/prepared-photo", (_req, res) =>
    res
      .set("Cache-Control", "private, max-age=31536000, immutable")
      .vary("Cookie")
      .type("image/png")
      .send(Buffer.from("photo")),
  );
  app.get("/api/assets/missing-photo", (_req, res) => {
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    throw new NotFoundException("Asset not found.");
  });
  app.get("/api/team/restricted", (_req, res) =>
    res.status(401).json({ error: "Sign in to continue." }),
  );
  app.get(["/health", "/api-example"], (_req, res) => res.json({ ok: true }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) =>
    new ErrorFilter().catch(error, {
      switchToHttp: () => ({ getResponse: () => res }),
    } as ArgumentsHost),
  );
  return app;
}

test("session and workspace responses stay private and uncacheable for every API method", async () => {
  const app = server();
  for (const path of ["/api", "/api/team/session", "/API/team/campaigns?q=1"]) {
    const response = await request(app).get(path).expect(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toContain("Cookie");
    expect(response.headers.vary).toContain("Authorization");
  }
  const mutation = await request(app)
    .post("/api/team/campaigns")
    .send({ name: "Private brochure" })
    .expect(200);
  expect(mutation.headers["cache-control"]).toBe("private, no-store");
});

test("successful immutable media keeps its explicit browser cache policy", async () => {
  const response = await request(server())
    .get("/api/assets/prepared-photo")
    .expect(200);
  expect(response.headers["cache-control"]).toBe(
    "private, max-age=31536000, immutable",
  );
  expect(response.headers.vary).toContain("Cookie");
});

test("authorization failures and missing media cannot inherit successful caching", async () => {
  const app = server();
  for (const [path, status] of [
    ["/api/team/restricted", 401],
    ["/api/assets/missing-photo", 404],
    ["/api/assets/not-found", 404],
  ] as const) {
    const response = await request(app).get(path).expect(status);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  }
});

test("edge and rate-limit rejections receive privacy headers before admission", async () => {
  const edge = express();
  edge.use(apiCachePolicy());
  edge.use(
    edgeProxyMiddleware({
      secret: "test-only-edge-key-32-characters-long",
      allowedOrigins: ["https://studio.example.test"],
    }),
  );
  const denied = await request(edge).get("/api/team/session").expect(403);
  expect(denied.headers["cache-control"]).toBe("private, no-store");
  expect(denied.headers.vary).toContain("Cookie");
  const limited = express();
  limited.use(apiCachePolicy());
  limited.use((_req, res) =>
    res
      .set("Retry-After", "1")
      .status(429)
      .json({ error: "Too many requests." }),
  );
  const rejected = await request(limited).get("/api/team/session").expect(429);
  expect(rejected.headers["cache-control"]).toBe("private, no-store");
  expect(rejected.headers["retry-after"]).toBe("1");
});

test("non-API public routes keep their own cache behavior", async () => {
  const app = server();
  for (const path of ["/health", "/api-example"]) {
    const response = await request(app).get(path).expect(200);
    expect(response.headers["cache-control"]).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
  }
});
