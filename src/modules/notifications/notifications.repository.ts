import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { Database } from "../../database/database";
import { env } from "../../config/environment";
import type { Actor } from "../auth/domain/actor";
import type { Campaign } from "../documents/domain/document";
import { reviewMentions } from "../documents/domain/review";
import type { ReviewInput } from "../documents/domain/review";
import { EmailService } from "../email/email.service";
import { notificationAudit } from "./notification-audit";

export type NotificationType =
  "review_submitted" | "mention" | "review_comment" | "review_reply";
interface Member {
  id: string;
  name: string;
  email: string;
  role: "pm" | "staff" | "admin";
}
interface NotificationRow {
  id: string;
  type: NotificationType;
  campaign_id: string;
  campaign_name: string;
  page_index: number | null;
  comment_id: string | null;
  actor_name: string;
  actor_email: string | null;
  message: string;
  created_at: Date;
  read_at: Date | null;
}
const visible = `n.organization_id=$1 AND n.recipient_id=$2 AND c.deleted_at IS NULL
  AND m.status='active' AND m.account_role<>'superadmin' AND u.email_verified_at IS NOT NULL`;

@Injectable()
export class NotificationsRepository {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  async list(actor: Actor, unreadOnly = false) {
    // Use a single snapshot so the rows and badge describe the same state.
    const [result] = await this.db.query<{
      notifications: NotificationRow[];
      unread_count: number;
    }>(
      `WITH visible AS (
         SELECT n.* FROM workspace_notifications n
         JOIN campaigns c ON c.organization_id=n.organization_id AND c.id=n.campaign_id
         JOIN memberships m ON m.organization_id=n.organization_id AND m.user_id=n.recipient_id
         JOIN users u ON u.id=m.user_id WHERE ${visible}
       ), latest AS (SELECT * FROM visible WHERE ($3=false OR read_at IS NULL) ORDER BY created_at DESC,id DESC LIMIT 50)
       SELECT coalesce((SELECT json_agg(latest ORDER BY created_at DESC,id DESC) FROM latest),'[]'::json) notifications,
         (SELECT count(*)::int FROM visible WHERE read_at IS NULL) unread_count`,
      [actor.organizationId, actor.userId, unreadOnly],
    );
    return {
      notifications: (result?.notifications ?? []).map((row) => ({
        id: row.id,
        type: row.type,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        pageIndex: row.page_index,
        commentId: row.comment_id,
        actorName: row.actor_name,
        actorEmail: row.actor_email,
        message: row.message,
        createdAt: new Date(row.created_at).toISOString(),
        readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
      })),
      unreadCount: result?.unread_count ?? 0,
    };
  }

  async read(
    actor: Actor,
    id: string | null,
    ip?: string,
  ): Promise<{ read: true }> {
    return this.db.transaction(async (client) => {
      const rows = (
        await client.query<{ id: string; read_at: Date | null }>(
          `SELECT n.id,n.read_at FROM workspace_notifications n
         JOIN campaigns c ON c.organization_id=n.organization_id AND c.id=n.campaign_id
         JOIN memberships m ON m.organization_id=n.organization_id AND m.user_id=n.recipient_id
         JOIN users u ON u.id=m.user_id WHERE ${visible} AND ($3::uuid IS NULL OR n.id=$3) FOR UPDATE OF n`,
          [actor.organizationId, actor.userId, id],
        )
      ).rows;
      if (id && !rows.length)
        throw new NotFoundException("Notification not found.");
      for (const row of rows)
        if (!row.read_at) {
          await client.query(
            "UPDATE workspace_notifications SET read_at=now() WHERE id=$1",
            [row.id],
          );
          await notificationAudit(client, {
            organizationId: actor.organizationId,
            actorId: actor.userId,
            actorRole: actor.accountRole ?? actor.reviewRole,
            action: "notification.read",
            notificationId: row.id,
            eventKey: `notification:${row.id}:read`,
            ip,
          });
        }
      return { read: true };
    });
  }

