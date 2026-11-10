import { campaignSchema } from "../../src/modules/documents/domain/document";

it("persists safe editable banner frames and rejects invalid new banner fields", () => {
  const banner = {
    id: "hero",
    layoutRole: "banner",
    type: "text",
    text: "Black Friday",
    x: 0,
    y: 0,
    width: 100,
    height: 8,
    backgroundColor: "#ff3b1f",
    textVerticalAlign: "center",
    padding: 1.2,
  };
  const document = {
    id: "banner-test",
    name: "Brochure",
    products: [],
    pageArtworks: { cover: [banner] },
  };
  expect(campaignSchema.parse(document).pageArtworks).toEqual(
    document.pageArtworks,
  );
  expect(
    campaignSchema.safeParse({
      ...document,
      pageArtworks: { cover: [{ ...banner, width: 10000 }] },
    }).success,
  ).toBe(false);
  expect(
    campaignSchema.safeParse({
      ...document,
      pageArtworks: { cover: [{ ...banner, backgroundColor: "url(unsafe)" }] },
    }).success,
  ).toBe(false);
  expect(
    campaignSchema.parse({
      ...document,
      pageArtworks: {
        cover: [{ id: "old", x: -4, width: 150, legacyFrame: true }],
      },
    }).pageArtworks,
  ).toEqual({ cover: [{ id: "old", x: -4, width: 150, legacyFrame: true }] });
});

it("preserves validated native shapes and person provenance without accepting markup as a path", () => {
  const shape = {
    id: "ribbon",
    type: "shape",
    x: 0,
    y: 0,
    width: 100,
    height: 6,
    shapePath: "M0 0 L100 0 L90 100 L0 100 Z",
    fill: "#ef4023",
    stroke: "#00000000",
    strokeWidth: 0,
    referenceSource: "tv2.png",
    referenceRole: "person",
  };
  const document = {
    id: "shape-test",
    name: "Shape",
    products: [],
    pageArtworks: { cover: [shape] },
  };
  expect(campaignSchema.parse(document).pageArtworks).toEqual(
    document.pageArtworks,
  );
  expect(
    campaignSchema.safeParse({
      ...document,
      pageArtworks: {
        cover: [{ ...shape, shapePath: "<script>bad</script>" }],
      },
    }).success,
  ).toBe(false);
  expect(
    campaignSchema.safeParse({
      ...document,
      pageArtworks: { cover: [{ ...shape, fill: "url(unsafe)" }] },
    }).success,
  ).toBe(false);
});

it("validates family markers, source typography and editable installment metadata", () => {
  const document = {
    id: "metadata",
    name: "BF",
    brochureReferenceDesign: "black-friday",
    products: [
      {
        code: "one",
        name: "TV",
        brochureInstallment: { amount: 33.3, count: 12, sale: 399 },
      },
    ],
    pageArtworks: {
      cover: [
        {
          id: "title",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          text: "BLACK FRIDAY",
          wordSpacing: -0.05,
          whiteSpace: "nowrap",
        },
      ],
    },
  };
  expect(campaignSchema.parse(document).brochureReferenceDesign).toBe(
    "black-friday",
  );
  expect(
    campaignSchema.safeParse({
      ...document,
      brochureReferenceDesign: "unknown",
    }).success,
  ).toBe(false);
  expect(
    campaignSchema.safeParse({
      ...document,
      products: [
        {
          ...document.products[0],
          brochureInstallment: { amount: -1, count: 100, sale: 399 },
        },
      ],
    }).success,
  ).toBe(false);
});

it("validates device annotation roles and SVG fields in product-local artwork", () => {
  const artwork = {
    id: "wifi",
    type: "shape",
    referenceRole: "wifi",
    shapePath: "M0 0 L100 100",
    fill: "#ffffff",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
  const document = {
    id: "device",
    name: "AC",
    products: [{ code: "ac", name: "AC", productArtworks: [artwork] }],
  };
  expect(campaignSchema.safeParse(document).success).toBe(true);
  expect(
    campaignSchema.safeParse({
      ...document,
      products: [
        {
          ...document.products[0],
          productArtworks: [{ ...artwork, referenceRole: "unknown" }],
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    campaignSchema.safeParse({
      ...document,
      products: [
        {
          ...document.products[0],
          productArtworks: [{ ...artwork, shapePath: "<svg>bad</svg>" }],
        },
      ],
    }).success,
  ).toBe(false);
});

it("validates the printed savings figure against explicit original prices", () => {
  const product = {
    code: "one",
    name: "Offer",
    brochureSavings: {
      value: 38,
      type: "percentage",
      regular: 79.99,
      sale: 49.99,
    },
  };
  const document = { id: "savings", name: "BF", products: [product] };
  expect(campaignSchema.parse(document).products[0]!.brochureSavings).toEqual(
    product.brochureSavings,
  );
  for (const bad of [
    { value: -1 },
    { type: "percent" },
    { regular: 0 },
    { sale: Infinity },
  ])
    expect(
      campaignSchema.safeParse({
        ...document,
        products: [
          {
            ...product,
            brochureSavings: { ...product.brochureSavings, ...bad },
          },
        ],
      }).success,
    ).toBe(false);
});

it("persists bounded inline text runs for superscript source percentages", () => {
  const artwork = {
    id: "percent",
    type: "text",
    text: "25%",
    x: 0,
    y: 0,
    width: 10,
    textRuns: [
      { text: "25", fontScale: 1 },
      { text: "%", fontScale: 0.583, verticalAlign: "super" },
    ],
  };
  const document = {
    id: "runs",
    name: "BF",
    products: [],
    pageArtworks: { cover: [artwork] },
  };
  expect(campaignSchema.parse(document).pageArtworks).toEqual(
    document.pageArtworks,
  );
  expect(
    campaignSchema.safeParse({
      ...document,
      pageArtworks: {
        cover: [{ ...artwork, textRuns: [{ text: "%", fontScale: 1000 }] }],
      },
    }).success,
  ).toBe(false);
});
