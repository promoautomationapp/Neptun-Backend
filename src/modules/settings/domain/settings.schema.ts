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
export const customBrochureFormatSchema = z
  .object({
    id: z.string().regex(/^custom-[a-z0-9-]{1,90}$/),
    name: z.string().trim().min(1).max(120),
    width: z.number().int().min(64).max(8192),
    height: z.number().int().min(64).max(8192),
    visible: z.boolean().default(true),
  })
  .refine((item) => item.width * item.height <= 40_000_000, {
    path: ["width"],
    message: "Custom dimensions must be 40 megapixels or smaller.",
  });
/** Editable product artwork defaults, snapshotted into each new brochure. */
export const productDesignSchema = z.object({
  photo: z
    .object({
      mode: z.enum(["automatic", "custom"]).default("automatic"),
      x: z.number().min(0).max(100).default(50),
      y: z.number().min(0).max(100).default(50),
      scale: z.number().min(0.2).max(2.5).default(1),
      automaticTvSizing: z.boolean().default(true),
    })
    .prefault({}),
  details: z
    .object({
      placement: z.enum(["automatic", "left", "bottom"]).default("automatic"),
      fill: z.enum(["automatic", "filled", "outline"]).default("automatic"),
    })
    .prefault({}),
  typography: z
    .object({
      font: z
        .enum(["automatic", "SkolaSans", "TSTAR", "Arial"])
        .default("automatic"),
      nameScale: z.number().min(0.7).max(1.5).default(1),
      codeScale: z.number().min(0.7).max(1.5).default(1),
      detailScale: z.number().min(0.7).max(1.5).default(1),
    })
    .prefault({}),
  priceScale: z.number().min(0.6).max(1.5).default(1),
  savingsScale: z.number().min(0.6).max(1.5).default(1),
  divider: z
    .object({
      visible: z.boolean().default(true),
      thickness: z.number().min(0.5).max(8).nullable().default(null),
      color: color.default(""),
      lightColor: color.default(""),
      gap: z.number().min(0).max(30).default(2),
    })
    .prefault({}),
  grid: z
    .object({
      mode: z.enum(["automatic", "custom"]).default("automatic"),
      horizontal: z.number().min(0).max(12).default(3.1),
      vertical: z.number().min(0).max(12).default(3.2),
      content: z.number().min(0).max(8).default(1),
    })
    .prefault({}),
});
export type ProductDesignDefaults = z.infer<typeof productDesignSchema>;
export const brochureDefaultsSchema = z
  .object({
    format: z
      .union([z.enum(FORMAT_IDS), z.string().regex(/^custom-[a-z0-9-]{1,90}$/)])
      .default("neptun1080x1350"),
    automaticProductLayout: z.boolean().default(true),
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
    customFormats: z.array(customBrochureFormatSchema).max(100).default([]),
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
    productDesign: productDesignSchema.prefault({}),
    hiddenBuiltinLogos: z.array(z.string().max(100)).max(100).default([]),
    logoRules: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            target: z
              .enum(["cover", "pages", "stores", "footer", "both"])
              .default("both"),
            background: z.enum(["light", "dark", "color"]).default("dark"),
            color: color.default(""),
            image: source.refine(
              Boolean,
              "Choose a logo for the background rule.",
            ),
            enabled: z.boolean().default(true),
          })
          .superRefine((rule, ctx) => {
            if (
              rule.background === "color" &&
              !/^#[0-9a-f]{6}$/i.test(rule.color)
            )
              ctx.addIssue({
                code: "custom",
                path: ["color"],
                message: "Choose the background color for this logo.",
              });
          }),
      )
      .max(50)
      .default([]),
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
    automaticSavings: z
      .object({
        enabled: z.boolean().default(true),
        amountThreshold: z.number().min(0).max(100000).default(50),
      })
      .prefault({}),
    categoryPathSavingModes: z
      .record(z.string().max(1600), savingMode)
      .default({}),
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
          logo: source.optional(),
          visible: z.boolean().default(true),
        }),
      )
      .max(200)
      .prefault(defaults.campaignTypes),
    defaultCampaignTypeId: z.string().max(100).default("campaign-type-1"),
  })
  .catchall(json)
  .superRefine((value, ctx) => {
    for (const key of [
      "stores",
      "campaignTypes",
      "logoLibrary",
      "customFormats",
    ] as const) {
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
    if (
      value.brochure.format.startsWith("custom-") &&
      !value.customFormats.some(
        (item) => item.id === value.brochure.format && item.visible,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["brochure", "format"],
        message: "Choose a visible custom format or a built-in format.",
      });
    const formatNames = value.customFormats.map((item) =>
      item.name.toLocaleLowerCase(),
    );
    if (new Set(formatNames).size !== formatNames.length)
      ctx.addIssue({
        code: "custom",
        path: ["customFormats"],
        message: "Custom format names must be unique.",
      });
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
export type LogoRule = z.infer<
  typeof workspaceSettingsSchema
>["logoRules"][number];
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
