import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { PoolClient } from "pg";
import { Database } from "../../database/database";
import { env } from "../../config/environment";
import { accountEmail } from "./templates";
import type { AccountEmail } from "./templates";
import { AccountEmailTransport, safeEmailFailure } from "./email-transport";
const encryptionKey = () =>
  createHash("sha256").update(`account-email:${env.SESSION_SECRET}`).digest();
export function encryptEmail(value: AccountEmail): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((x) => x.toString("base64url"))
    .join(".");
}
export function decryptEmail(value: string): AccountEmail {
  const [iv, tag, data] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  if (!iv || !tag || !data) throw new Error("Invalid encrypted email.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(data), decipher.final()]).toString(),
  ) as AccountEmail;
}
@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastMaintenance = 0;
  private readonly transport = new AccountEmailTransport(env);
  constructor(@Inject(Database) private readonly db: Database) {}
  get configured(): boolean {
    return this.transport.configured;
  }
  requireConfigured(): void {
    if (!this.configured)
      throw new ServiceUnavailableException(
        "Invitation email is not configured. Ask your administrator to connect the workspace email sender.",
      );
  }
  async enqueue(client: PoolClient, message: AccountEmail): Promise<void> {
    if (message.kind !== "password-changed") {
      await client.query(
        "UPDATE email_outbox SET status='failed',error='Replaced by a newer account email.',encrypted_payload='' WHERE recipient=$1 AND kind=$2 AND status='pending'",
        [message.to, message.kind],
      );
      message = {
        ...message,
        expiresAt:
          message.expiresAt ??
          new Date(
            Date.now() +
              (message.kind === "verification"
                ? 600_000
                : message.kind === "invitation"
                  ? 172_800_000
                  : 1_800_000),
          ).toISOString(),
      };
    }
    await client.query(
      "INSERT INTO email_outbox(recipient,kind,encrypted_payload) VALUES($1,$2,$3)",
      [message.to, message.kind, encryptEmail(message)],
    );
  }
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.deliverPending().catch(() => undefined);
    }, 2000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.transport.close();
  }
  async deliverPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.lastMaintenance > 3_600_000) {
        await this.db.query(
          "DELETE FROM identity_rate_limits WHERE expires_at<now()",
        );
        await this.db.query(
          "UPDATE account_tokens SET consumed_at=now(),pending_password_hash=NULL,code_hash=NULL WHERE consumed_at IS NULL AND expires_at<=now()",
        );
        this.lastMaintenance = Date.now();
      }
      if (!this.configured) return;
      await this.db.query(
        "UPDATE email_outbox SET status='failed',error='Delivery attempt limit reached.',encrypted_payload='' WHERE status='sending' AND attempts>=6 AND next_attempt_at<=now()",
      );
      const rows = await this.db.query<{
        id: string;
        encrypted_payload: string;
        attempts: number;
      }>(
        // Lease one message at a time: later messages cannot lose their lease while
        // waiting behind slow SMTP requests in this process.
        "UPDATE email_outbox SET status='sending',attempts=attempts+1,next_attempt_at=now()+interval '2 minutes' WHERE id IN (SELECT id FROM email_outbox WHERE status IN ('pending','sending') AND next_attempt_at<=now() AND attempts<6 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,encrypted_payload,attempts",
      );
      for (const row of rows) {
        try {
          const message = decryptEmail(row.encrypted_payload);
          if (
            message.expiresAt &&
            Date.parse(message.expiresAt) <= Date.now()
          ) {
            await this.db.query(
              "UPDATE email_outbox SET status='failed',error='Verification code expired before delivery.',encrypted_payload='' WHERE id=$1",
              [row.id],
            );
            continue;
          }
          const content = accountEmail(message);
          const providerId = await this.transport.send(
            row.id,
            message,
            content,
          );
          await this.db.query(
            "UPDATE email_outbox SET status='sent',sent_at=now(),provider_id=$2,error=NULL,encrypted_payload='' WHERE id=$1",
            [row.id, providerId],
          );
        } catch (error) {
          const failure = safeEmailFailure(error);
          await this.db.query(
            "UPDATE email_outbox SET status=$2,error=$3,encrypted_payload=CASE WHEN $2='failed' THEN '' ELSE encrypted_payload END,next_attempt_at=now()+interval '2 minutes' WHERE id=$1",
            [
              row.id,
              failure.permanent || row.attempts >= 6 ? "failed" : "pending",
              failure.message,
            ],
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
