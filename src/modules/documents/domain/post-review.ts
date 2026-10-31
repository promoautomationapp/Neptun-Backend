import { ConflictException } from "@nestjs/common";
import type { Actor } from "../../auth/domain/actor";
import { applyReview, type ReviewInput } from "./review";
import { campaignSchema, type Campaign, type Post } from "./document";

/** Social annotations arrive through autosave. Rebuild events with the authenticated
 * actor, immutable prior messages, and the same authorization as brochure reviews. */
export function applyPostReviewChanges(
  prior: Post | undefined,
  submitted: Post,
  actor: Actor,
  members: string[],
) {
  let current = campaignSchema.parse({
    ...submitted,
    updatedBy: prior?.updatedBy ?? actor.email,
    status: prior?.status ?? "in_progress",
    reviewComments: prior?.reviewComments ?? [],
    reviewHistory: prior?.reviewHistory ?? [],
  });
  const events: { document: Campaign; input: ReviewInput }[] = [];
  const incoming = submitted.reviewComments ?? prior?.reviewComments ?? [];
  const ids = new Set<string>();
  for (const thread of incoming) {
    for (const message of [thread, ...thread.replies]) {
      if (ids.has(message.id))
        throw new ConflictException("Review message IDs must be unique.");
      ids.add(message.id);
    }
  }
  const apply = (input: ReviewInput, preserveId?: string) => {
    current = applyReview(
      current,
      actor,
      { ...input, language: submitted.notificationLanguage ?? "sq" },
      members,
    );
    if (preserveId) {
      if (input.action === "comment") {
        const thread = current.reviewComments.at(-1)!;
        const generated = thread.id;
        thread.id = preserveId;
        if (current.reviewHistory.at(-1)?.commentId === generated)
          current.reviewHistory.at(-1)!.commentId = preserveId;
      } else if (input.action === "reply")
        current.reviewComments
          .find((thread) => thread.id === input.commentId)!
          .replies.at(-1)!.id = preserveId;
    }
    events.push({
      document: structuredClone(current),
      input: { ...input, language: submitted.notificationLanguage ?? "sq" },
    });
  };
  for (const old of prior?.reviewComments ?? []) {
    const next = incoming.find((thread) => thread.id === old.id);
    if (
      !next ||
      next.text !== old.text ||
      next.pageIndex !== old.pageIndex ||
      (old.fixed && !next.fixed)
    )
      throw new ConflictException(
        "Existing review comments cannot be rewritten through autosave.",
      );
    for (const reply of old.replies) {
      const nextReply = next.replies.find((value) => value.id === reply.id);
      if (!nextReply || nextReply.text !== reply.text)
        throw new ConflictException(
          "Existing replies cannot be rewritten through autosave.",
        );
    }
  }
  for (const next of incoming) {
    const old = prior?.reviewComments?.find((thread) => thread.id === next.id);
    if (!old)
      apply(
        {
          action: "comment",
          text: next.text,
          pageIndex: 0,
          pageLabel: submitted.name,
          mentions: next.mentions,
          mention: next.mention ?? undefined,
          ...(next.position ? { position: next.position } : {}),
        },
        next.id,
      );
    for (const reply of next.replies) {
      if (!old?.replies.some((value) => value.id === reply.id))
        apply(
          {
            action: "reply",
            commentId: next.id,
            text: reply.text,
            mentions: reply.mentions,
            mention: reply.mention ?? undefined,
          },
          reply.id,
        );
    }
    if (next.fixed && !old?.fixed) apply({ action: "fix", commentId: next.id });
  }
  if (
    submitted.status &&
    submitted.status !== (prior?.status ?? "in_progress") &&
    submitted.status !== current.status
  ) {
    const action =
      submitted.status === "in_review"
        ? "submit"
        : submitted.status === "completed"
          ? "complete"
          : submitted.status === "in_progress" && current.status === "completed"
            ? "reopen"
            : null;
    if (!action)
      throw new ConflictException(
        "This review status change is not permitted.",
      );
    apply({ action });
  }
  const document: Post = { ...submitted };
  if (prior?.reviewComments || submitted.reviewComments || events.length)
    document.reviewComments = current.reviewComments;
  if (prior?.reviewHistory || submitted.reviewHistory || events.length)
    document.reviewHistory = current.reviewHistory;
  if (prior?.status || submitted.status || events.length)
    document.status = current.status;
  return { document, events };
}
