import {
  resolveSettings,
  workspaceSettingsSchema,
} from "../../src/modules/settings/domain/settings.schema";
import { campaignSchema } from "../../src/modules/documents/domain/document";

describe("reusable brochure designs and page decoration contract", () => {
  test("retains independent ribbon colors in campaigns and reusable defaults, rejecting unsafe colors", () => {
    const coverRibbonColors = { from: "#123456", to: "#abcdef" };
    const campaign = campaignSchema.parse({
      id: "ribbon",
      name: "Offer",
      products: [],
      coverRibbonColors,
    });
    expect(campaign.coverRibbonColors).toEqual(coverRibbonColors);
    const settings = workspaceSettingsSchema.parse({
      brochure: { coverRibbonColors },
      brochurePresets: [
        { id: "custom-ribbon", name: "Ribbon", design: { coverRibbonColors } },
      ],
    });
    expect(settings.brochure.coverRibbonColors).toEqual(coverRibbonColors);
    expect(settings.brochurePresets[0]!.design.coverRibbonColors).toEqual(
      coverRibbonColors,
    );
    for (const from of ["red", "url(javascript:bad)", "#123456;display:none"]) {
      expect(
        campaignSchema.safeParse({
          ...campaign,
          coverRibbonColors: { ...coverRibbonColors, from },
        }).success,
      ).toBe(false);
      expect(
        workspaceSettingsSchema.safeParse({
          brochure: { coverRibbonColors: { ...coverRibbonColors, from } },
        }).success,
      ).toBe(false);
    }
  });
  test("keeps original defaults, supports edited built-ins and independent custom designs", () => {
    const settings = resolveSettings({
      defaultBrochurePresetId: "custom-team",
      brochurePresets: [
        {
          id: "neptun-october",
          name: "Edited Blue",
          design: {
            brochureVisualStyle: "october",
            offerStyle: "card",
            coverLogoSource: "/brochure-presets/october/neptun-cover.png",
            pageDecorationDefaults: {
              showFooterLine: false,
              footerLineColor: "#003870",
            },
          },
        },
        {
          id: "custom-team",
          name: "Team",
          design: { offerStyle: "current", productBackgroundColor: "#ffffff" },
        },
      ],
    });
    expect(settings.brochurePresets).toHaveLength(2);
    expect(settings.defaultBrochurePresetId).toBe("custom-team");
    expect(resolveSettings(null).defaultBrochurePresetId).toBe(
      "neptun-current",
    );
  });
  test("rejects content in a design, unavailable defaults, invalid colors and duplicate ids", () => {
    expect(
      workspaceSettingsSchema.safeParse({
        brochurePresets: [
          { id: "custom-a", name: "Bad", design: { products: [] } },
        ],
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({ defaultBrochurePresetId: "missing" })
        .success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        brochurePresets: [
          { id: "a", name: "A", design: {} },
          { id: "a", name: "B", design: {} },
        ],
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        brochurePresets: [
          {
            id: "a",
            name: "A",
            design: {
              pageDecorationDefaults: { footerLineColor: "url(unsafe)" },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  test("retains per-page overrides independently of a campaign's selected preset", () => {
    const campaign = campaignSchema.parse({
      id: "campaign",
      name: "Offers",
      products: [],
      brochurePresetId: "neptun-october",
      coverBrandTagline: "Jeto më mirë, çdo ditë.",
      brochureVisualStyle: "october",
      pageDecorationDefaults: { showHeader: true, showFooterLine: true },
      pages: {
        0: {
          headerText: "TELEVIZORË",
          showFooterLine: false,
          footerNumber: "2",
          headerColor: "#007dc5",
        },
        1: {
          showHeader: false,
          showFooterLogo: false,
          showFooterPageNumber: false,
        },
      },
    });
    expect(campaign.coverBrandTagline).toBe("Jeto më mirë, çdo ditë.");
    expect(
      campaignSchema.safeParse({
        ...campaign,
        coverBrandTagline: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(campaign.pages?.["0"]).toMatchObject({
      showFooterLine: false,
      footerNumber: "2",
      headerText: "TELEVIZORË",
    });
    expect(campaign.pages?.["1"]).toMatchObject({
      showHeader: false,
      showFooterLogo: false,
      showFooterPageNumber: false,
    });
    expect(
      campaignSchema.safeParse({
        ...campaign,
        pages: { 0: { headerColor: "red;display:none" } },
      }).success,
    ).toBe(false);
  });
  test("migrates the previous extra price defaults into the two supported choices", () => {
    expect(resolveSettings({ offerStyle: "minimal" }).offerStyle).toBe(
      "current",
    );
    expect(resolveSettings({ offerStyle: "compact" }).offerStyle).toBe("card");
  });
});

describe("persisted optional manufacturer logo colors", () => {
  test.each(["", "#12abEF", "#12345678"])(
    "preserves custom color %s across brochures, defaults and presets",
    (brandLogoColor) => {
      const campaign = campaignSchema.parse({
        id: "logo-color",
        name: "Offer",
        products: [],
        brandLogoColor,
        brandLogoMode: "original",
      });
      const settings = workspaceSettingsSchema.parse({
        brochure: { brandLogoColor, brandLogoMode: "original" },
        brochurePresets: [
          {
            id: "custom-logo",
            name: "Logo color",
            design: { brandLogoColor, brandLogoMode: "original" },
          },
        ],
      });
      expect(campaign.brandLogoColor).toBe(brandLogoColor);
      expect(campaign.brandLogoMode).toBe("original");
      expect(settings.brochure.brandLogoColor).toBe(brandLogoColor);
      expect(settings.brochurePresets[0]!.design.brandLogoColor).toBe(
        brandLogoColor,
      );
      expect(settings.brochurePresets[0]!.design.brandLogoMode).toBe(
        "original",
      );
    },
  );
  test("old appearance modes remain optional and compatible", () => {
    expect(
      campaignSchema.parse({ id: "old-logo", name: "Offer", products: [] })
        .brandLogoColor,
    ).toBeUndefined();
    expect(resolveSettings(null).brochure.brandLogoColor).toBeUndefined();
    for (const brandLogoMode of ["auto", "white", "dark", "original"])
      expect(
        workspaceSettingsSchema.safeParse({
          brochure: { brandLogoMode },
          brochurePresets: [
            {
              id: "old-logo-mode",
              name: "Old mode",
              design: { brandLogoMode },
            },
          ],
        }).success,
      ).toBe(true);
  });
  test.each([
    "red",
    "rgb(255,0,0)",
    "url(javascript:bad)",
    "#123456;display:none",
    123456,
  ])("rejects invalid persisted logo color %p", (brandLogoColor) => {
    expect(
      campaignSchema.safeParse({
        id: "bad-logo",
        name: "Offer",
        products: [],
        brandLogoColor,
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({ brochure: { brandLogoColor } })
        .success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        brochurePresets: [
          { id: "bad-logo", name: "Bad", design: { brandLogoColor } },
        ],
      }).success,
    ).toBe(false);
  });
});

test("keeps both black brochure designs in campaign/default/preset snapshots", () => {
  for (const brochureReferenceDesign of ["black-friday", "black-collection"]) {
    expect(
      campaignSchema.parse({
        id: "black-design",
        name: "Offer",
        products: [],
        brochureReferenceDesign,
      }).brochureReferenceDesign,
    ).toBe(brochureReferenceDesign);
    const settings = workspaceSettingsSchema.parse({
      brochure: { brochureReferenceDesign },
      brochurePresets: [
        {
          id: "black-design",
          name: "Black design",
          design: { brochureReferenceDesign },
        },
      ],
    });
    expect(settings.brochure.brochureReferenceDesign).toBe(
      brochureReferenceDesign,
    );
    expect(settings.brochurePresets[0]!.design.brochureReferenceDesign).toBe(
      brochureReferenceDesign,
    );
  }
});
