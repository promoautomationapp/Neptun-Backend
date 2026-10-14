import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { hasMailControlCharacters, parseSender } from "./mail-address";
import type { AccountEmail } from "./templates";

export interface EmailTransportConfig {
  MAIL_DRIVER: "disabled" | "resend" | "smtp";
  MAIL_FROM: string;
  MAIL_BRAND_NAME: string;
  RESEND_API_KEY: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASS: string;
}
export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

/** Provider responses may contain addresses, tokens and credentials. Store only safe categories. */
export function safeEmailFailure(error: unknown): EmailDeliveryError {
  if (error instanceof EmailDeliveryError) return error;
  if (!error || typeof error !== "object")
    return new EmailDeliveryError(
      "Email delivery failed. Please retry.",
      false,
    );
  const fields = error as Record<string, unknown>;
  const status =
    typeof fields.responseCode === "number" ? fields.responseCode : 0;
  const permanent = status >= 500 && status <= 599;
  if (fields.code === "EAUTH")
    return new EmailDeliveryError(
      "SMTP authentication failed. Check the sender configuration.",
      permanent || !status,
    );
  if (fields.code === "EENVELOPE")
    return new EmailDeliveryError(
      "SMTP rejected the sender or recipient address.",
      permanent,
    );
  if (status >= 400 && status <= 599)
    return new EmailDeliveryError(
      `SMTP server ${permanent ? "rejected" : "temporarily deferred"} the message (${status}).`,
      permanent,
    );
  if (
    fields.code === "ETLS" ||
    fields.code === "ESOCKET" ||
    fields.code === "ECONNECTION"
  )
    return new EmailDeliveryError(
      "SMTP secure connection failed. Check the sender configuration.",
      false,
    );
  if (fields.code === "ETIMEDOUT")
    return new EmailDeliveryError(
      "SMTP connection timed out. Delivery will retry.",
      false,
    );
  return new EmailDeliveryError("Email delivery failed. Please retry.", false);
}

export function smtpTransportOptions(
  config: EmailTransportConfig,
): SMTPTransport.Options {
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: !config.SMTP_SECURE,
    opportunisticTLS: false,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: config.SMTP_HOST,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    dnsTimeout: 10_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function outboxMessageId(id: string, senderAddress: string): string {
  const domain = senderAddress.split("@")[1]!;
  const digest = createHash("sha256")
    .update(`neptun-account:${id}`)
    .digest("hex");
  return `<account.${digest}@${domain}>`;
}

export class AccountEmailTransport {
  private smtp?: Transporter<SMTPTransport.SentMessageInfo>;
  constructor(private readonly config: EmailTransportConfig) {}

  get configured(): boolean {
    const sender = parseSender(
      this.config.MAIL_FROM,
      this.config.MAIL_BRAND_NAME,
    );
    if (!sender) return false;
    if (this.config.MAIL_DRIVER === "resend")
      return Boolean(this.config.RESEND_API_KEY);
    if (this.config.MAIL_DRIVER !== "smtp") return false;
    return Boolean(
      this.config.SMTP_HOST &&
      this.config.SMTP_USER &&
      this.config.SMTP_PASS &&
      this.config.SMTP_USER === this.config.SMTP_USER.trim() &&
      !hasMailControlCharacters(this.config.SMTP_USER) &&
      (this.config.SMTP_PORT !== 465 || this.config.SMTP_SECURE),
    );
  }

  async send(
    id: string,
    message: AccountEmail,
    content: EmailContent,
  ): Promise<string | null> {
    const sender = parseSender(
      this.config.MAIL_FROM,
      this.config.MAIL_BRAND_NAME,
    );
    const recipient = parseSender(message.to);
    if (!sender || !recipient || recipient.address !== message.to)
      throw new EmailDeliveryError(
        "Email sender or recipient configuration is invalid.",
        true,
      );
    if (this.config.MAIL_DRIVER === "resend") {
      const result = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": id,
        },
        body: JSON.stringify({
          from: this.config.MAIL_FROM,
          to: [message.to],
          ...content,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!result.ok)
        throw new EmailDeliveryError(
          `Email provider returned ${result.status}.`,
          result.status >= 400 &&
            result.status < 500 &&
            ![408, 409, 429].includes(result.status),
        );
      const response = (await result.json()) as { id?: unknown };
      return typeof response.id === "string" &&
        /^[\w-]{1,128}$/.test(response.id)
        ? response.id
        : null;
    }
    if (this.config.MAIL_DRIVER !== "smtp" || !this.configured)
      throw new EmailDeliveryError("Email sender is not configured.", true);
    this.smtp ??= nodemailer.createTransport(smtpTransportOptions(this.config));
    const messageId = outboxMessageId(id, sender.address);
    try {
      const result = await this.smtp.sendMail({
        from: sender,
        to: { address: recipient.address, name: "" },
        subject: content.subject,
        text: content.text,
        html: content.html,
        messageId,
        disableFileAccess: true,
        disableUrlAccess: true,
        headers: { "Auto-Submitted": "auto-generated" },
      });
      if (
        !result.accepted.some(
          (address) =>
            address.toLowerCase() === recipient.address.toLowerCase(),
        )
      )
        throw new EmailDeliveryError(
          "SMTP did not accept the recipient address.",
          true,
        );
      // SMTP acceptance does not prove inbox delivery. Stable Message-ID helps tracing retries,
      // but an ambiguous timeout can still lead to duplicate delivery.
      return messageId;
    } catch (error) {
      throw safeEmailFailure(error);
    }
  }

  close(): void {
    this.smtp?.close();
  }
}
