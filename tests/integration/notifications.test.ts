import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Agent } from "supertest";
import argon2 from "argon2";
import { AppModule } from "../../src/app.module";
import { Database } from "../../src/database/database";
import { ErrorFilter } from "../../src/shared/error.filter";
import {
  EmailService,
  decryptEmail,
  encryptEmail,
} from "../../src/modules/email/email.service";
import { AccountEmailTransport } from "../../src/modules/email/email-transport";
import { NotificationsRepository } from "../../src/modules/notifications/notifications.repository";
import type { Actor } from "../../src/modules/auth/domain/actor";
import type { Campaign } from "../../src/modules/documents/domain/document";

describe("review notifications", () => {
  let app: INestApplication, db: Database, organizationId: string;
  const suffix = randomUUID(),
    password = "Isolated notification password 8392!";
  const agents: Record<string, Agent> = {},
    ids: Record<string, string> = {},
    emails: Record<string, string> = {};
  beforeAll(async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    db = app.get(Database);
    organizationId = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Notification test',$1) RETURNING id",
        [suffix],
      )
    )[0]!.id;
    const otherOrg = (
      await db.query<{ id: string }>(
        "INSERT INTO organizations(name,slug) VALUES('Notification outside',$1) RETURNING id",
        [`${suffix}-other`],
      )
    )[0]!.id;
    const hash = await argon2.hash(password);
    for (const key of [
      "admin",
      "staff",
      "staff2",
      "pm",
      "pm2",
      "legacyPm",
      "support",
      "disabled",
      "invited",
      "unverified",
      "outside",
    ]) {
      const role =
        key === "support"
          ? "superadmin"
          : key.startsWith("pm")
            ? "pm"
            : key === "admin"
              ? "admin"
              : "staff";
      emails[key] = `${key.toLowerCase()}-${suffix}@example.test`;
      ids[key] = (
        await db.query<{ id: string }>(
          "INSERT INTO users(email,name,password_hash,must_change_password) VALUES($1,$2,$3,false) RETURNING id",
          [emails[key], `Name ${key}`, hash],
        )
      )[0]!.id;
      await db.query(
        "INSERT INTO memberships(organization_id,user_id,role,review_role,account_role,status) VALUES($1,$2,$3,$4,$5,$6)",
        [
          key === "outside" ? otherOrg : organizationId,
          ids[key],
          role === "staff" ? "editor" : role === "pm" ? "reviewer" : "admin",
          role === "pm" || key === "legacyPm" ? "pm" : "staff",
          role,
          key === "disabled"
            ? "disabled"
            : key === "invited"
              ? "invited"
              : "active",
        ],
      );
      if (key === "unverified")
        await db.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
          ids[key],
        ]);
      if (!["disabled", "invited", "unverified"].includes(key)) {
        agents[key] = request.agent(app.getHttpServer());
        await agents[key]!.post("/api/team/login")
          .send({ email: emails[key], password })
          .expect(201);
      }
    }
  });
  afterAll(() => app.close());
  async function campaign(name = "Notification brochure"): Promise<Campaign> {
    return (
      await agents
        .admin!.post("/api/team/campaigns")
        .send({ campaign: { id: randomUUID(), name, products: [] } })
        .expect(201)
    ).body.campaign;
  }
  async function notifications(key: string, filter = "all") {
    return (
      await agents[key]!.get("/api/notifications").query({ filter }).expect(200)
    ).body as {
      notifications: Array<{
        id: string;
        campaignId: string;
        type: string;
        actorName: string;
        actorEmail: string | null;
        message: string;
        readAt: string | null;
      }>;
      unreadCount: number;
    };
  }
  async function forCampaign(key: string, id: string) {
    return (await notifications(key)).notifications.filter(
      (item) => item.campaignId === id,
    );
  }

  test("submission reaches all active PMs, including legacy PM roles, but no support or other tenant", async () => {
    const item = await campaign();
    await agents
      .staff!.post(`/api/team/campaigns/${item.id}/review`)
      .send({
        action: "submit",
        version: item.version,
        mentions: [emails.admin],
      })
      .expect(201);
    for (const key of ["pm", "pm2", "legacyPm"])
      expect(await forCampaign(key, item.id)).toEqual([
        expect.objectContaining({ type: "review_submitted" }),
      ]);
    for (const key of ["admin", "staff", "staff2", "support", "outside"])
      expect(await forCampaign(key, item.id)).toHaveLength(0);
    expect(
      await db.query(
        "SELECT id FROM email_outbox WHERE notification_id IN(SELECT id FROM workspace_notifications WHERE campaign_id=$1)",
        [item.id],
      ),
    ).toHaveLength(3);
  });

  test("PM comments notify staff; staff replies notify PM participants and multi-mentions email once each", async () => {
    const item = await campaign();
    let saved = (
      await agents
        .pm!.post(`/api/team/campaigns/${item.id}/review`)
        .send({
          action: "comment",
          pageIndex: 2,
          text: "Please correct these prices",
          version: item.version,
        })
        .expect(201)
    ).body.campaign as Campaign;
    const thread = saved.reviewComments[0]!;
    for (const key of ["staff", "staff2"])
      expect(await forCampaign(key, item.id)).toEqual([
        expect.objectContaining({ type: "review_comment" }),
      ]);
    expect(await forCampaign("admin", item.id)).toHaveLength(0);
    saved = (
      await agents
        .pm2!.post(`/api/team/campaigns/${item.id}/review`)
        .send({
          action: "reply",
          commentId: thread.id,
          text: "I agree",
          version: saved.version,
        })
        .expect(201)
    ).body.campaign;
    saved = (
      await agents
        .staff!.post(`/api/team/campaigns/${item.id}/review`)
        .send({
          action: "reply",
          commentId: thread.id,
          text: "Fixed. Please check!",
          mentions: [emails.pm!.toUpperCase(), emails.pm!, emails.admin!],
          mention: emails.pm,
          version: saved.version,
        })
        .expect(201)
    ).body.campaign;
    expect(saved.reviewComments[0]!.replies.at(-1)).toMatchObject({
      mentions: [emails.pm, emails.admin],
      mention: emails.pm,
    });
    expect(await forCampaign("pm", item.id)).toEqual([
      expect.objectContaining({ type: "mention" }),
      expect.objectContaining({ type: "review_reply" }),
    ]);
    // Explicit mentions target the reply; a colleague is not notified merely by sharing the PM role.
    expect(await forCampaign("pm2", item.id)).toEqual([]);
    expect(await forCampaign("admin", item.id)).toEqual([
      expect.objectContaining({ type: "mention" }),
    ]);
    const queued = await db.query<{
      recipient: string;
      encrypted_payload: string;
    }>(
      "SELECT recipient,encrypted_payload FROM email_outbox WHERE notification_id IN(SELECT id FROM workspace_notifications WHERE campaign_id=$1) ORDER BY recipient",
      [item.id],
    );
    expect(queued.map((row) => row.recipient).sort()).toEqual(
      [emails.staff, emails.staff2, emails.pm, emails.pm, emails.admin].sort(),
    );
    for (const row of queued) {
      expect(row.encrypted_payload).not.toContain("Fixed");
      expect(decryptEmail(row.encrypted_payload)).toMatchObject({
        kind: "workspace-notification",
        notification: {
          pageIndex: 2,
          action: expect.stringMatching(/comment|reply/),
          reason: expect.stringMatching(/staff|thread|mentioned/),
        },
      });
    }
    const actor: Actor = {
      userId: ids.staff!,
      organizationId,
      email: emails.staff!,
      name: "Name staff",
      accountRole: "staff",
      role: "editor",
      reviewRole: "staff",
      mustChangePassword: false,
    };
    await db.transaction((client) =>
      app.get(NotificationsRepository).review(client, actor, saved, {
        action: "reply",
        commentId: thread.id,
        mentions: [emails.pm!, emails.admin!],
      }),
    );
    expect(
      await db.query(
        "SELECT id FROM email_outbox WHERE notification_id IN(SELECT id FROM workspace_notifications WHERE campaign_id=$1)",
        [item.id],
      ),
    ).toHaveLength(5);
  });

  test("all mention targets are validated, support is unmentionable even by support, invalid events roll back", async () => {
    const item = await campaign();
    for (const invalid of [
      "support",
      "disabled",
      "invited",
      "unverified",
      "outside",
    ]) {
      for (const actor of ["staff", "support"]) {
        await agents[actor]!.post(`/api/team/campaigns/${item.id}/review`)
          .send({
            action: "comment",
            pageIndex: 0,
            text: "No notification",
            mentions: [emails.admin, emails[invalid]],
            version: item.version,
          })
          .expect(409);
      }
    }
    expect(
      await db.query(
        "SELECT id FROM workspace_notifications WHERE campaign_id=$1",
        [item.id],
      ),
    ).toHaveLength(0);
    const saved = (
      await agents
        .staff!.post(`/api/team/campaigns/${item.id}/review`)
        .send({
          action: "comment",
          pageIndex: 0,
          text: "One mention",
          mention: emails.admin,
          version: item.version,
        })
        .expect(201)
    ).body.campaign;
    await agents
      .staff!.post(`/api/team/campaigns/${item.id}/review`)
      .send({
        action: "comment",
        pageIndex: 0,
        text: "Conflict",
        mentions: [emails.admin],
        version: item.version,
      })
      .expect(409);
    expect(
      await db.query(
        "SELECT id FROM workspace_notifications WHERE campaign_id=$1",
        [item.id],
      ),
    ).toHaveLength(1);
    expect(saved.reviewComments).toHaveLength(1);
    for (const actor of ["admin", "staff", "support"]) {
      const members = (
        await agents[actor]!.get("/api/team/members").expect(200)
      ).body.members;
      expect(members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: ids.pm,
            name: "Name pm",
            email: emails.pm,
            role: "pm",
            username: emails.pm!.split("@")[0],
          }),
        ]),
      );
      for (const key of [
        "support",
        "disabled",
        "invited",
        "unverified",
        "outside",
      ])
        expect(JSON.stringify(members)).not.toContain(emails[key]);
    }
  });

  test("read acknowledgements are private/idempotent, and disabled campaigns disappear from counts", async () => {
    const item = await campaign();
    await agents
      .staff!.post(`/api/team/campaigns/${item.id}/review`)
      .send({
        action: "comment",
        pageIndex: 0,
        text: "Read this",
        mention: emails.admin,
      })
      .expect(201);
    const notice = (await forCampaign("admin", item.id))[0]!;
    await agents
      .staff!.post(`/api/notifications/${notice.id}/read`)
      .send({})
      .expect(404);
    await agents
      .outside!.post(`/api/notifications/${notice.id}/read`)
      .send({})
      .expect(404);
    for (let i = 0; i < 2; i++)
      await agents
        .admin!.post(`/api/notifications/${notice.id}/read`)
        .send({})
        .expect(201);
    expect((await forCampaign("admin", item.id))[0]!.readAt).toBeTruthy();
    expect(
      await db.query(
        "SELECT id FROM activity_audit WHERE action='notification.read' AND target_id=$1",
        [notice.id],
      ),
    ).toHaveLength(1);
    await agents
      .staff!.post(`/api/team/campaigns/${item.id}/review`)
      .send({
        action: "comment",
        pageIndex: 0,
        text: "Another",
        mention: emails.admin,
      })
      .expect(201);
    expect(
      await db.query(
        "SELECT e.id FROM email_outbox e JOIN workspace_notifications n ON n.id=e.notification_id WHERE n.campaign_id=$1 AND e.status='pending'",
        [item.id],
      ),
    ).toHaveLength(2);
    const before = (await notifications("admin")).unreadCount;
    await agents.admin!.delete(`/api/team/campaigns/${item.id}`).expect(200);
    expect(await forCampaign("admin", item.id)).toHaveLength(0);
    expect((await notifications("admin")).unreadCount).toBe(before - 1);
    await agents
      .admin!.post(`/api/notifications/${notice.id}/read`)
      .send({})
      .expect(404);
    await agents
      .admin!.post("/api/notifications/read-all")
      .send({})
      .expect(201);
    expect((await notifications("admin")).unreadCount).toBe(0);
    expect((await notifications("admin", "unread")).notifications).toHaveLength(
      0,
    );
  });

  test("support activity never creates customer notifications or emails, including legacy inbox rows", async () => {
    const item = await campaign(`Title ${emails.support}`);
    await agents
      .support!.post(`/api/team/campaigns/${item.id}/review`)
      .send({
        action: "comment",
        pageIndex: 0,
        text: `Check this from ${emails.support}`,
        mentions: [emails.admin, emails.staff],
      })
      .expect(201);
    const legacyId = randomUUID();
    await db.query(
      `INSERT INTO workspace_notifications(id,organization_id,recipient_id,event_id,type,campaign_id,campaign_name,actor_id,actor_role,actor_name,actor_email,message)
      VALUES($1,$2,$3,$4,'mention',$5,'Legacy',$6,'superadmin','Workspace team',NULL,'Legacy support work')`,
      [legacyId, organizationId, ids.admin, randomUUID(), item.id, ids.support],
    );
    for (const key of ["admin", "staff"])
      expect(await forCampaign(key, item.id)).toEqual([]);
    await agents.admin!.post(`/api/notifications/${legacyId}/read`).expect(404);
    const queued = await db.query(
      "SELECT id FROM email_outbox WHERE notification_id IN(SELECT id FROM workspace_notifications WHERE campaign_id=$1)",
      [item.id],
    );
    expect(queued).toEqual([]);
  });

  test("legacy quoted private identities are redacted from inbox and queued review email at delivery", async () => {
    const item = await campaign();
    const notificationId = randomUUID();
    const text = `Quoted [${emails.support}] [${ids.support}], active new${emails.support}`;
    const presentedText = `Quoted [Workspace team] [Workspace team], active new${emails.support}`;
    await db.query(
      `INSERT INTO workspace_notifications(id,organization_id,recipient_id,event_id,type,campaign_id,campaign_name,actor_id,actor_role,actor_name,actor_email,message)
      VALUES($1,$2,$3,$4,'mention',$5,$6,$7,'staff','Name staff',$8,$6)`,
      [
        notificationId,
        organizationId,
        ids.admin,
        randomUUID(),
        item.id,
        text,
        ids.staff,
        emails.staff,
      ],
    );
    const [notice] = await forCampaign("admin", item.id);
    expect(notice!.message).toBe(presentedText);
    expect(JSON.stringify(notice)).not.toContain(ids.support);
    await db.query(
      "INSERT INTO email_outbox(recipient,kind,encrypted_payload,notification_id,created_at) VALUES($1,'workspace-notification',$2,$3,'2000-01-01')",
      [
        emails.admin,
        encryptEmail({
          to: emails.admin!,
          name: "Name admin",
          kind: "workspace-notification",
          notification: {
            id: notificationId,
            campaignName: text,
            actorName: "Name staff",
            message: text,
            pageIndex: 0,
            pageLabel: text,
            action: "comment",
            reason: "mentioned",
            language: "en",
          },
        }),
        notificationId,
      ],
    );
    const service = app.get(EmailService);
    const send = jest
      .spyOn(AccountEmailTransport.prototype, "send")
      .mockResolvedValue("isolated-mock-provider");
    const configured = jest
      .spyOn(service, "configured", "get")
      .mockReturnValue(true);
    try {
      await service.deliverPending();
      const delivered = send.mock.calls.find(
        ([, message]) => message.notification?.id === notificationId,
      );
      expect(delivered).toBeDefined();
      expect(delivered![1].notification!.message).toBe(presentedText);
      expect(JSON.stringify(delivered)).not.toContain(ids.support);
      expect(delivered![1].notification!.message).toContain("Workspace team");
    } finally {
      configured.mockRestore();
      send.mockRestore();
    }
  });

  test("notification enqueue failure rolls back the review and its ledger event", async () => {
    const item = await campaign();
    const enqueue = jest
      .spyOn(app.get(EmailService), "enqueue")
      .mockRejectedValueOnce(new Error("Isolated outbox failure"));
    try {
      await agents
        .staff!.post(`/api/team/campaigns/${item.id}/review`)
        .send({
          action: "comment",
          pageIndex: 0,
          text: "Atomic review",
          mentions: [emails.admin],
        })
        .expect(500);
    } finally {
      enqueue.mockRestore();
    }
    const saved = (
      await agents.staff!.get(`/api/team/campaigns/${item.id}`).expect(200)
    ).body.campaign;
    expect(saved.version).toBe(item.version);
    expect(saved.reviewComments).toHaveLength(0);
    expect(
      await db.query(
        "SELECT id FROM workspace_notifications WHERE campaign_id=$1",
        [item.id],
      ),
    ).toHaveLength(0);
    expect(
      await db.query(
        "SELECT version FROM document_versions WHERE document_id=$1",
        [item.id],
      ),
    ).toHaveLength(1);
  });

  test("exhausted email delivery is audited once as a failure", async () => {
    const item = await campaign();
    await agents
      .staff!.post(`/api/team/campaigns/${item.id}/review`)
      .send({
        action: "comment",
        pageIndex: 0,
        text: "Delivery audit",
        mention: emails.admin,
      })
      .expect(201);
    const [outbox] = await db.query<{ id: string; notification_id: string }>(
      "SELECT e.id,e.notification_id FROM email_outbox e JOIN workspace_notifications n ON n.id=e.notification_id WHERE n.campaign_id=$1",
      [item.id],
    );
    await db.query(
      "UPDATE email_outbox SET status='sending',attempts=6,next_attempt_at=now()-interval '1 minute' WHERE id=$1",
      [outbox!.id],
    );
    const service = app.get(EmailService);
    // Even unrelated pending test fixtures use a mocked transport; no test email leaves this process.
    const send = jest
      .spyOn(AccountEmailTransport.prototype, "send")
      .mockResolvedValue("isolated-mocked-provider");
    const configured = jest
      .spyOn(service, "configured", "get")
      .mockReturnValue(true);
    try {
      await service.deliverPending();
      await service.deliverPending();
    } finally {
      configured.mockRestore();
      send.mockRestore();
    }
    const rows = await db.query<{ status: string; encrypted_payload: string }>(
      "SELECT status,encrypted_payload FROM email_outbox WHERE id=$1",
      [outbox!.id],
    );
    expect(rows).toEqual([{ status: "failed", encrypted_payload: "" }]);
    const ledger = (
      await agents
        .admin!.get("/api/activity")
        .query({ action: "notification.email-failed" })
        .expect(200)
    ).body.records;
    expect(
      ledger.filter(
        (row: { targetId: string }) => row.targetId === outbox!.notification_id,
      ),
    ).toEqual([
      expect.objectContaining({ outcome: "failure", statusCode: 502 }),
    ]);
  });

  test("unread filtering returns older unread items beyond the latest fifty", async () => {
    const item = await campaign();
    // Fixture history represents previously delivered events without 55 costly review requests.
    await db.query(
      `INSERT INTO workspace_notifications(organization_id,recipient_id,event_id,type,campaign_id,campaign_name,actor_id,actor_role,actor_name,actor_email,message,created_at,read_at)
      SELECT $1,$2,gen_random_uuid(),'mention',$3,'Older unread test',$4,'staff','Staff',$5,'History',now() - (n*interval '1 minute'),CASE WHEN n<55 THEN now() ELSE NULL END FROM generate_series(1,55) n`,
      [organizationId, ids.staff2, item.id, ids.staff, emails.staff],
    );
    expect((await notifications("staff2")).notifications).toHaveLength(50);
    expect(
      (await notifications("staff2")).notifications.some(
        (row) => row.campaignId === item.id && row.readAt === null,
      ),
    ).toBe(false);
    const unread = (
      await notifications("staff2", "unread")
    ).notifications.filter((row) => row.campaignId === item.id);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.readAt).toBeNull();
  });
  test("a PM comment follows the brochure's staff contributor and resolved/submitted/completed events queue branded context once", async () => {
    let value = (
      await agents
        .staff!.post("/api/team/campaigns")
        .send({
          campaign: {
            id: randomUUID(),
            name: "Responsible staff",
            products: [],
          },
        })
        .expect(201)
    ).body.campaign as Campaign;
    value = (
      await agents
        .pm!.post(`/api/team/campaigns/${value.id}/review`)
        .send({
          action: "comment",
          pageIndex: 0,
          pageLabel: "Cover",
          text: "Check this offer",
          language: "sq",
          version: value.version,
        })
        .expect(201)
    ).body.campaign;
    expect(await forCampaign("staff", value.id)).toHaveLength(1);
    expect(await forCampaign("staff2", value.id)).toHaveLength(0);
    const thread = value.reviewComments[0]!;
    value = (
      await agents
        .staff!.post(`/api/team/campaigns/${value.id}/review`)
        .send({
          action: "fix",
          commentId: thread.id,
          language: "sq",
          version: value.version,
        })
        .expect(201)
    ).body.campaign;
    value = (
      await agents
        .staff!.post(`/api/team/campaigns/${value.id}/review`)
        .send({ action: "submit", language: "sq", version: value.version })
        .expect(201)
    ).body.campaign;
    value = (
      await agents
        .pm!.post(`/api/team/campaigns/${value.id}/review`)
        .send({ action: "complete", language: "sq", version: value.version })
        .expect(201)
    ).body.campaign;
    expect((await forCampaign("pm", value.id)).map((x) => x.type)).toEqual([
      "review_submitted",
      "review_resolved",
    ]);
    expect(await forCampaign("pm2", value.id)).toEqual([]);
    expect((await forCampaign("staff", value.id)).map((x) => x.type)).toEqual([
      "review_completed",
      "review_comment",
    ]);
    const rows = await db.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM email_outbox WHERE notification_id IN(SELECT id FROM workspace_notifications WHERE campaign_id=$1)",
      [value.id],
    );
    expect(rows).toHaveLength(4);
    const messages = rows.map((row) => decryptEmail(row.encrypted_payload));
    expect(
      messages.every((message) => message.notification?.language === "sq"),
    ).toBe(true);
    expect(
      messages.find((message) => message.notification?.action === "comment"),
    ).toMatchObject({
      notification: {
        actorName: "Name pm",
        reason: "contributor",
        pageLabel: "Cover",
      },
      url: expect.stringContaining(`comment=${thread.id}`),
    });
  });
  test("social annotations produce post links, keep the authenticated actor and avoid duplicate mail on a later save", async () => {
    let post = (
      await agents
        .staff!.post("/api/team/posts")
        .send({
          post: { id: randomUUID(), name: "Social review", products: [] },
        })
        .expect(201)
    ).body.post;
    const thread = {
      id: randomUUID(),
      text: "Review social price",
      authorEmail: "forged@example.test",
      createdAt: "2000-01-01T00:00:00Z",
      pageIndex: 0,
      replies: [],
      fixed: false,
    };
    post = (
      await agents
        .pm!.post("/api/team/posts")
        .send({
          post: {
            ...post,
            notificationLanguage: "sq",
            reviewComments: [thread],
          },
        })
        .expect(201)
    ).body.post;
    expect(post.reviewComments[0].authorEmail).toBe(emails.pm);
    const rows = await db.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM email_outbox WHERE notification_id IN(SELECT id FROM workspace_notifications WHERE post_id=$1)",
      [post.id],
    );
    expect(rows).toHaveLength(1);
    expect(decryptEmail(rows[0]!.encrypted_payload)).toMatchObject({
      to: emails.staff,
      url: expect.stringContaining(`post=${post.id}`),
      notification: {
        documentKind: "post",
        reason: "contributor",
        action: "comment",
      },
    });
    expect((await forCampaign("staff", post.id))[0]).toMatchObject({
      documentKind: "post",
      commentId: thread.id,
    });
    await agents.pm!.post("/api/team/posts").send({ post }).expect(201);
    expect(
      await db.query(
        "SELECT id FROM workspace_notifications WHERE post_id=$1",
        [post.id],
      ),
    ).toHaveLength(1);
  });
});
