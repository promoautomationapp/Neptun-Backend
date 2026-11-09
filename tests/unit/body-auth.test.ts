import express from "express";
import request from "supertest";
import type { Actor } from "../../src/modules/auth/domain/actor";
import {
  authenticatedBodyAdmission,
  admittedBodyActor,
} from "../../src/security/body-auth";
import { accountJsonParser } from "../../src/security/body-budget";

const actor: Actor = {
  userId: "one",
  organizationId: "org",
  email: "user@example.test",
  role: "editor",
  reviewRole: "staff",
  mustChangePassword: false,
};

function appFor(session: (req: express.Request) => Promise<Actor | null>) {
  const app = express();
  app.use(authenticatedBodyAdmission(session));
  app.use(accountJsonParser());
  app.use(express.json({ limit: "10mb", inflate: false }));
  app.use((req, res) =>
    res.json({
      admitted: admittedBodyActor(req)?.userId,
      parsed: Boolean(req.body),
    }),
  );
  return app;
}

test("protected malformed/large bodies are refused before parsing without a valid session", async () => {
  const session = jest.fn(async () => null);
  const app = appFor(session);
  await request(app)
    .post("/api/team/campaigns")
    .set("Content-Type", "application/json")
    .send('{"invalid":')
    .expect(401);
  await request(app)
    .put("/api/assets/uploads/id")
    .set("Content-Type", "image/png")
    .send(Buffer.alloc(100))
    .expect(401);
  expect(session).toHaveBeenCalledTimes(2);
});

test("a valid body actor is reusable by the route guard, while password changes keep their gate", async () => {
  const allowed = await request(appFor(async () => actor))
    .post("/api/team/campaigns")
    .send({ products: [] })
    .expect(200);
  expect(allowed.body).toEqual({ admitted: "one", parsed: true });
  const forced = appFor(async () => ({ ...actor, mustChangePassword: true }));
  await request(forced).post("/api/team/campaigns").send({}).expect(403);
  await request(forced).post("/api/team/change-password").send({}).expect(200);
});

test("public identity forms remain accessible with their small parser limit; GET bodies are refused", async () => {
  const session = jest.fn(async () => null);
  const app = appFor(session);
  await request(app)
    .post("/api/team/login")
    .send({ email: "user@example.test" })
    .expect(200);
  await request(app)
    .post("/api/team/reset-password")
    .send({ payload: "x".repeat(66_000) })
    .expect(413);
  await request(app)
    .get("/api/team/session")
    .set("Content-Type", "application/json")
    .send("{}")
    .expect(400);
  expect(session).not.toHaveBeenCalled();
});

test("session checks have bounded admission and release their slots after failures", async () => {
  const session = jest.fn(async () => {
    throw new Error("database unavailable");
  });
  const app = appFor(session);
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(503).end();
    },
  );
  for (let index = 0; index < 18; index++)
    await request(app).post("/api/team/campaigns").send({}).expect(503);
  expect(session).toHaveBeenCalledTimes(18);
});
