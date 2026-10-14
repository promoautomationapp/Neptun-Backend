import { z } from "zod";
import defaults from "./defaults.json";

type Value =
  string | number | boolean | null | Value[] | { [key: string]: Value };
const json: z.ZodType<Value> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
const text = z.string().max(20000);
const color = z.union([z.literal(""), z.string().regex(/^#[0-9a-f]{6}$/i)]);
const savingMode = z.enum(["amount", "percentage"]);
const source = z.union([
  z.literal(""),
  z
    .string()
    .max(2000)
    .regex(
      /^(?:\/api\/assets\/(?:[0-9a-f-]{36}|legacy\/[^?#]+|app\/logo)|https?:\/\/[^\s]+\/api\/assets\/(?:[0-9a-f-]{36}|legacy\/[^?#]+|app\/logo))$/i,
    ),
]);
const gradient = z.object({
  from: z.string().regex(/^#[0-9a-f]{6}$/i),
  to: z.string().regex(/^#[0-9a-f]{6}$/i),
  angle: z.number().min(0).max(360),
});
const background = z
  .object({
    color: color.default(""),
    gradient: gradient.nullable().default(null),
    image: source.default(""),
  })
  .catchall(json);
export const FORMAT_IDS = [
  "neptun1080x1350",
  "square1080",
  "landscape1920x1080",
  "portrait1080x1440",
  "story1080x1920",
  "a4",
  "a3",
  "a5",
  "letter",
  "a4Landscape",
  "a3Landscape",
] as const;
export const brochureDefaultsSchema = z
  .object({
    format: z.enum(FORMAT_IDS).default("neptun1080x1350"),
    layout: z
      .enum(["grid6portrait", "grid6", "grid9", "classic8", "duo4"])
      .default("grid6portrait"),
    coverTemplate: z
      .enum(["photo", "blueRibbon", "blueClean", "redBlue"])
      .default("blueRibbon"),
    coverProductLayout: z.enum(["pair", "hero", "row"]).default("pair"),
    coverLogoStyle: z
      .enum(["original", "framed", "custom"])
      .default("original"),
    coverLogoSource: source.default(defaults.brochure.coverLogoSource),
    neptunLogoOption: z.enum(["classic", "framed"]).default("classic"),
    priceLogo: z.enum(["symbol", "wordmark", "custom"]).default("symbol"),
    customPriceLogo: source.default(""),
    pricePalette: z
      .object({
        red: z.string().regex(/^#[0-9a-f]{6}$/i),
        blue: z.string().regex(/^#[0-9a-f]{6}$/i),
        blueBand: z.string().regex(/^#[0-9a-f]{6}$/i),
        saving: z.string().regex(/^#[0-9a-f]{6}$/i),
      })
      .prefault(defaults.brochure.pricePalette),
    installments: z.number().int().min(1).max(60).default(12),
    paymentText: text.default(""),
    showCoverLogo: z.boolean().default(true),
    showCoverBand: z.boolean().default(false),
    showCoverHeadline: z.boolean().default(false),
    showCoverMessage: z.boolean().default(false),
    showCoverGradient: z.boolean().default(false),
    coverMessageColor: color.default("#ffffff"),
    coverHeadlineColor: color.default("#ffffff"),
    coverTypeColor: color.default("#ffffff"),
    coverFooterColor: color.default("#ffffff"),
    productBackground: background.prefault(defaults.brochure.productBackground),
    coverBackground: background.prefault(defaults.brochure.coverBackground),
    storesBackground: background.prefault(defaults.brochure.storesBackground),
    storesDisplay: z.enum(["page", "footer", "none"]).default("page"),
    showOnlineStore: z.boolean().default(true),
    storesHiddenElements: z.array(z.string().max(100)).max(100).default([]),
    storeFooterHiddenElements: z
      .array(z.string().max(100))
      .max(100)
      .default([]),
    storeFields: z
      .object({
        city: z.boolean().default(true),
        name: z.boolean().default(true),
        address: z.boolean().default(true),
        phone: z.boolean().default(true),
        icon: z.boolean().default(true),
      })
      .prefault({}),
    contactVisibility: z.record(z.string().max(100), z.boolean()).default({}),
    showInteriorFooter: z.boolean().default(true),
    showFooterPageNumber: z.boolean().default(true),
  })
  .catchall(json)
  .superRefine((value, ctx) => {
    if (value.coverLogoStyle === "custom" && !value.coverLogoSource)
      ctx.addIssue({
        code: "custom",
        path: ["coverLogoSource"],
        message: "Choose the default cover logo.",
      });
    if (value.priceLogo === "custom" && !value.customPriceLogo)
      ctx.addIssue({
        code: "custom",
        path: ["customPriceLogo"],
        message: "Choose the default price logo.",
      });
  });
export const workspaceSettingsSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    stores: z
      .array(
        z
          .object({
            id: z.string().max(100).optional(),
            city: text.default(""),
            name: text.default(""),
            address: text.default(""),
            phone: text.default(""),
            visible: z.boolean().default(true),
          })
          .catchall(json),
      )
      .max(200)
      .prefault(defaults.stores),
    contact: z.record(z.string().max(100), text).prefault(defaults.contact),
    offerStyle: z
      .enum(["current", "card", "minimal", "compact"])
      .default("current"),
    savingMode: savingMode.default("amount"),
    brochure: brochureDefaultsSchema.prefault({}),
    logoLibrary: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          name: z.string().trim().min(1).max(200),
          url: source.refine(Boolean, "Choose an image."),
        }),
      )
      .max(300)
      .default([]),
    brandAssets: z.record(z.string().max(100), source).default({}),
    brandLogos: z.record(z.string().max(100), source).default({}),
    iconDefaults: z
      .record(
        z.string().max(100),
        z.object({
          image: source.default(""),
          visible: z.boolean().default(true),
        }),
      )
      .default({}),
    automaticSavings: z.object({
      enabled: z.boolean().default(true),
      amountThreshold: z.number().min(0).max(100000).default(50),
    }).prefault({}),
    categoryPathSavingModes: z.record(z.string().max(1600), savingMode).default({}),
    categorySavingModes: z
      .record(
        z.string().max(200),
        z.object({
          mode: savingMode.optional(),
          subcategories: z.record(z.string().max(200), savingMode).optional(),
        }),
      )
      .default({}),
    campaignTypes: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          name: z.string().trim().min(1).max(120),
          tagline: text.default(""),
          visible: z.boolean().default(true),
        }),
      )
      .max(200)
      .prefault(defaults.campaignTypes),
    defaultCampaignTypeId: z.string().max(100).default("campaign-type-1"),
  })
  .catchall(json)
  .superRefine((value, ctx) => {
    for (const key of ["stores", "campaignTypes", "logoLibrary"] as const) {
      const ids = value[key]
        .map((item) => item.id)
        .filter((id) => id !== undefined);
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Every item must have a unique ID.",
        });
    }
    const names = value.campaignTypes.map((item) =>
      item.name.toLocaleLowerCase(),
    );
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: "custom",
        path: ["campaignTypes"],
        message: "Campaign type names must be unique.",
      });
    if (
      value.defaultCampaignTypeId &&
      !value.campaignTypes.some(
        (item) => item.id === value.defaultCampaignTypeId && item.visible,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["defaultCampaignTypeId"],
        message: "Choose a visible default campaign type, or leave it empty.",
      });
  });
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type BrochureDefaults = z.infer<typeof brochureDefaultsSchema>;
export type LogoAsset = WorkspaceSettings["logoLibrary"][number];
export type CampaignType = WorkspaceSettings["campaignTypes"][number];
export type IconDefault = WorkspaceSettings["iconDefaults"][string];
export function resolveSettings(value: unknown): WorkspaceSettings {
  const settings = workspaceSettingsSchema.parse(value ?? {});
  settings.stores.forEach((store, index) => {
    store.id ??= `store-${index + 1}`;
  });
  return settings;
}
