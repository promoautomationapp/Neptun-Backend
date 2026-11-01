import { brochureFixture } from "../fixtures/brochure";
import {
  campaignSchema,
  documentSnapshot,
  postSchema,
} from "../../src/modules/documents/domain/document";

describe("brochure JSON contract", () => {
  test("validates editable footer geometry and preserves optional page number choices", () => {
    const base = { id: "footer", name: "Offers", products: [] };
    const footer = {
      bottom: 19,
      fadeEnd: true,
      showAwards: false,
      height: 4,
      dateWidth: 34,
      dateText: "Vlen 24–31 tetor",
      from: "#f3432b",
      to: "#205785",
    };
    expect(
      campaignSchema.parse({
        ...base,
        brochureFooter: footer,
        showFooterPageNumber: false,
      }),
    ).toMatchObject({ brochureFooter: footer, showFooterPageNumber: false });
    expect(
      campaignSchema.safeParse({ ...base, brochureFooter: { height: 0 } })
        .success,
    ).toBe(false);
    expect(
      campaignSchema.safeParse({
        ...base,
        brochureFooter: { from: "url(unsafe)" },
      }).success,
    ).toBe(false);
  });
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
