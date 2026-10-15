import {
  resolveSettings,
  workspaceSettingsSchema,
} from "../../src/modules/settings/domain/settings.schema";
import { campaignSchema } from "../../src/modules/documents/domain/document";

describe("custom brochure formats", () => {
  const format = {
    id: "custom-screen",
    name: "Screen",
    width: 1600,
    height: 900,
    visible: true,
  };
  test("validates named custom dimensions and persists selected defaults", () => {
    const base = resolveSettings(null);
    const value = {
      ...base,
      customFormats: [format],
      brochure: { ...base.brochure, format: format.id },
    };
    expect(resolveSettings(value)).toMatchObject({
      customFormats: [format],
      brochure: { format: format.id },
    });
    for (const customFormats of [
      [{ ...format, width: 0 }],
      [{ ...format, height: 8193 }],
      [{ ...format, width: 8192, height: 8192 }],
      [{ ...format, visible: false }],
      [format, format],
    ])
      expect(
        workspaceSettingsSchema.safeParse({ ...value, customFormats }).success,
      ).toBe(false);
  });
  test("retains a brochure's dimension snapshot independently of workspace formats", () => {
    const brochure = campaignSchema.parse({
      id: "72350d8d-1bf6-40a9-ab4e-f258323d20d6",
      name: "Saved custom size",
      products: [],
      brochureFormat: format.id,
      brochureFormatSnapshot: {
        id: format.id,
        name: format.name,
        width: format.width,
        height: format.height,
      },
    });
    const settings = resolveSettings(null);
    settings.customFormats = [];
    expect(brochure.brochureFormatSnapshot).toEqual({
      id: format.id,
      name: "Screen",
      width: 1600,
      height: 900,
    });
  });
});
