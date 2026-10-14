import { brochureFixture } from "../fixtures/brochure";
import {
  campaignSchema,
  documentSnapshot,
  postSchema,
} from "../../src/modules/documents/domain/document";

describe("brochure JSON contract", () => {
  test("the campaign DTO preserves complete page, bundle, footer and typography options", () => {
    const input = brochureFixture("rich-layout", "/assets/fixture.png");
    expect(campaignSchema.parse(input)).toEqual({
      ...input,
      reviewComments: [],
      reviewHistory: [],
    });
  });

  test("the social DTO retains the same movable product artwork and nested TV wallpaper", () => {
    const input = brochureFixture("social-layout", "/assets/fixture.png");
    expect(postSchema.parse(input)).toEqual(input);
  });
});

it("defaults older campaigns to an opt-in band without losing their saved artwork", () => {
  const original = brochureFixture("legacy", "/image.png");
  delete original.showCoverBand;
  const snapshot = documentSnapshot(
    {
      id: "legacy",
      layout: original as never,
      version: 1,
      updated_at: new Date("2026-10-12"),
    },
    "campaign",
  );
  expect(snapshot.showCoverBand).toBe(false);
  expect(snapshot.pageArtworks).toEqual(original.pageArtworks);
  expect(original.showCoverBand).toBeUndefined();
  const parsed = campaignSchema.parse({
    id: "defaults",
    name: "Defaults",
    products: [],
  });
  expect(parsed).toMatchObject({
    showCoverBand: false,
    coverMessageColor: "#ffffff",
    coverHeadlineColor: "#ffffff",
    coverTypeColor: "#ffffff",
    coverFooterColor: "#ffffff",
  });
});
