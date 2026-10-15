import { Inject, Injectable } from "@nestjs/common";
import { Database } from "../../database/database";
import type { Actor } from "../auth/domain/actor";
import type { Campaign, Post } from "./domain/document";

/** Hide operator identities in shared document responses, keeping the audit data intact. */
@Injectable()
export class DocumentVisibility {
  constructor(@Inject(Database) private readonly db: Database) {}

  async forActor<T extends Campaign | Post | (Campaign | Post)[]>(
    actor: Actor,
    value: T,
  ): Promise<T> {
    if (actor.accountRole === "superadmin") return value;
    const rows = await this.db.query<{ email: string }>(
      "SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.account_role='superadmin'",
      [actor.organizationId],
    );
    const hidden = new Set(rows.map((row) => row.email.toLowerCase()));
    const isHidden = (identity: unknown) =>
      typeof identity === "string" && hidden.has(identity.toLowerCase());
    const identity = (identity: unknown) =>
      isHidden(identity) ? "Workspace team" : identity;
    const document = (item: Campaign | Post) => ({
      ...item,
      updatedBy: identity(item.updatedBy),
      ...(Array.isArray(item.reviewComments)
        ? {
            reviewComments: (item as Campaign).reviewComments.map(
              (comment) => ({
                ...comment,
                authorEmail: identity(comment.authorEmail),
                fixedBy: identity(comment.fixedBy),
                mention: isHidden(comment.mention) ? null : comment.mention,
                replies: comment.replies.map((reply) => ({
                  ...reply,
                  authorEmail: identity(reply.authorEmail),
                  mention: isHidden(reply.mention) ? null : reply.mention,
                })),
              }),
            ),
          }
        : {}),
      ...(Array.isArray(item.reviewHistory)
        ? {
            reviewHistory: (item as Campaign).reviewHistory.map((event) => ({
              ...event,
              actor: identity(event.actor),
              role: event.role === "superadmin" ? "admin" : event.role,
            })),
          }
        : {}),
    });
    return (Array.isArray(value) ? value.map(document) : document(value)) as T;
  }
}
