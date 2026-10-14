import { applyReview } from "../../src/modules/documents/domain/review";
import { campaignSchema } from "../../src/modules/documents/domain/document";
import type { Actor } from "../../src/modules/auth/domain/actor";
const admin: Actor = {
  userId: "admin",
  organizationId: "test",
  email: "admin@example.test",
  role: "admin",
  reviewRole: "pm",
  accountRole: "admin",
  mustChangePassword: false,
};
test("admins can resolve, submit, approve and reopen while preserving status and comment checks", () => {
  let campaign = campaignSchema.parse({
    id: "review",
    name: "Review",
    products: [],
  });
  campaign = applyReview(
    campaign,
    admin,
    { action: "comment", pageIndex: 0, text: "Fix the price" },
    [],
  );
  const commentId = campaign.reviewComments[0]!.id;
  expect(() => applyReview(campaign, admin, { action: "submit" }, [])).toThrow(
    "Mark every review comment",
  );
  campaign = applyReview(campaign, admin, { action: "fix", commentId }, []);
  campaign = applyReview(campaign, admin, { action: "submit" }, []);
  expect(campaign.status).toBe("in_review");
  campaign = applyReview(campaign, admin, { action: "complete" }, []);
  campaign = applyReview(campaign, admin, { action: "reopen" }, []);
  expect(campaign.status).toBe("in_progress");
  expect(campaign.reviewHistory.at(-1)?.role).toBe("admin");
  expect(() =>
    applyReview(campaign, admin, { action: "reopen" }, []),
  ).toThrow();
});
test("PMs still cannot use staff-only resolution or submission", () => {
  const pm = { ...admin, accountRole: "pm" as const };
  let campaign = campaignSchema.parse({
    id: "review",
    name: "Review",
    products: [],
  });
  campaign = applyReview(
    campaign,
    pm,
    { action: "comment", pageIndex: 0, text: "Fix the price" },
    [],
  );
  expect(() =>
    applyReview(
      campaign,
      pm,
      { action: "fix", commentId: campaign.reviewComments[0]!.id },
      [],
    ),
  ).toThrow();
  expect(() => applyReview(campaign, pm, { action: "submit" }, [])).toThrow();
});
