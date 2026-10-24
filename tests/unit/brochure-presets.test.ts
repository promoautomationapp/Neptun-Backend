import {
  resolveSettings,
  workspaceSettingsSchema,
} from "../../src/modules/settings/domain/settings.schema";
import { campaignSchema } from "../../src/modules/documents/domain/document";

describe("reusable brochure designs and page decoration contract", () => {
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
