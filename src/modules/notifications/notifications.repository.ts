import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { Database } from "../../database/database";
import { env } from "../../config/environment";
import type { Actor } from "../auth/domain/actor";
import type { Campaign, DocumentKind } from "../documents/domain/document";
import { resolvedWorkspaceAccess } from "../auth/domain/workspace-access";
import { reviewMentions } from "../documents/domain/review";
import type { ReviewInput } from "../documents/domain/review";
import { EmailService } from "../email/email.service";
import { notificationAudit } from "./notification-audit";
import {
  privateIdentityQuery,
  redactPrivateText,
  type PrivateIdentity,
} from "../documents/private-identity";
import {
  notificationJoins,
  notificationEligibility,
} from "./notification-visibility";
import {
  selectNotificationRecipients,
  type NotificationMember,
  type NotificationType,
} from "./notification-recipients";

export type { NotificationType } from "./notification-recipients";
interface NotificationRow {
  id: string;
  type: NotificationType;
  campaign_id: string | null;
  post_id: string | null;
  campaign_name: string;
  page_index: number | null;
  comment_id: string | null;
  actor_name: string;
  actor_email: string | null;
  message: string;
  created_at: Date;
  read_at: Date | null;
}
const visible = `n.organization_id=$1 AND n.recipient_id=$2 AND ${notificationEligibility}`;

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
         ${notificationJoins} WHERE ${visible}
       ), latest AS (SELECT * FROM visible WHERE ($3=false OR read_at IS NULL) ORDER BY created_at DESC,id DESC LIMIT 50)
       SELECT coalesce((SELECT json_agg(latest ORDER BY created_at DESC,id DESC) FROM latest),'[]'::json) notifications,
         (SELECT count(*)::int FROM visible WHERE read_at IS NULL) unread_count`,
      [actor.organizationId, actor.userId, unreadOnly],
    );
    const identities = await this.db.query<PrivateIdentity>(
      privateIdentityQuery,
      [actor.organizationId],
    );
    const redact = (text: string) => redactPrivateText(text, identities);
    return {
      notifications: (result?.notifications ?? []).map((row) => ({
        id: row.id,
        type: row.type,
        campaignId: row.campaign_id ?? row.post_id,
        documentKind: row.post_id ? "post" : "campaign",
        campaignName: redact(row.campaign_name),
        pageIndex: row.page_index,
        commentId: row.comment_id,
        actorName: redact(row.actor_name),
        actorEmail: row.actor_email ? redact(row.actor_email) : null,
        message: redact(row.message),
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
         ${notificationJoins} WHERE ${visible} AND ($3::uuid IS NULL OR n.id=$3) FOR UPDATE OF n`,
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
    kind: DocumentKind = "campaign",
  ): Promise<void> {
    // Operator work may remain in the shared artwork, but never announces support activity.
    if (actor.accountRole === "superadmin") return;
    const event = campaign.reviewHistory.at(-1);
    if (!event) return;
    const members = (
      await client.query<
        NotificationMember & {
          account_role: "staff" | "pm" | "admin";
          workspace_access: unknown;
        }
      >(
        `SELECT u.id,u.name,u.email,m.account_role,m.workspace_access,CASE WHEN m.account_role='staff' AND m.review_role='pm' THEN 'pm' ELSE m.account_role END role
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.status='active'
       AND m.account_role<>'superadmin' AND u.email_verified_at IS NOT NULL`,
        [actor.organizationId],
      )
    ).rows.filter(
      (member) =>
        kind !== "post" ||
        resolvedWorkspaceAccess(member.account_role, member.workspace_access)
          .canViewSocialPosts,
    );
    const comment = event.commentId
      ? campaign.reviewComments.find((item) => item.id === event.commentId)
      : undefined;
    const entry = input.action === "reply" ? comment?.replies.at(-1) : comment;
    const actorRole =
      actor.accountRole === "staff" && actor.reviewRole === "pm"
        ? "pm"
        : (actor.accountRole ?? actor.reviewRole);
    const versions = (
      await client.query<{ email: string | null }>(
        "SELECT snapshot->>'updatedBy' email FROM document_versions WHERE organization_id=$1 AND kind=$2 AND document_id=$3 ORDER BY version DESC LIMIT 30",
        [actor.organizationId, kind, campaign.id],
      )
    ).rows;
    const collaborators = [
      String(campaign.updatedBy || ""),
      ...versions.map((row) => row.email || ""),
      ...campaign.reviewHistory.map((row) => row.actor),
    ];
    const reviewers = campaign.reviewComments.flatMap((thread) => [
      thread.authorEmail,
      ...thread.replies.map((reply) => reply.authorEmail),
    ]);
    const threadEmails = comment
      ? [
          comment.authorEmail,
          ...(comment.mentions || []),
          ...comment.replies.flatMap((reply) => [
            reply.authorEmail,
            ...(reply.mentions || []),
          ]),
        ]
      : [];
    const recipients = selectNotificationRecipients(members, {
      actorId: actor.userId,
      actorRole,
      action: input.action,
      mentions: reviewMentions(input),
      collaboratorEmails: collaborators,
      reviewerEmails: reviewers,
      threadEmails,
    });
    const actorName =
      actor.name?.trim() || actor.email.split("@")[0] || "Team member";
    const actorEmail = actor.email;
    const identities = (
      await client.query<PrivateIdentity>(privateIdentityQuery, [
        actor.organizationId,
      ])
    ).rows;
    const redact = (text: string) => redactPrivateText(text, identities);
    const workflowMessages = {
      submit:
        input.language === "en"
          ? "Ready for your review."
          : "Gati për shqyrtimin tuaj.",
      fix:
        input.language === "en"
          ? "The comment was marked as resolved."
          : "Komenti u shënua si i zgjidhur.",
      complete:
        input.language === "en"
          ? "The work was marked as completed."
          : "Puna u shënua si e përfunduar.",
      reopen:
        input.language === "en"
          ? "The work was reopened for editing."
          : "Puna u rihap për redaktim.",
    };
    const message = redact(
      input.action === "comment" || input.action === "reply"
        ? (entry?.text ?? "")
        : workflowMessages[input.action],
    );
    for (const { member, type, reason } of recipients) {
      const [notification] = (
        await client.query<{ id: string }>(
          `INSERT INTO workspace_notifications(organization_id,recipient_id,event_id,type,campaign_id,campaign_name,page_index,comment_id,actor_id,actor_role,actor_name,actor_email,message,post_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT(organization_id,event_id,recipient_id) DO NOTHING RETURNING id`,
          [
            actor.organizationId,
            member.id,
            event.id,
            type,
            kind === "campaign" ? campaign.id : null,
            redact(campaign.name),
            comment?.pageIndex ?? null,
            comment?.id ?? null,
            actor.userId,
            actor.accountRole ?? actor.reviewRole,
            actorName,
            actorEmail,
            message,
            kind === "post" ? campaign.id : null,
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
      {
        const url = new URL(env.PUBLIC_APP_URL);
        url.searchParams.set(
          kind === "post" ? "post" : "campaign",
          campaign.id,
        );
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
            action: input.action,
            reason,
            pageLabel: comment?.pageLabel || input.pageLabel,
            occurredAt: event.at,
            documentKind: kind,
            language: input.language ?? "sq",
          },
        });
      }
    }
  }
}
