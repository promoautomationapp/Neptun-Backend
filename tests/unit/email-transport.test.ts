import nodemailer from "nodemailer";
import {
  AccountEmailTransport,
  outboxMessageId,
  safeEmailFailure,
  smtpTransportOptions,
} from "../../src/modules/email/email-transport";
import type { EmailTransportConfig } from "../../src/modules/email/email-transport";
import { parseSender } from "../../src/modules/email/mail-address";

function config(
  overrides: Partial<EmailTransportConfig> = {},
): EmailTransportConfig {
  return {
    MAIL_DRIVER: "smtp",
    MAIL_FROM: "Neptun Team <sender@example.test>",
    MAIL_BRAND_NAME: "Neptun Team",
    RESEND_API_KEY: "",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: "account@example.test",
    SMTP_PASS: "test-only-password",
    ...overrides,
  };
}
const message = {
  to: "recipient@example.test",
  name: "Recipient",
  kind: "password-changed" as const,
};
const content = {
  subject: "Account notice",
  html: "<p>Hello</p>",
  text: "Hello",
};
afterEach(() => jest.restoreAllMocks());

test("SMTP requires an explicit sender, host and authenticated login", () => {
  expect(new AccountEmailTransport(config()).configured).toBe(true);
  for (const override of [
    { MAIL_FROM: "" },
    { SMTP_HOST: "" },
    { SMTP_USER: "" },
    { SMTP_USER: " " },
    { SMTP_PASS: "" },
    { SMTP_USER: "name\r\nBcc: other@example.test" },
    { SMTP_PORT: 465, SMTP_SECURE: false },
  ])
    expect(new AccountEmailTransport(config(override)).configured).toBe(false);
  expect(
    new AccountEmailTransport(config({ MAIL_DRIVER: "disabled" })).configured,
  ).toBe(false);
});
test("secure SMTP options verify certificates and require STARTTLS on 587", () => {
  expect(smtpTransportOptions(config())).toMatchObject({
    port: 587,
    secure: false,
    requireTLS: true,
    opportunisticTLS: false,
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: "smtp.example.test",
    },
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  expect(
    smtpTransportOptions(config({ SMTP_PORT: 465, SMTP_SECURE: true })),
  ).toMatchObject({
    port: 465,
    secure: true,
    requireTLS: false,
  });
});
test.each([
  "name@example.test\r\nBcc: attack@example.test",
  "one@example.test,two@example.test",
  "not-an-email",
  "Name <one@example.test> <two@example.test>",
])("sender rejects header injection and multiple mailboxes: %s", (sender) => {
  expect(parseSender(sender)).toBeNull();
});
test("sender parses formatted and bare addresses into structured values", () => {
  expect(
    parseSender('"Neptun Team" <sender@example.test>', "Fallback"),
  ).toEqual({ name: "Neptun Team", address: "sender@example.test" });
  expect(parseSender("sender@example.test", "Neptun Team")).toEqual({
    name: "Neptun Team",
    address: "sender@example.test",
  });
});
test("SMTP sends one transactional MIME message with a stable retry Message-ID", async () => {
  const sendMail = jest.fn().mockResolvedValue({
    accepted: [message.to],
    rejected: [],
    response: "250 secret provider text",
  });
  const close = jest.fn();
  const factory = jest
    .spyOn(nodemailer, "createTransport")
    .mockReturnValue({ sendMail, close } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >);
  const transport = new AccountEmailTransport(config());
  const first = await transport.send("outbox-id", message, content);
  const retry = await transport.send("outbox-id", message, content);
  expect(first).toBe(retry);
  expect(first).toMatch(/^<account\.[a-f0-9]{64}@example\.test>$/);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(sendMail.mock.calls[0]![0]).toEqual({
    from: { name: "Neptun Team", address: "sender@example.test" },
    to: { name: "", address: message.to },
    ...content,
    messageId: first,
    disableFileAccess: true,
    disableUrlAccess: true,
    headers: { "Auto-Submitted": "auto-generated" },
  });
  expect(first).not.toContain("secret");
  expect(outboxMessageId("different-outbox", "sender@example.test")).not.toBe(
    first,
  );
  transport.close();
  expect(close).toHaveBeenCalledTimes(1);
});
test.each([
  [
    {
      code: "EAUTH",
      responseCode: 535,
      message: "credentials",
      response: "secret",
    },
    true,
    "SMTP authentication failed.",
  ],
  [{ code: "EAUTH", responseCode: 454 }, false, "SMTP authentication failed."],
  [
    { code: "EENVELOPE", responseCode: 550, response: "private mailbox" },
    true,
    "SMTP rejected the sender or recipient",
  ],
  [{ responseCode: 451 }, false, "temporarily deferred"],
  [{ responseCode: 554 }, true, "rejected the message"],
  [{ code: "ETIMEDOUT", message: "secret" }, false, "timed out"],
])(
  "SMTP safely classifies retryability without raw server diagnostics",
  (error, permanent, description) => {
    const safe = safeEmailFailure(error);
    expect(safe.permanent).toBe(permanent);
    expect(safe.message).toContain(description);
    expect(safe.message).not.toMatch(/secret|credentials|private mailbox/);
  },
);
test("SMTP never marks an unaccepted recipient as sent", async () => {
  const sendMail = jest
    .fn()
    .mockResolvedValue({ accepted: [], rejected: [message.to] });
  jest
    .spyOn(nodemailer, "createTransport")
    .mockReturnValue({ sendMail } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >);
  await expect(
    new AccountEmailTransport(config()).send("id", message, content),
  ).rejects.toMatchObject({
    permanent: true,
    message: "SMTP did not accept the recipient address.",
  });
});
test("SMTP send failures retain only safe retry diagnostics", async () => {
  const sendMail = jest.fn().mockRejectedValue({
    code: "EENVELOPE",
    responseCode: 550,
    message: "recipient secret",
  });
  jest
    .spyOn(nodemailer, "createTransport")
    .mockReturnValue({ sendMail } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >);
  await expect(
    new AccountEmailTransport(config()).send("id", message, content),
  ).rejects.toMatchObject({
    permanent: true,
    message: "SMTP rejected the sender or recipient address.",
  });
});
test("invalid SMTP recipient is rejected before creating a connection", async () => {
  const factory = jest.spyOn(nodemailer, "createTransport");
  await expect(
    new AccountEmailTransport(config()).send(
      "id",
      { ...message, to: "one@example.test,other@example.test" },
      content,
    ),
  ).rejects.toMatchObject({ permanent: true });
  expect(factory).not.toHaveBeenCalled();
});
