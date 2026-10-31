import { Inject, Injectable } from "@nestjs/common";
import { Database } from "../../database/database";
import type { Actor } from "../auth/domain/actor";
import type { Campaign, Post } from "./domain/document";
import {
  privateIdentityQuery,
  privateIdentityLabel,
  redactPrivateText,
  redactPrivateValues,
  type PrivateIdentity,
} from "./private-identity";

/** Hide operator identities in shared document responses, keeping the audit data intact. */
@Injectable()
export class DocumentVisibility {
  constructor(@Inject(Database) private readonly db: Database) {}

  async forActor<T extends Campaign | Post | (Campaign | Post)[]>(
    actor: Actor,
    value: T,
  ): Promise<T> {
    if (actor.accountRole === "superadmin") return value;
    const rows = await this.db.query<PrivateIdentity>(privateIdentityQuery, [
      actor.organizationId,
    ]);
    const hidden = new Map(
      rows.flatMap((row) =>
        [row.id, row.email, row.name]
          .filter(Boolean)
          .map(
            (value) =>
              [value.toLowerCase(), privateIdentityLabel(row)] as const,
          ),
      ),
    );
    const isHidden = (value: unknown) =>
      typeof value === "string" && hidden.has(value.toLowerCase());
    const privateText = (text: string) => redactPrivateText(text, rows);
    const identity = <V>(value: V): V =>
      (typeof value === "string"
        ? privateText(hidden.get(value.toLowerCase()) ?? value)
        : value) as V;
    const document = (item: Campaign | Post) => ({
      ...item,
      updatedBy:
        typeof item.updatedBy === "string"
          ? privateText(identity(item.updatedBy))
          : item.updatedBy,
      ...(Array.isArray(item.reviewComments)
        ? {
            reviewComments: (item as Campaign).reviewComments.map(
              (comment) => ({
                ...redactPrivateValues(comment, rows),
                text: privateText(comment.text),
                authorEmail: identity(comment.authorEmail),
                fixedBy: identity(comment.fixedBy),
                mention: isHidden(comment.mention) ? null : comment.mention,
                ...(comment.mentions
                  ? {
                      mentions: comment.mentions.filter(
                        (email) => !isHidden(email),
                      ),
                    }
                  : {}),
                replies: comment.replies.map((reply) => ({
                  ...redactPrivateValues(reply, rows),
                  text: privateText(reply.text),
                  authorEmail: identity(reply.authorEmail),
                  mention: isHidden(reply.mention) ? null : reply.mention,
                  ...(reply.mentions
                    ? {
                        mentions: reply.mentions.filter(
                          (email) => !isHidden(email),
                        ),
                      }
                    : {}),
                })),
              }),
            ),
          }
        : {}),
      ...(Array.isArray(item.reviewHistory)
        ? {
            reviewHistory: (item as Campaign).reviewHistory
              .filter(
                (event) =>
                  event.role !== "superadmin" &&
                  !isHidden(event.actor) &&
                  privateText(event.actor) === event.actor,
              )
              .map((event) => redactPrivateValues(event, rows)),
          }
        : {}),
    });
    // Preserve customer work while omitting hidden actor history; persisted audit remains intact.
    return (Array.isArray(value)
      ? value.map(document)
      : document(value)) as unknown as T;
  }
}
