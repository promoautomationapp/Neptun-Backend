import {
  EmailService,
  encryptEmail,
} from "../../src/modules/email/email.service";
import type { Database } from "../../src/database/database";
import type { AccountEmail } from "../../src/modules/email/templates";
import { env } from "../../src/config/environment";
const previousConfig = {
  MAIL_DRIVER: env.MAIL_DRIVER,
  MAIL_FROM: env.MAIL_FROM,
  RESEND_API_KEY: env.RESEND_API_KEY,
};
beforeEach(() => {
  env.MAIL_DRIVER = "resend";
  env.MAIL_FROM = "sender@example.test";
  env.RESEND_API_KEY = "test-api-key";
});
function fixture(
  message: AccountEmail,
  attempts = 1,
  activeNotification = false,
) {
  const query = jest.fn(async (sql: string) =>
    sql.includes("SELECT n.organization_id") && activeNotification
      ? [
          {
            organization_id: "org-id",
            actor_id: "actor-id",
            actor_role: "staff",
          },
        ]
      : sql.includes("RETURNING id,encrypted_payload,attempts")
        ? [
            {
              id: "outbox-id",
              encrypted_payload: encryptEmail(message),
              attempts,
              notification_id: message.notification?.id ?? null,
            },
          ]
        : [],
  );
  const transaction = jest.fn(
    async (operation: (client: unknown) => Promise<unknown>) =>
      operation({ query }),
  );
  const service = new EmailService({
    query,
    transaction,
  } as unknown as Database);
  jest.spyOn(service, "configured", "get").mockReturnValue(true);
  return { service, query, transaction };
}
afterEach(() => {
  jest.restoreAllMocks();
  Object.assign(env, previousConfig);
});
test("delivery uses provider idempotency and erases secret payloads after acknowledgement", async () => {
  const { service, query } = fixture({
    to: "test@example.test",
    name: "Test",
    kind: "verification",
    code: "127531",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const send = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-id" }), { status: 200 }),
    );
  await service.deliverPending();
  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0]![1]!;
  expect(request.headers).toMatchObject({ "Idempotency-Key": "outbox-id" });
  expect(JSON.parse(request.body as string)).toMatchObject({
    to: ["test@example.test"],
  });
  expect(
    query.mock.calls.some(
      ([sql]) =>
        sql.includes("status='sent'") && sql.includes("encrypted_payload=''"),
    ),
  ).toBe(true);
});
test("expired codes are discarded without contacting the provider", async () => {
  const { service, query } = fixture({
    to: "test@example.test",
    name: "Test",
    kind: "verification",
    code: "127531",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const send = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  await service.deliverPending();
  expect(send).not.toHaveBeenCalled();
  expect(
    query.mock.calls.some(([sql]) =>
      sql.includes("Verification code expired before delivery."),
    ),
  ).toBe(true);
});
test.each([
  [1, "pending"],
  [6, "failed"],
])(
  "provider failures after attempt %i retain safe retry status %s",
  async (attempts, status) => {
    const { service, query } = fixture(
      { to: "test@example.test", name: "Test", kind: "password-changed" },
      attempts,
    );
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("private provider details", { status: 429 }),
      );
    await service.deliverPending();
    const updates = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(
      updates.find(([sql]) => sql.includes("SET status=$2,error=$3"))?.[1],
    ).toEqual(["outbox-id", status, "Email provider returned 429."]);
  },
);
test("permanent provider failures stop retries and never save response secrets", async () => {
  const { service, query } = fixture({
    to: "test@example.test",
    name: "Test",
    kind: "password-changed",
  });
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("secret provider body", { status: 401 }));
  await service.deliverPending();
  const updates = query.mock.calls as unknown as Array<[string, unknown[]]>;
  expect(
    updates.find(([sql]) => sql.includes("SET status=$2,error=$3"))?.[1],
  ).toEqual(["outbox-id", "failed", "Email provider returned 401."]);
});
test("network errors are sanitized before saving retry status", async () => {
  const { service, query } = fixture({
    to: "test@example.test",
    name: "Test",
    kind: "password-changed",
  });
  jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("secret credential in diagnostic"));
  await service.deliverPending();
  const updates = query.mock.calls as unknown as Array<[string, unknown[]]>;
  expect(
    updates.find(([sql]) => sql.includes("SET status=$2,error=$3"))?.[1],
  ).toEqual(["outbox-id", "pending", "Email delivery failed. Please retry."]);
});

const workspaceMessage: AccountEmail = {
  to: "staff@example.test",
  name: "Staff",
  kind: "workspace-notification",
  url: "https://workspace.test/?campaign=brochure&page=1&comment=thread",
  notification: {
    id: "notification-id",
    campaignName: "October brochure",
    actorName: "Arta",
    message: "Please check",
    pageIndex: 1,
  },
};
test("queued mention delivery rechecks access and suppresses unavailable recipients without contacting the provider", async () => {
  const { service, query } = fixture(workspaceMessage);
  const send = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  await service.deliverPending();
  expect(send).not.toHaveBeenCalled();
  expect(
    query.mock.calls.some(
      ([sql]) =>
        sql.includes("m.status='active'") &&
        sql.includes("m.account_role<>'superadmin'") &&
        sql.includes("c.deleted_at IS NULL"),
    ),
  ).toBe(true);
  expect(
    query.mock.calls.some(([sql]) =>
      sql.includes(
        "Notification recipient or brochure is no longer available.",
      ),
    ),
  ).toBe(true);
});
test("mention delivery records one durable delivery event together with its outbox acknowledgement", async () => {
  const { service, query, transaction } = fixture(workspaceMessage, 1, true);
  const send = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-id" }), { status: 200 }),
    );
  await service.deliverPending();
  expect(send).toHaveBeenCalledTimes(1);
  expect(transaction).toHaveBeenCalledTimes(1);
  const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
  const audit = calls.find(([, values]) =>
    values?.includes("notification.email-sent"),
  );
  expect(audit?.[1]).toEqual(
    expect.arrayContaining([
      "notification.email-sent",
      "notification-email:outbox-id:sent",
    ]),
  );
  expect(audit?.[0]).toContain("ON CONFLICT(organization_id,event_key)");
});
test("exhausted mention delivery records a safe failure event and stops retries", async () => {
  const { service, query } = fixture(workspaceMessage, 6, true);
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("private credentials", { status: 429 }));
  await service.deliverPending();
  const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
  expect(
    calls.find(([, values]) =>
      values?.includes("notification.email-failed"),
    )?.[1],
  ).toEqual(expect.arrayContaining(["notification.email-failed"]));
  expect(
    calls.find(([sql]) => sql.includes("SET status=$2,error=$3"))?.[1],
  ).toEqual(["outbox-id", "failed", "Email provider returned 429."]);
});
