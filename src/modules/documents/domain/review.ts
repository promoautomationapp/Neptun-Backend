import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "../../auth/domain/actor";
import type { Campaign } from "./document";
export const reviewInput = z.object({
  action: z.enum(["comment", "reply", "fix", "submit", "complete", "reopen"]),
  text: z.string().max(2000).optional(),
  pageIndex: z.number().int().min(0).max(200).optional(),
  pageLabel: z.string().max(80).optional(),
  position: z
    .object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })
    .optional(),
  commentId: z.string().optional(),
  mention: z.string().max(320).optional(),
  mentions: z.array(z.string().max(320)).max(20).optional(),
  version: z.number().int().positive().optional(),
});
export type ReviewInput = z.infer<typeof reviewInput>;
export function reviewMentions(input: ReviewInput): string[] {
  return [
    ...new Set(
      [...(input.mentions ?? []), input.mention ?? ""]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
export function applyReview(
  campaign: Campaign,
  actor: Actor,
  input: ReviewInput,
  members: string[],
): Campaign {
  const status = campaign.status ?? "in_progress";
  const role = actor.reviewRole;
  const administrator =
    actor.accountRole === "admin" || actor.accountRole === "superadmin";
  const action = input.action;
  const next: Campaign = {
    ...campaign,
    reviewComments: campaign.reviewComments.map((x) => ({
      ...x,
      replies: [...x.replies],
    })),
    reviewHistory: [...campaign.reviewHistory],
  };
  const now = new Date().toISOString();
  const mentions = reviewMentions(input);
  const mention = mentions[0] ?? null;
  function deny(message: string): never {
    throw new ConflictException(message);
  }
  if (
    (action === "comment" || action === "reply") &&
    (mentions.length > 20 || mentions.some((email) => !members.includes(email)))
  )
    deny("Choose a team member to mention.");
  if (action === "comment") {
    if (!input.text?.trim() || input.pageIndex === undefined)
      deny("Choose a page and enter a comment under 2000 characters.");
    next.reviewComments.push({
      id: randomUUID(),
      pageIndex: input.pageIndex,
      pageLabel: input.pageLabel ?? "",
      text: input.text.trim(),
      authorEmail: actor.email,
      createdAt: now,
      mention,
      mentions,
      position: input.position ?? null,
      replies: [],
      fixed: false,
      fixedAt: null,
      fixedBy: null,
    });
    if (role === "pm" && status === "in_review")
      next.status = "changes_requested";
  } else if (action === "reply" || action === "fix") {
    const item = next.reviewComments.find((x) => x.id === input.commentId);
    if (!item) deny("Comment not found.");
    if (action === "reply") {
      if (!input.text?.trim()) deny("Enter a reply under 2000 characters.");
      item.replies.push({
        id: randomUUID(),
        text: input.text.trim(),
        authorEmail: actor.email,
        createdAt: now,
        mention,
        mentions,
      });
    } else {
      if (role !== "staff" && !administrator)
        deny("Only staff or administrators can mark comments as fixed.");
      if (item.fixed) deny("This comment is already fixed.");
      item.fixed = true;
      item.fixedAt = now;
      item.fixedBy = actor.email;
    }
  } else {
    const unresolved = next.reviewComments.some((x) => !x.fixed);
    if (action === "submit") {
      if (role !== "staff" && !administrator)
        deny("Only staff or administrators can submit a brochure for review.");
      if (!["in_progress", "changes_requested"].includes(status))
        deny("This brochure cannot be submitted from its current status.");
      if (unresolved)
        deny("Mark every review comment as fixed before submitting again.");
      next.status = "in_review";
    } else if (action === "complete") {
      if (
        administrator &&
        !["in_progress", "changes_requested", "in_review"].includes(status)
      )
        deny("This brochure cannot be completed from its current status.");
      if (!administrator && role === "pm" && status !== "in_review")
        deny("The PM can complete a brochure only while it is in review.");
      if (
        !administrator &&
        role === "staff" &&
        !["in_progress", "changes_requested"].includes(status)
      )
        deny("Staff cannot complete a brochure from its current status.");
      if (unresolved)
        deny("Mark every review comment as fixed before completing.");
      next.status = "completed";
    } else {
      if ((!administrator && role !== "staff") || status !== "completed")
        deny("Only staff or administrators can reopen a completed brochure.");
      next.status = "in_progress";
    }
  }
  const commentId =
    action === "comment"
      ? next.reviewComments.at(-1)?.id
      : action === "fix" || action === "reply"
        ? input.commentId
        : null;
  next.reviewHistory = [
    ...next.reviewHistory,
    {
      id: randomUUID(),
      action,
      actor: actor.email,
      role: actor.accountRole ?? role,
      at: now,
      commentId: commentId ?? null,
    },
  ].slice(-300);
  next.updatedAt = now;
  return next;
}
