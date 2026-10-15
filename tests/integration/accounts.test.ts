import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Agent } from "supertest";
import argon2 from "argon2";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import {
  EmailService,
  decryptEmail,
} from "../../src/modules/email/email.service";
import type { AccountEmail } from "../../src/modules/email/templates";
import { AuthRepository } from "../../src/modules/auth/auth.repository";
import {
  LoginHandler,
  LoginCommand,
} from "../../src/modules/auth/application/handlers";
import { IdentityService } from "../../src/modules/users/identity.service";
import { ErrorFilter } from "../../src/shared/error.filter";

describe("invitation-only workspace accounts", () => {
  let app: INestApplication;
  let db: Database;
  let mail: EmailService;
  let admin: Agent;
  let staff: Agent;
  let support: Agent;
  let other: Agent;
  const suffix = randomUUID();
  const password = "Strong original password 38219!";
  const newPassword = "Strong replacement password 91752!";
  let org: string;
  let adminId: string;
  let staffId: string;
  let supportId: string;
  let otherId: string;
  const addresses = {
    admin: `admin-${suffix}@example.test`,
    staff: `staff-${suffix}@example.test`,
    support: `support-${suffix}@example.test`,
    other: `other-${suffix}@example.test`,
    invited: `invited-${suffix}@example.test`,
  };
  let inviteToken: string;
  let invitedId: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    db = app.get(Database);
    mail = app.get(EmailService);
    jest.spyOn(mail, "deliverPending").mockResolvedValue(undefined);
    org = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Identity test',$1) RETURNING id",
        [suffix],
      )
    )[0]!.id;
    const otherOrg = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Other identity test',$1) RETURNING id",
        [`${suffix}-other`],
      )
    )[0]!.id;
    for (const [key, role] of [
      ["admin", "admin"],
      ["staff", "staff"],
      ["support", "superadmin"],
      ["other", "admin"],
    ] as const) {
      const user = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,name,password_hash,must_change_password) VALUES($1,$2,$3,false) RETURNING id",
          [addresses[key], key, await argon2.hash(password)],
        )
      )[0]!;
      await db.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role) VALUES($1,$2,$3,$4,$5)",
        [
          key === "other" ? otherOrg : org,
          user.id,
          role === "staff" ? "editor" : "admin",
          role === "staff" ? "staff" : "pm",
          role,
        ],
      );
      if (key === "admin") adminId = user.id;
      if (key === "staff") staffId = user.id;
      if (key === "support") supportId = user.id;
      if (key === "other") otherId = user.id;
    }
    admin = request.agent(app.getHttpServer());
    staff = request.agent(app.getHttpServer());
    support = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    for (const [agent, email] of [
      [admin, addresses.admin],
      [staff, addresses.staff],
      [support, addresses.support],
      [other, addresses.other],
    ] as const)
      await agent.post("/api/team/login").send({ email, password }).expect(201);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });
  async function latestEmail(email: string, kind: AccountEmail["kind"]) {
    const row = (
      await db.query<{ encrypted_payload: string }>(
        "SELECT encrypted_payload FROM email_outbox WHERE recipient=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1",
        [email, kind],
      )
    )[0]!;
    return decryptEmail(row.encrypted_payload);
  }
  test("roles remain explicit and staff cannot administer users", async () => {
    expect((await admin.get("/api/team/session")).body.user.role).toBe("admin");
    expect((await support.get("/api/team/session")).body.user.isSupport).toBe(
      true,
    );
    await staff.get("/api/team/users").expect(403);
    await staff
      .post("/api/team/users/invite")
      .send({ email: addresses.invited, name: "Invited", role: "admin" })
      .expect(403);
    const list = (await admin.get("/api/team/users").expect(200)).body.users;
    expect(JSON.stringify(list)).not.toContain(addresses.support);
    expect(list.some((x: { id: string }) => x.id === supportId)).toBe(false);
    const supportList = (await support.get("/api/team/users").expect(200)).body
      .users;
    expect(
      supportList.find((x: { id: string }) => x.id === supportId),
    ).toMatchObject({ isSupport: true, role: "superadmin" });
    for (const agent of [admin, staff]) {
      const members = (await agent.get("/api/team/members").expect(200)).body;
      expect(JSON.stringify(members)).not.toContain(addresses.support);
      expect(JSON.stringify(members)).not.toContain("superadmin");
    }
    expect(
      JSON.stringify((await support.get("/api/team/members").expect(200)).body),
    ).not.toContain(addresses.support);
    expect(list.some((x: { id: string }) => x.id === otherId)).toBe(false);
  });
  test("protected support accounts, tenant boundaries and last admin protection", async () => {
    await admin
      .patch(`/api/team/users/${supportId}`)
      .send({ status: "disabled" })
      .expect(404);
    await admin
      .patch(`/api/team/users/${otherId}`)
      .send({ name: "Wrong tenant" })
      .expect(404);
    await admin
      .patch(`/api/team/users/${adminId}`)
      .send({ status: "disabled" })
      .expect(409);
    await admin
      .post("/api/team/users/invite")
      .send({ email: addresses.invited, name: "Invited", role: "superadmin" })
      .expect(400);
  });
  test("missing email configuration is explicit and does not create a phantom invitation", async () => {
    await admin
      .post("/api/team/users/invite")
      .send({ email: addresses.invited, name: "Invited", role: "staff" })
      .expect(503);
    expect(
      await db.query("SELECT id FROM users WHERE email=$1", [
        addresses.invited,
      ]),
    ).toHaveLength(0);
    jest.spyOn(mail, "configured", "get").mockReturnValue(true);
  });
  test("invites are durable, token secrets encrypted, and pending users cannot sign in", async () => {
    const result = await admin
      .post("/api/team/users/invite")
      .send({ email: addresses.invited, name: "Invited person", role: "staff" })
      .expect(201);
    invitedId = result.body.user.id;
    expect(result.body.user.status).toBe("invited");
    const message = await latestEmail(addresses.invited, "invitation");
    inviteToken = new URL(message.url!).searchParams.get("token")!;
    expect(new URL(message.url!).pathname).toBe("/account/invitation");
    const token = (
      await db.query<{ token_hash: string }>(
        "SELECT token_hash FROM account_tokens WHERE user_id=$1 AND consumed_at IS NULL",
        [invitedId],
      )
    )[0]!;
    expect(token.token_hash).not.toBe(inviteToken);
    const stored = (
      await db.query<{ encrypted_payload: string }>(
        "SELECT encrypted_payload FROM email_outbox WHERE recipient=$1",
        [addresses.invited],
      )
    )[0]!;
    expect(stored.encrypted_payload).not.toContain(inviteToken);
    await request(app.getHttpServer())
      .post("/api/team/login")
      .send({ email: addresses.invited, password })
      .expect(401);
    await admin
      .post("/api/team/users/invite")
      .send({ email: addresses.invited, name: "Duplicate", role: "staff" })
      .expect(409);
    await admin
      .patch(`/api/team/users/${invitedId}`)
      .send({ status: "active" })
      .expect(400);
  });
  test("both administrators can invite staff, PMs and other Neptun admins", async () => {
    for (const [label, agent] of [
      ["neptun", admin],
      ["promo", support],
    ] as const) {
      for (const role of ["staff", "pm", "admin"]) {
        const result = await agent
          .post("/api/team/users/invite")
          .send({
            email: `${label}-${role}-${suffix}@example.test`,
            name: `Invited ${role}`,
            role,
          })
          .expect(201);
        expect(result.body.user).toMatchObject({
          role,
          status: "invited",
          emailVerified: false,
          isSupport: false,
        });
      }
    }
  });
  test("support identities stay private in shared documents and editing status without erasing the audit", async () => {
    const id = randomUUID();
    const saved = (
      await support
        .post("/api/team/campaigns")
        .send({ campaign: { id, name: "Privacy QA", products: [] } })
        .expect(201)
    ).body.campaign;
    expect(saved.updatedBy).toBe(addresses.support);
    const comment = (
      await support
        .post(`/api/team/campaigns/${id}/review`)
        .send({
          action: "comment",
          pageIndex: 0,
          text: "Please check the price",
          version: saved.version,
        })
        .expect(201)
    ).body.campaign;
    const publicDoc = (await admin.get(`/api/team/campaigns/${id}`).expect(200))
      .body.campaign;
    expect(JSON.stringify(publicDoc)).not.toContain(addresses.support);
    expect(JSON.stringify(publicDoc)).not.toContain("superadmin");
    expect(publicDoc.reviewComments[0].authorEmail).toBe("Workspace team");
    expect(
      JSON.stringify((await staff.get("/api/team/campaigns").expect(200)).body),
    ).not.toContain(addresses.support);
    await admin
      .post(`/api/team/campaigns/${id}/review`)
      .send({
        action: "reply",
        commentId: comment.reviewComments[0].id,
        text: "Reply",
        mention: addresses.support,
        version: comment.version,
      })
      .expect(409);
    const updated = (
      await admin
        .post("/api/team/campaigns")
        .send({ campaign: { ...publicDoc, name: "Privacy QA edited" } })
        .expect(201)
    ).body;
    expect(JSON.stringify(updated)).not.toContain(addresses.support);
    const privateDoc = (
      await support.get(`/api/team/campaigns/${id}`).expect(200)
    ).body.campaign;
    expect(privateDoc.reviewComments[0].authorEmail).toBe(addresses.support);
    const sessionId = randomUUID();
    await support
      .post(`/api/team/campaigns/${id}/presence`)
      .send({ sessionId, mode: "edit", pageLabel: "Cover" })
      .expect(201);
    const presence = (
      await admin.get(`/api/team/campaigns/${id}/presence`).expect(200)
    ).body;
    expect(presence.participants).toEqual([
      expect.objectContaining({
        name: "Workspace team",
        email: "",
        mode: "edit",
        pageLabel: "Cover",
      }),
    ]);
    expect(JSON.stringify(presence)).not.toContain(addresses.support);
    expect(JSON.stringify(presence)).not.toContain(supportId);
    expect(
      JSON.stringify(
        (await support.get(`/api/team/campaigns/${id}/presence`).expect(200))
          .body,
      ),
    ).toContain(addresses.support);
  });
  test("renaming a pending invite with an unchanged submitted role preserves its link", async () => {
    await admin
      .patch(`/api/team/users/${invitedId}`)
      .send({ name: "Renamed invited colleague", role: "staff" })
      .expect(200);
    const inspected = await request(app.getHttpServer())
      .get(`/api/team/account-token?token=${inviteToken}`)
      .expect(200);
    expect(inspected.body.name).toBe("Renamed invited colleague");
    expect(inspected.body.purpose).toBe("invite");
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM account_tokens WHERE user_id=$1 AND consumed_at IS NULL",
          [invitedId],
        )
      )[0]!.count,
    ).toBe("1");
  });
  test("invitation requires password and code, supports resend and counts incorrect attempts", async () => {
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/team/account-token?token=${inviteToken}`)
          .expect(200)
      ).body,
    ).toMatchObject({
      purpose: "invite",
      email: addresses.invited,
      codeSent: false,
    });
    await request(app.getHttpServer())
      .post("/api/team/request-invitation-code")
      .send({ token: inviteToken })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/team/accept-invitation")
      .send({ token: inviteToken, password: "short" })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/team/accept-invitation")
      .send({ token: inviteToken, password: newPassword })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/team/verify-invitation")
      .send({ token: inviteToken, code: "wrong" })
      .expect(400);
    const wrongCode =
      (await latestEmail(addresses.invited, "verification")).code === "000000"
        ? "999999"
        : "000000";
    await request(app.getHttpServer())
      .post("/api/team/verify-invitation")
      .send({ token: inviteToken, code: wrongCode })
      .expect(400);
    expect(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM account_tokens WHERE user_id=$1 AND consumed_at IS NULL",
          [invitedId],
        )
      )[0]!.attempts,
    ).toBe(1);
    await request(app.getHttpServer())
      .post("/api/team/request-invitation-code")
      .send({ token: inviteToken })
      .expect(201);
    const code = (await latestEmail(addresses.invited, "verification")).code!;
    await request(app.getHttpServer())
      .post("/api/team/verify-invitation")
      .send({ token: inviteToken, code })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/team/verify-invitation")
      .send({ token: inviteToken, code })
      .expect(400);
    const signed = await request(app.getHttpServer())
      .post("/api/team/login")
      .send({ email: addresses.invited, password: newPassword })
      .expect(201);
    expect(signed.body.user.mustChangePassword).toBe(false);
  });
  test("forgot password does not disclose existence, resets require separate email code and invalidate all sessions", async () => {
    const known = await request(app.getHttpServer())
      .post("/api/team/forgot-password")
      .send({ email: addresses.staff })
      .expect(201);
    const missing = await request(app.getHttpServer())
      .post("/api/team/forgot-password")
      .send({ email: `unknown-${suffix}@example.test` })
      .expect(201);
    expect(known.body).toEqual(missing.body);
    const message = await latestEmail(addresses.staff, "password-reset");
    const token = new URL(message.url!).searchParams.get("token")!;
    await request(app.getHttpServer())
      .post("/api/team/reset-password")
      .send({ token, code: "123456", password: newPassword })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/team/request-reset-code")
      .send({ token })
      .expect(201);
    const code = (await latestEmail(addresses.staff, "verification")).code!;
    await request(app.getHttpServer())
      .post("/api/team/reset-password")
      .send({ token, code, password: newPassword })
      .expect(201);
    await staff.get("/api/team/campaigns").expect(401);
    await request(app.getHttpServer())
      .post("/api/team/reset-password")
      .send({ token, code, password: newPassword })
      .expect(400);
    await staff
      .post("/api/team/login")
      .send({ email: addresses.staff, password: newPassword })
      .expect(201);
    expect((await latestEmail(addresses.staff, "password-changed")).kind).toBe(
      "password-changed",
    );
  });
  test("authenticated changes verify the old password and persist an email notice", async () => {
    await staff
      .post("/api/team/change-password")
      .send({ password })
      .expect(400);
    await staff
      .post("/api/team/change-password")
      .send({ currentPassword: "Incorrect old password", password })
      .expect(401);
    await staff
      .post("/api/team/change-password")
      .send({ currentPassword: newPassword, password })
      .expect(201);
    await staff.get("/api/team/campaigns").expect(401);
    await staff
      .post("/api/team/login")
      .send({ email: addresses.staff, password })
      .expect(201);
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) count FROM email_outbox WHERE recipient=$1 AND kind='password-changed'",
          [addresses.staff],
        )
      )[0]!.count,
    ).toBe("2");
  });
  test("admin edits are persisted and deactivation revokes an existing cookie", async () => {
    await admin
      .patch(`/api/team/users/${staffId}`)
      .send({ name: "Renamed staff", role: "pm" })
      .expect(200);
    await staff.get("/api/team/campaigns").expect(401);
    await staff
      .post("/api/team/login")
      .send({ email: addresses.staff, password })
      .expect(201);
    expect((await staff.get("/api/team/session")).body.user.role).toBe("pm");
    expect((await staff.get("/api/team/session")).body.user.permissions).toBe(
      "reviewer",
    );
    await staff.get("/api/team/users").expect(403);
    await staff.get("/api/ai/usage").expect(403);
    await admin
      .patch(`/api/team/users/${staffId}`)
      .send({ status: "disabled" })
      .expect(200);
    await staff.get("/api/team/campaigns").expect(401);
    await staff
      .post("/api/team/login")
      .send({ email: addresses.staff, password })
      .expect(401);
    await admin
      .patch(`/api/team/users/${staffId}`)
      .send({ status: "active" })
      .expect(200);
  });
  test("resending an invitation expires the previous link", async () => {
    const email = `second-${suffix}@example.test`;
    const invited = await admin
      .post("/api/team/users/invite")
      .send({ email, name: "Second", role: "pm" })
      .expect(201);
    const first = new URL(
      (await latestEmail(email, "invitation")).url!,
    ).searchParams.get("token")!;
    await admin
      .post(`/api/team/users/${invited.body.user.id}/resend-invite`)
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/team/account-token?token=${first}`)
      .expect(400);
    const current = new URL(
      (await latestEmail(email, "invitation")).url!,
    ).searchParams.get("token")!;
    await request(app.getHttpServer())
      .get(`/api/team/account-token?token=${current}`)
      .expect(200);
    await db.query(
      "UPDATE account_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [invited.body.user.id],
    );
    await request(app.getHttpServer())
      .get(`/api/team/account-token?token=${current}`)
      .expect(400);
  });
  test("cancelled invitations cannot activate or be force-restored; resending starts a new verified flow", async () => {
    const email = `cancelled-${suffix}@example.test`;
    const invited = await admin
      .post("/api/team/users/invite")
      .send({ email, name: "Cancelled", role: "staff" })
      .expect(201);
    const userId = invited.body.user.id;
    expect(invited.body.user.emailVerified).toBe(false);
    const oldToken = new URL(
      (await latestEmail(email, "invitation")).url!,
    ).searchParams.get("token")!;
    await admin
      .patch(`/api/team/users/${userId}`)
      .send({ status: "disabled" })
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/team/accept-invitation")
      .send({ token: oldToken, password })
      .expect(400);
    await admin
      .patch(`/api/team/users/${userId}`)
      .send({ status: "active" })
      .expect(400);
    const resent = await admin
      .post(`/api/team/users/${userId}/resend-invite`)
      .expect(201);
    expect(resent.body.user.status).toBe("invited");
    const token = new URL(
      (await latestEmail(email, "invitation")).url!,
    ).searchParams.get("token")!;
    await request(app.getHttpServer())
      .post("/api/team/accept-invitation")
      .send({ token, password })
      .expect(201);
    const code = (await latestEmail(email, "verification")).code!;
    const wrong = code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post("/api/team/verify-invitation")
        .send({ token, code: wrong })
        .expect(400);
    await request(app.getHttpServer())
      .post("/api/team/verify-invitation")
      .send({ token, code })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/team/request-invitation-code")
      .send({ token })
      .expect(201);
    const replacement = (await latestEmail(email, "verification")).code!;
    await request(app.getHttpServer())
      .post("/api/team/verify-invitation")
      .send({ token, code: replacement })
      .expect(201);
  });
  test("rate limits survive service instances and cannot be cleared by a process restart", async () => {
    const key = `test-${suffix}`;
    const service = app.get(IdentityService);
    for (let i = 0; i < 3; i++) await service.rateLimit(key, 3, 60);
    const restarted = new IdentityService(db, mail);
    await expect(restarted.rateLimit(key, 3, 60)).rejects.toMatchObject({
      status: 429,
    });
  });
  test("an old-password login cannot issue a new session after a concurrent password reset", async () => {
    const email = `race-${suffix}@example.test`;
    const user = (
      await db.query<{ id: string }>(
        "INSERT INTO users(email,name,password_hash,must_change_password) VALUES($1,'Race fixture',$2,false) RETURNING id",
        [email, await argon2.hash(password)],
      )
    )[0]!;
    await db.query(
      "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role) VALUES($1,$2,'editor','staff','staff')",
      [org, user.id],
    );
    const repository = app.get(AuthRepository);
    const original = repository.credentials.bind(repository);
    const interleaving = jest
      .spyOn(repository, "credentials")
      .mockImplementationOnce(async (address) => {
        const snapshot = await original(address);
        await db.transaction(async (client) => {
          await client.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
            user.id,
            await argon2.hash(newPassword),
          ]);
          await client.query("DELETE FROM sessions WHERE user_id=$1", [
            user.id,
          ]);
        });
        return snapshot;
      });
    try {
      await expect(
        app
          .get(LoginHandler)
          .execute(new LoginCommand(email, password, `qa-race-${suffix}`)),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      interleaving.mockRestore();
    }
    expect(
      await db.query("SELECT token_hash FROM sessions WHERE user_id=$1", [
        user.id,
      ]),
    ).toHaveLength(0);
    await request(app.getHttpServer())
      .post("/api/team/login")
      .send({ email, password: newPassword })
      .expect(201);
  });
  test("a changed pending role expires its old link and allows a new invitation", async () => {
    const email = `role-change-${suffix}@example.test`;
    const invited = await admin
      .post("/api/team/users/invite")
      .send({ email, name: "Pending role change", role: "staff" })
      .expect(201);
    const oldToken = new URL(
      (await latestEmail(email, "invitation")).url!,
    ).searchParams.get("token")!;
    await admin
      .patch(`/api/team/users/${invited.body.user.id}`)
      .send({ role: "pm" })
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/team/account-token?token=${oldToken}`)
      .expect(400);
    await admin
      .post(`/api/team/users/${invited.body.user.id}/resend-invite`)
      .expect(201);
    const message = await latestEmail(email, "invitation");
    expect(message.role).toBe("pm");
    const freshToken = new URL(message.url!).searchParams.get("token")!;
    await request(app.getHttpServer())
      .get(`/api/team/account-token?token=${freshToken}`)
      .expect(200);
  });
});
