export type NotificationType =
  | "review_submitted"
  | "mention"
  | "review_comment"
  | "review_reply"
  | "review_resolved"
  | "review_completed"
  | "review_reopened";
export interface NotificationMember {
  id: string;
  name: string;
  email: string;
  role: "pm" | "staff" | "admin";
}
export type NotificationReason =
  "mentioned" | "thread" | "contributor" | "reviewer" | "staff";
export interface RecipientContext {
  actorId: string;
  actorRole: string;
  action: "submit" | "comment" | "reply" | "fix" | "complete" | "reopen";
  mentions: string[];
  collaboratorEmails: string[];
  reviewerEmails: string[];
  threadEmails: string[];
}
/** Eligibility is checked by the repository; this chooses only relevant colleagues. */
export function selectNotificationRecipients(
  members: NotificationMember[],
  context: RecipientContext,
) {
  const available = members.filter((member) => member.id !== context.actorId);
  const named = (emails: string[]) => {
    const set = new Set(emails.map((value) => value.toLowerCase()));
    return available.filter((member) => set.has(member.email.toLowerCase()));
  };
  const result = (
    selected: NotificationMember[],
    type: NotificationType,
    reason: NotificationReason,
  ) => selected.map((member) => ({ member, type, reason }));
  if (
    ["comment", "reply", "fix"].includes(context.action) &&
    context.mentions.length
  )
    return result(named(context.mentions), "mention", "mentioned");
  if (context.action === "reply" || context.action === "fix")
    return result(
      named(context.threadEmails),
      context.action === "fix" ? "review_resolved" : "review_reply",
      "thread",
    );
  const role =
    context.action === "submit"
      ? "pm"
      : context.actorRole === "pm"
        ? "staff"
        : "pm";
  const team = available.filter((member) => member.role === role);
  const involved = named(
    role === "pm"
      ? [...context.reviewerEmails, ...context.collaboratorEmails]
      : context.collaboratorEmails,
  ).filter((member) => member.role === role);
  const selected = involved.length ? involved : team;
  const type =
    context.action === "submit"
      ? "review_submitted"
      : context.action === "complete"
        ? "review_completed"
        : context.action === "reopen"
          ? "review_reopened"
          : "review_comment";
  return result(
    selected,
    type,
    involved.length
      ? role === "pm"
        ? "reviewer"
        : "contributor"
      : role === "pm"
        ? "reviewer"
        : "staff",
  );
}
