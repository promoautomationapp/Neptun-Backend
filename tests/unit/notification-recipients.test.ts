import {
  selectNotificationRecipients,
  type NotificationMember,
  type RecipientContext,
} from "../../src/modules/notifications/notification-recipients";
const members: NotificationMember[] = [
  ["pm", "PM", "pm@test", "pm"],
  ["other-pm", "Other PM", "other-pm@test", "pm"],
  ["staff", "Staff", "staff@test", "staff"],
  ["other-staff", "Other Staff", "other-staff@test", "staff"],
  ["admin", "Admin", "admin@test", "admin"],
].map(([id, name, email, role]) => ({
  id:id!,
  name:name!,
  email:email!,
  role: role as NotificationMember["role"],
}));
const context: RecipientContext = {
  actorId: "pm",
  actorRole: "pm",
  action: "comment",
  mentions: [],
  collaboratorEmails: ["staff@test"],
  reviewerEmails: ["pm@test"],
  threadEmails: ["pm@test", "staff@test"],
};
const ids = (input: Partial<RecipientContext>) =>
  selectNotificationRecipients(members, { ...context, ...input }).map(
    (x) => x.member.id,
  );
test("PM comments without mentions go only to staff who worked on the brochure", () => {
  expect(ids({})).toEqual(["staff"]);
  expect(ids({ collaboratorEmails: [] })).toEqual(["staff", "other-staff"]);
});
test("explicit mentions replace fallback recipients and exclude the sender and unknown users", () => {
  expect(
    ids({ mentions: ["other-staff@test", "pm@test", "outside@test"] }),
  ).toEqual(["other-staff"]);
});
test("replies and resolutions notify thread participants only", () => {
  expect(
    ids({ action: "reply", actorId: "staff", actorRole: "staff" }),
  ).toEqual(["pm"]);
  expect(ids({ action: "fix", actorId: "staff", actorRole: "staff" })).toEqual([
    "pm",
  ]);
});
test("submission goes to responsible reviewers and falls back only when none are known", () => {
  expect(
    ids({ action: "submit", actorId: "staff", actorRole: "staff" }),
  ).toEqual(["pm"]);
  expect(
    ids({
      action: "submit",
      actorId: "staff",
      actorRole: "staff",
      reviewerEmails: [],
      collaboratorEmails: [],
    }),
  ).toEqual(["pm", "other-pm"]);
});
test("completion and reopen keep colleagues involved without notifying the whole workspace", () => {
  expect(ids({ action: "complete" })).toEqual(["staff"]);
  expect(
    ids({ action: "reopen", actorId: "staff", actorRole: "staff" }),
  ).toEqual(["pm"]);
});
