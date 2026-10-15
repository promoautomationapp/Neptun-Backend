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
import { notificationAudit } from "../notifications/notification-audit";
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
    if (
      message.kind !== "password-changed" &&
      message.kind !== "workspace-notification"
    ) {
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
      "INSERT INTO email_outbox(recipient,kind,encrypted_payload,notification_id) VALUES($1,$2,$3,$4) ON CONFLICT(notification_id) WHERE notification_id IS NOT NULL DO NOTHING",
      [
        message.to,
        message.kind,
        encryptEmail(message),
        message.kind === "workspace-notification"
          ? message.notification?.id
          : null,
      ],
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
        `WITH exhausted AS (
          UPDATE email_outbox SET status='failed',error='Delivery attempt limit reached.',encrypted_payload=''
          WHERE status='sending' AND attempts>=6 AND next_attempt_at<=now() RETURNING id,notification_id
        ) INSERT INTO activity_audit(organization_id,actor_id,actor_role,action,target_type,target_id,method,route,status_code,duration_ms,request_id,event_key)
          SELECT n.organization_id,n.actor_id,n.actor_role,'notification.email-failed','notification',n.id::text,'POST','/api/notifications',502,0,gen_random_uuid(),'notification-email:'||e.id::text||':failed'
          FROM exhausted e JOIN workspace_notifications n ON n.id=e.notification_id
          ON CONFLICT(organization_id,event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      );
      const rows = await this.db.query<{
        id: string;
        encrypted_payload: string;
        attempts: number;
        notification_id?: string | null;
      }>(
        // Lease one message at a time: later messages cannot lose their lease while
        // waiting behind slow SMTP requests in this process.
        "UPDATE email_outbox SET status='sending',attempts=attempts+1,next_attempt_at=now()+interval '2 minutes' WHERE id IN (SELECT id FROM email_outbox WHERE status IN ('pending','sending') AND next_attempt_at<=now() AND attempts<6 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,encrypted_payload,attempts,notification_id",
      );
      for (const row of rows) {
        let notification:
          | {
              organization_id: string;
              actor_id: string | null;
              actor_role: string;
            }
          | undefined;
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
          if (message.kind === "workspace-notification") {
            [notification] = await this.db.query<{
              organization_id: string;
              actor_id: string | null;
              actor_role: string;
            }>(
              `SELECT n.organization_id,n.actor_id,n.actor_role FROM workspace_notifications n
               JOIN campaigns c ON c.organization_id=n.organization_id AND c.id=n.campaign_id
               JOIN memberships m ON m.organization_id=n.organization_id AND m.user_id=n.recipient_id
               JOIN users u ON u.id=m.user_id
               WHERE n.id=$1 AND c.deleted_at IS NULL AND m.status='active' AND m.account_role<>'superadmin'
               AND u.email_verified_at IS NOT NULL AND u.email=$2`,
              [row.notification_id ?? message.notification?.id, message.to],
            );
            if (!notification) {
              await this.db.query(
                "UPDATE email_outbox SET status='failed',error='Notification recipient or brochure is no longer available.',encrypted_payload='' WHERE id=$1",
                [row.id],
              );
              continue;
            }
          }
          const content = accountEmail(message);
          const providerId = await this.transport.send(
            row.id,
            message,
            content,
          );
          const deliveredNotification = notification;
          if (deliveredNotification) {
            await this.db.transaction(async (client) => {
              await client.query(
                "UPDATE email_outbox SET status='sent',sent_at=now(),provider_id=$2,error=NULL,encrypted_payload='' WHERE id=$1",
                [row.id, providerId],
              );
              await notificationAudit(client, {
                organizationId: deliveredNotification.organization_id,
                actorId: deliveredNotification.actor_id,
                actorRole: deliveredNotification.actor_role,
                action: "notification.email-sent",
                notificationId: row.notification_id ?? message.notification!.id,
                eventKey: `notification-email:${row.id}:sent`,
              });
            });
          } else
            await this.db.query(
              "UPDATE email_outbox SET status='sent',sent_at=now(),provider_id=$2,error=NULL,encrypted_payload='' WHERE id=$1",
              [row.id, providerId],
            );
        } catch (error) {
          const failure = safeEmailFailure(error);
          const terminal = failure.permanent || row.attempts >= 6;
          const failureSql =
            "UPDATE email_outbox SET status=$2,error=$3,encrypted_payload=CASE WHEN $2='failed' THEN '' ELSE encrypted_payload END,next_attempt_at=now()+interval '2 minutes' WHERE id=$1";
          const values = [
            row.id,
            terminal ? "failed" : "pending",
            failure.message,
          ];
          if (notification && terminal) {
            const failedNotification = notification;
            await this.db.transaction(async (client) => {
              await client.query(failureSql, values);
              await notificationAudit(client, {
                organizationId: failedNotification.organization_id,
                actorId: failedNotification.actor_id,
                actorRole: failedNotification.actor_role,
                action: "notification.email-failed",
                notificationId: row.notification_id!,
                eventKey: `notification-email:${row.id}:failed`,
              });
            });
          } else await this.db.query(failureSql, values);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
