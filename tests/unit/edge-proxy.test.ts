import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import {
  edgeProxyMiddleware,
  verifiedClientIp,
} from "../../src/security/edge-proxy";

const secret = "test-only-edge-key-32-characters-long";
const origin = "https://studio.example.test";
const timestamp = "1793512800";
function headers(
  path = "/api/probe?view=1",
  overrides: Record<string, string> = {},
) {
  const values = {
    "x-neptun-edge-timestamp": timestamp,
    "x-neptun-edge-client-ip": "203.0.113.42",
    "x-neptun-edge-origin": origin,
    ...overrides,
  };
  const signature = createHmac("sha256", secret)
    .update(
      [
        "v1",
        values["x-neptun-edge-timestamp"],
        "POST",
        path,
        values["x-neptun-edge-client-ip"],
        values["x-neptun-edge-origin"],
      ].join("\n"),
    )
    .digest("hex");
  return { ...values, "x-neptun-edge-signature": signature };
}
function server(configuredSecret = secret) {
  const app = express();
  app.use(
    edgeProxyMiddleware({
      secret: configuredSecret,
      allowedOrigins: [origin],
      now: () => Number(timestamp) * 1000,
    }),
  );
  app.use(express.json({ limit: "1kb" }));
  app.all(["/api/probe", "/api/team/login", "/ready"], (req, res) =>
    res.json({ ip: verifiedClientIp(req), auditIp: req.ip }),
  );
  return app;
}
describe("private edge proxy admission", () => {
  test("rejects direct and forged-origin requests before parsing their bodies", async () => {
    const response = await request(server())
      .post("/api/probe")
      .set("Origin", origin)
      .set("x-forwarded-for", "203.0.113.42")
      .send("x".repeat(2048));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("EDGE_REQUIRED");
  });
  test("accepts signed metadata and uses it for login limiting and audit addresses", async () => {
    const response = await request(server())
      .post("/api/probe?view=1")
      .set(headers())
      .set("Origin", origin)
      .set("x-forwarded-for", "1.2.3.4");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ip: "203.0.113.42",
      auditIp: "203.0.113.42",
    });
  });
  test.each([
    ["expired", { "x-neptun-edge-timestamp": "1793512700" }],
    ["future", { "x-neptun-edge-timestamp": "1793512900" }],
    ["invalid address", { "x-neptun-edge-client-ip": "203.0.113.42,1.2.3.4" }],
    ["unapproved site", { "x-neptun-edge-origin": "https://other.test" }],
  ])("rejects correctly signed but %s metadata", async (_reason, values) => {
    expect(
      (
        await request(server())
          .post("/api/probe?view=1")
          .set(headers(undefined, values))
      ).status,
    ).toBe(403);
  });
  test("binds the method, path, query and client address to the signature", async () => {
    for (const path of ["/api/team/login", "/api/probe?view=2"])
      expect((await request(server()).post(path).set(headers())).status).toBe(
        403,
      );
    expect(
      (await request(server()).get("/api/probe?view=1").set(headers())).status,
    ).toBe(403);
    expect(
      (
        await request(server())
          .post("/api/probe?view=1")
          .set(headers())
          .set("x-neptun-edge-client-ip", "203.0.113.43")
      ).status,
    ).toBe(403);
  });
  test("rejects an unapproved browser origin even with a valid edge signature", async () => {
    expect(
      (
        await request(server())
          .post("/api/probe?view=1")
          .set(headers())
          .set("Origin", "https://evil.test")
      ).status,
    ).toBe(403);
  });
  test("allows only public read probes and local development without a secret", async () => {
    expect((await request(server()).get("/ready")).status).toBe(200);
    expect((await request(server()).post("/ready")).status).toBe(403);
    expect(
      (
        await request(server(""))
          .post("/api/probe")
          .set("x-neptun-edge-client-ip", "203.0.113.42")
      ).body.ip,
    ).not.toBe("203.0.113.42");
  });
});