  async review(
    client: PoolClient,
    actor: Actor,
    campaign: Campaign,
    input: ReviewInput,
  ): Promise<void> {
    if (!["submit", "comment", "reply"].includes(input.action)) return;
    const event = campaign.reviewHistory.at(-1);
    if (!event) return;
    const members = (
      await client.query<Member>(
        `SELECT u.id,u.name,u.email,CASE WHEN m.account_role='staff' AND m.review_role='pm' THEN 'pm' ELSE m.account_role END role
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.status='active'
       AND m.account_role<>'superadmin' AND u.email_verified_at IS NOT NULL`,
        [actor.organizationId],
      )
    ).rows;
    const byEmail = new Map(
      members.map((member) => [member.email.toLowerCase(), member]),
    );
    const recipients = new Map<
      string,
      { member: Member; type: NotificationType; email: boolean }
    >();
    const add = (member: Member, type: NotificationType, email = false) => {
      if (member.id === actor.userId) return;
      const prior = recipients.get(member.id);
      recipients.set(member.id, {
        member,
        type: email ? "mention" : (prior?.type ?? type),
        email: email || prior?.email || false,
      });
    };
    const comment = event.commentId
      ? campaign.reviewComments.find((item) => item.id === event.commentId)
      : undefined;
    const entry = input.action === "reply" ? comment?.replies.at(-1) : comment;
    const actorRole =
      actor.accountRole === "staff" && actor.reviewRole === "pm"
        ? "pm"
        : (actor.accountRole ?? actor.reviewRole);
    if (input.action === "submit")
      members
        .filter((member) => member.role === "pm")
        .forEach((member) => add(member, "review_submitted"));
    else if (
      input.action === "comment" &&
      actorRole === "pm" &&
      !reviewMentions(input).length
    )
      members
        .filter((member) => member.role === "staff")
        .forEach((member) => add(member, "review_comment"));
    else if (input.action === "reply" && actorRole === "staff" && comment) {
      for (const participant of [comment, ...comment.replies]) {
        const member = byEmail.get(participant.authorEmail.toLowerCase());
        if (member?.role === "pm") add(member, "review_reply");
      }
    }
    // Mentions are a comment/reply action; submission payload extras must not send mail.
    for (const mention of input.action === "submit"
      ? []
      : reviewMentions(input)) {
      const mentioned = byEmail.get(mention);
      if (mentioned) add(mentioned, "mention", true);
    }
    const actorName =
      actor.accountRole === "superadmin"
        ? "Workspace team"
        : actor.name?.trim() || actor.email.split("@")[0] || "Team member";
    const actorEmail = actor.accountRole === "superadmin" ? null : actor.email;
    // The shared review visibility already redacts support identities in documents. Never put
    // their email into notification prose, including user-entered quoted reply text.
    const supportEmails = (
      await client.query<{ email: string }>(
        "SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.account_role='superadmin'",
        [actor.organizationId],
      )
    ).rows.map((row) => row.email);
    const redact = (text: string) =>
      supportEmails.reduce(
        (value, email) =>
          value.replaceAll(
            new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
            "Workspace team",
          ),
        text,
      );
    const message =
      input.action === "submit"
        ? "A brochure is ready for your review."
        : redact(entry?.text ?? "");
    for (const { member, type, email } of recipients.values()) {
      const [notification] = (
        await client.query<{ id: string }>(
          `INSERT INTO workspace_notifications(organization_id,recipient_id,event_id,type,campaign_id,campaign_name,page_index,comment_id,actor_id,actor_role,actor_name,actor_email,message)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(organization_id,event_id,recipient_id) DO NOTHING RETURNING id`,
          [
            actor.organizationId,
            member.id,
            event.id,
            type,
            campaign.id,
            redact(campaign.name),
            comment?.pageIndex ?? null,
            comment?.id ?? null,
            actor.userId,
            actor.accountRole ?? actor.reviewRole,
            actorName,
            actorEmail,
            message,
          ],
        )
      ).rows;
      if (!notification) continue;
      await notificationAudit(client, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        actorRole: actor.accountRole ?? actor.reviewRole,
        action: "notification.created",
        notificationId: notification.id,
        eventKey: `notification:${notification.id}:created`,
      });
      if (email) {
        const url = new URL(env.PUBLIC_APP_URL);
        url.searchParams.set("campaign", campaign.id);
        if (comment) {
          url.searchParams.set("page", String(comment.pageIndex));
          url.searchParams.set("comment", comment.id);
        }
        await this.email.enqueue(client, {
          to: member.email,
          name: member.name,
          kind: "workspace-notification",
          url: url.href,
          notification: {
            id: notification.id,
            campaignName: redact(campaign.name),
            actorName,
            message,
            pageIndex: comment?.pageIndex ?? null,
          },
        });
      }
    }
  }
}
