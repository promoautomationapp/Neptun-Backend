import {
  resolveSettings,
  workspaceSettingsSchema,
} from "../../src/modules/settings/domain/settings.schema";
describe("settings contracts", () => {
  test("legacy settings receive the existing design defaults without dropping fields", () => {
    const settings = resolveSettings({
      stores: [
        { city: "Prishtinë", name: "Store", address: "Street", phone: "123" },
      ],
      contact: { email: "saved@example.test" },
      offerStyle: "card",
      savingMode: "percentage",
      referenceDetail: { keep: true },
    });
    expect(settings).toMatchObject({
      offerStyle: "card",
      savingMode: "percentage",
      referenceDetail: { keep: true },
      brochure: {
        format: "neptun1080x1350",
        layout: "grid6portrait",
        showCoverLogo: true,
        showCoverBand: false,
      },
      stores: [{ id: "store-1", visible: true }],
      contact: { email: "saved@example.test" },
    });
  });
  test("explicit empty lists, false flags and independent backgrounds are retained", () => {
    const base = resolveSettings(null);
    const settings = resolveSettings({
      ...base,
      stores: [],
      campaignTypes: [],
      defaultCampaignTypeId: "",
      brochure: {
        ...base.brochure,
        showCoverLogo: false,
        storesDisplay: "none",
        storesBackground: { color: "#ffffff", image: "", gradient: null },
      },
    });
    expect(settings.stores).toEqual([]);
    expect(settings.campaignTypes).toEqual([]);
    expect(settings.brochure.showCoverLogo).toBe(false);
    expect(settings.brochure.storesBackground.color).toBe("#ffffff");
  });
  test("validates editable product defaults without changing older saved documents", () => {
    const value = resolveSettings({
      productDesign: {
        photo: { mode: "custom", x: 40, scale: 1.2 },
        details: { fill: "outline" },
      },
      brochure: { automaticProductLayout: false },
    });
    expect(value).toMatchObject({
      productDesign: {
        photo: { mode: "custom", x: 40, y: 50, scale: 1.2 },
        details: { fill: "outline", placement: "automatic" },
      },
      brochure: { automaticProductLayout: false },
    });
    expect(
      workspaceSettingsSchema.safeParse({
        productDesign: { photo: { scale: 10 } },
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        productDesign: { typography: { font: "url(unsafe)" } },
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        productDesign: { divider: { color: "red;display:none" } },
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        productDesign: { grid: { horizontal: -1 } },
      }).success,
    ).toBe(false);
  });
  test("rejects invalid dimensions, savings choices, hidden defaults and external assets", () => {
    const settings = resolveSettings(null);
    expect(
      workspaceSettingsSchema.safeParse({
        ...settings,
        brochure: { ...settings.brochure, format: "unknown" },
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({ ...settings, savingMode: "wrong" })
        .success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        ...settings,
        campaignTypes: settings.campaignTypes.map((item) => ({
          ...item,
          visible: false,
        })),
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({
        ...settings,
        brandAssets: { neptun: "https://external.example/logo.png" },
      }).success,
    ).toBe(false);
  });
});
