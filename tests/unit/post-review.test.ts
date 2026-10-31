import type { Actor } from "../../src/modules/auth/domain/actor";
import { postSchema } from "../../src/modules/documents/domain/document";
import { applyPostReviewChanges } from "../../src/modules/documents/domain/post-review";
const staff: Actor = {
  organizationId: "org",
  userId: "staff",
  email: "staff@test",
  name: "Arta",
  role: "editor",
  reviewRole: "staff",
  accountRole: "staff",
  mustChangePassword: false,
};
const pm: Actor = {
  ...staff,
  userId: "pm",
  email: "pm@test",
  role: "reviewer",
  reviewRole: "pm",
  accountRole: "pm",
};
const incoming = () =>
  postSchema.parse({
    id: "post",
    name: "Social offer",
    products: [],
    notificationLanguage: "sq",
    reviewComments: [
      {
        id: "thread",
        pageIndex: 0,
        text: "Check price",
        authorEmail: "forged@test",
        createdAt: "2000-01-01T00:00:00Z",
        position: { x: 20, y: 30 },
        replies: [],
      },
    ],
    reviewHistory: [
      {
        id: "fake",
        action: "submit",
        actor: "forged@test",
        role: "admin",
        at: "2000-01-01T00:00:00Z",
      },
    ],
  });
test("social autosave stamps actual author and server time and does not replay forged history", () => {
  const result = applyPostReviewChanges(undefined, incoming(), pm, [
    "staff@test",
    "pm@test",
  ]);
  expect(result.document.reviewComments?.[0]).toMatchObject({
    id: "thread",
    authorEmail: "pm@test",
    text: "Check price",
    position: { x: 20, y: 30 },
  });
  expect(result.document.reviewComments?.[0]?.createdAt).not.toBe(
    "2000-01-01T00:00:00Z",
  );
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.input).toMatchObject({
    action: "comment",
    language: "sq",
  });
  expect(result.document.reviewHistory?.[0]).toMatchObject({
    actor: "pm@test",
    action: "comment",
  });
});
test("old optimistic timestamps are normalized without re-sending a comment or permitting a text rewrite", () => {
  const prior = applyPostReviewChanges(undefined, incoming(), pm, [
    "staff@test",
    "pm@test",
  ]).document;
  const old = incoming();
  const result = applyPostReviewChanges(prior, old, staff, [
    "staff@test",
    "pm@test",
  ]);
  expect(result.events).toHaveLength(0);
  expect(result.document.reviewComments).toEqual(prior.reviewComments);
  old.reviewComments![0]!.text = "Rewrite another person";
  expect(() =>
    applyPostReviewChanges(prior, old, staff, ["staff@test", "pm@test"]),
  ).toThrow();
});
test("new replies and resolution produce distinct server-authorized events once", () => {
  const prior = applyPostReviewChanges(undefined, incoming(), pm, [
    "staff@test",
    "pm@test",
  ]).document;
  const next = structuredClone(prior);
  next.reviewComments![0]!.replies.push({
    id: "reply",
    text: "Done",
    authorEmail: "forged@test",
    createdAt: "2000-01-01T00:00:00Z",
  });
  next.reviewComments![0]!.fixed = true;
  const result = applyPostReviewChanges(prior, next, staff, [
    "staff@test",
    "pm@test",
  ]);
  expect(result.events.map((x) => x.input.action)).toEqual(["reply", "fix"]);
  expect(result.document.reviewComments?.[0]?.replies[0]).toMatchObject({
    id: "reply",
    authorEmail: "staff@test",
  });
  expect(result.document.reviewComments?.[0]?.fixedBy).toBe("staff@test");
  expect(
    applyPostReviewChanges(result.document, result.document, staff, [
      "staff@test",
      "pm@test",
    ]).events,
  ).toEqual([]);
  expect(() =>
    applyPostReviewChanges(prior, next, pm, ["staff@test", "pm@test"]),
  ).toThrow();
});
