import sharp from "sharp";
import type { Database } from "../../src/database/database";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import { normalizeAiParams } from "../../src/modules/ai/domain/params";
import {
  hasSuppliedModel,
  productImageSearchInputSchema,
  namedProductFamily,
  productImageSearchQueries,
  productImageSearchCacheIdentity,
} from "../../src/modules/ai/domain/product-image-search";
import {
  promptVersion,
  PROMPT_VERSION,
} from "../../src/modules/ai/domain/request";
import { OpenAiProvider } from "../../src/worker/ai/provider";
import { verifyProductImage } from "../../src/worker/ai/product-image-search";
import {
  downloadPublic,
  isPublicAddress,
  publicHttpsUrl,
} from "../../src/worker/ai/public-download";
import type { PublicDownloadDependencies } from "../../src/worker/ai/public-download";

const input = productImageSearchInputSchema.parse({
  code: "84009999",
  name: "TV LED FUEGO 65ELU720GTV",
  brand: "FUEGO",
  details: ["65 inch", "4K UHD"],
});
const candidate = {
  found: true,
  reason: "",
  sourceUrl: "https://manufacturer.example/products/65ELU720GTV",
  imageUrl: "https://images.example/65ELU720GTV.png",
  matchedName: input.name,
  matchedModel: "65ELU720GTV",
  evidence: "Exact FUEGO model on manufacturer page.",
};
let png: Buffer;
beforeAll(async () => {
  png = await sharp({
    create: { width: 200, height: 200, channels: 4, background: "#123456" },
  })
    .png()
    .toBuffer();
});
const downloader = (
  html = `<h1>${input.name}</h1><meta property="og:image" content="${candidate.imageUrl}">`,
) =>
  jest
    .fn<ReturnType<typeof downloadPublic>, Parameters<typeof downloadPublic>>()
    .mockImplementation(async (url) =>
      url === candidate.sourceUrl
        ? { bytes: Buffer.from(html), mimeType: "text/html", url }
        : { bytes: png, mimeType: "image/png", url },
    );

test("search cache inputs retain identity and facts but ignore prices, positions, UI IDs and retry", () => {
  expect(
    normalizeAiParams("product_image_search", {
      ...input,
      sale: 299,
      x: 10,
      requestId: "a",
      retry: true,
    }),
  ).toEqual(
    normalizeAiParams("product_image_search", {
      ...input,
      sale: 599,
      x: 20,
      requestId: "b",
    }),
  );
  expect(promptVersion("product_image_search")).not.toBe(PROMPT_VERSION);
  expect(promptVersion("brand_prep")).toBe(PROMPT_VERSION);
  expect(() =>
    productImageSearchInputSchema.parse({ code: "", name: "" }),
  ).toThrow();
});
test("specific supplied models are required; partial models, storage sizes and invented identifiers fail", () => {
  expect(namedProductFamily("iPhone17ProMax 128GB")).toBe("iPhone17ProMax");
  expect(namedProductFamily("GalaxyS26Ultra 512GB")).toBe("GalaxyS26Ultra");
  expect(hasSuppliedModel(input, candidate)).toBe(true);
  expect(
    hasSuppliedModel(input, { ...candidate, matchedModel: "65ELU720GTV2" }),
  ).toBe(false);
  expect(
    hasSuppliedModel(input, { ...candidate, matchedModel: "65ELU720" }),
  ).toBe(false);
  expect(
    hasSuppliedModel(
      { ...input, name: "iPhone 17 Pro Max 128GB" },
      { ...candidate, matchedModel: "128GB" },
    ),
  ).toBe(false);
  expect(
    hasSuppliedModel(
      { ...input, name: "iPhone 17 Pro Max 128GB" },
      { ...candidate, matchedModel: "iPhone 17 Pro Max" },
    ),
  ).toBe(true);
  expect(
    hasSuppliedModel(
      { ...input, name: "iPhone 17 Pro Max 128GB" },
      { ...candidate, matchedModel: "iPhone 17" },
    ),
  ).toBe(false);
});
test("private, metadata, loopback, mapped IPv6 and reserved addresses cannot be fetched", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.2",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "2001:0db8::1",
    "2002:7f00:1::",
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  for (const url of [
    "http://example.com/photo.png",
    "https://127.0.0.1/image",
    "https://user:secret@example.com/image",
    "https://example.com:8443/image",
    "https://foo.local/image",
    "file:///tmp/image",
  ])
    expect(() => publicHttpsUrl(url)).toThrow();
});
test("DNS results are pinned and every redirect is revalidated before connecting", async () => {
  const request = jest
    .fn<
      ReturnType<PublicDownloadDependencies["request"]>,
      Parameters<PublicDownloadDependencies["request"]>
    >()
    .mockResolvedValue({
      status: 302,
      location: "https://169.254.169.254/latest/meta-data",
      mimeType: "",
      bytes: Buffer.alloc(0),
    });
  const dependencies = {
    resolve: jest
      .fn<
        ReturnType<PublicDownloadDependencies["resolve"]>,
        Parameters<PublicDownloadDependencies["resolve"]>
      >()
      .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]),
    request,
  };
  await expect(
    downloadPublic("https://example.com/photo", 100, dependencies),
  ).rejects.toThrow("public HTTPS");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[1]).toEqual({ address: "8.8.8.8", family: 4 });
  dependencies.resolve.mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  await expect(
    downloadPublic("https://example.com/photo", 100, dependencies),
  ).rejects.toThrow("public address");
  expect(request).toHaveBeenCalledTimes(1);
});
test("oversized responses and excessive redirects stop without returning bytes", async () => {
  const request = jest
    .fn<
      ReturnType<PublicDownloadDependencies["request"]>,
      Parameters<PublicDownloadDependencies["request"]>
    >()
    .mockResolvedValue({
      status: 200,
      mimeType: "image/png",
      bytes: Buffer.alloc(101),
    });
  const dependencies = {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request,
  };
  await expect(
    downloadPublic("https://example.com/image", 100, dependencies),
  ).rejects.toThrow("oversized");
  request.mockResolvedValue({
    status: 302,
    location: "/another-image",
    mimeType: "",
    bytes: Buffer.alloc(0),
  });
  await expect(
    downloadPublic("https://example.com/image", 100, dependencies),
  ).rejects.toThrow("too many redirects");
  expect(request).toHaveBeenCalledTimes(5);
});
test("an exact consulted page and referenced original photo produce verified bytes and provenance", async () => {
  const download = downloader();
  const result = await verifyProductImage(
    input,
    candidate,
    [candidate.sourceUrl],
    download,
  );
  expect(result.json).toEqual({
    found: true,
    sourceUrl: candidate.sourceUrl,
    imageUrl: candidate.imageUrl,
    matchedName: input.name,
    matchedModel: candidate.matchedModel,
  });
  expect("bytes" in result && result.bytes).toEqual(png);
  expect(download).toHaveBeenCalledTimes(2);
});
test("similar models, unconsulted pages and invented photo URLs stay missing", async () => {
  const download = downloader();
  expect(
    (await verifyProductImage(input, candidate, [], download)).json.found,
  ).toBe(false);
  expect(download).not.toHaveBeenCalled();
  for (const html of [
    `<h1>FUEGO 65ELU720GTV2</h1><img src="${candidate.imageUrl}">`,
    `<h1>OTHERBRAND 65ELU720GTV</h1><img src="${candidate.imageUrl}">`,
    `<h1>${input.name}</h1><img src="https://images.example/other.png">`,
  ])
    expect(
      (
        await verifyProductImage(
          input,
          candidate,
          [candidate.sourceUrl],
          downloader(html),
        )
      ).json.found,
    ).toBe(false);
});
test("blocked downloads, misleading MIME bytes and small thumbnails safely return missing", async () => {
  const blocked = jest
    .fn<ReturnType<typeof downloadPublic>, Parameters<typeof downloadPublic>>()
    .mockRejectedValue(new Error("blocked"));
  expect(
    (await verifyProductImage(input, candidate, [candidate.sourceUrl], blocked))
      .json.found,
  ).toBe(false);
  for (const replacement of [
    { bytes: Buffer.from("<html>not a photo</html>"), mimeType: "image/png" },
    { bytes: png, mimeType: "image/jpeg" },
    {
      bytes: await sharp(png).resize(80, 80).png().toBuffer(),
      mimeType: "image/png",
    },
  ]) {
    const download = downloader();
    download.mockImplementationOnce(async (url) => ({
      bytes: Buffer.from(
        `<h1>${input.name}</h1><meta property="og:image" content="${candidate.imageUrl}">`,
      ),
      mimeType: "text/html",
      url,
    }));
    download.mockImplementationOnce(async (url) => ({ ...replacement, url }));
    expect(
      (
        await verifyProductImage(
          input,
          candidate,
          [candidate.sourceUrl],
          download,
        )
      ).json.found,
    ).toBe(false);
  }
});
test("recommendation photos and partial family, storage or color variants are never applied", async () => {
  const phone = {
    ...input,
    name: "Apple iPhone 17 Pro Max 128GB Black",
    brand: "Apple",
    details: [],
  };
  const photo = {
    ...candidate,
    matchedName: phone.name,
    matchedModel: "iPhone 17 Pro Max",
  };
  for (const html of [
    `<h1>Apple iPhone 17 128GB Black</h1><meta property="og:image" content="${photo.imageUrl}"><p>Related: Apple iPhone 17 Pro Max 128GB Black</p>`,
    `<h1>Apple iPhone 17 Pro Max 256GB Black</h1><meta property="og:image" content="${photo.imageUrl}">`,
    `<h1>Apple iPhone 17 Pro Max 128GB Orange</h1><meta property="og:image" content="${photo.imageUrl}">`,
    `<h1>${phone.name}</h1><meta property="og:image" content="https://images.example/main.png"><img src="${photo.imageUrl}">`,
  ])
    expect(
      (
        await verifyProductImage(
          phone,
          photo,
          [photo.sourceUrl],
          downloader(html),
        )
      ).json.found,
    ).toBe(false);
});
test("Product metadata binds the image to its exact identity and capacity facts", async () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    brand: { "@type": "Brand", name: input.brand },
    model: candidate.matchedModel,
    image: [candidate.imageUrl],
  })}</script>`;
  expect(
    (
      await verifyProductImage(
        input,
        candidate,
        [candidate.sourceUrl],
        downloader(html),
      )
    ).json.found,
  ).toBe(true);
  const mobile = {
    ...input,
    name: "Galaxy S26 Ultra",
    brand: "Samsung",
    details: ["512GB", "12GB"],
  };
  const mobileCandidate = { ...candidate, matchedModel: "Galaxy S26 Ultra" };
  const modelPage = `<h1>Samsung Galaxy S26 Ultra 256GB 12GB</h1><meta property="og:image" content="${candidate.imageUrl}">`;
  expect(
    (
      await verifyProductImage(
        mobile,
        mobileCandidate,
        [candidate.sourceUrl],
        downloader(modelPage),
      )
    ).json.found,
  ).toBe(false);
});
test("provider uses required web search with sources, never photo generation, with mocked networking", async () => {
  const fetchImpl = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "web_search_call",
              action: { sources: [{ url: candidate.sourceUrl }] },
            },
            {
              type: "message",
              content: [
                { type: "output_text", text: JSON.stringify(candidate) },
              ],
            },
          ],
          usage: { input_tokens: 80, output_tokens: 40 },
        }),
        { status: 200 },
      ),
    );
  const provider = new OpenAiProvider(
    {} as Database,
    {} as StoragePort,
    "org",
    fetchImpl,
    downloader(),
  );
  const result = await provider.run(
    "product_image_search",
    input,
    "gpt-4.1-mini",
  );
  expect(result.json.found).toBe(true);
  expect(result.inputTokens).toBe(80);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(
    "https://api.openai.com/v1/responses",
  );
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<
    string,
    unknown
  >;
  expect(body.tools).toEqual([{ type: "web_search" }]);
  expect(body.tool_choice).toBe("required");
  expect(body.include).toEqual(["web_search_call.action.sources"]);
  expect(JSON.parse(String(body.input))).toEqual({
    product: input,
    searchQueries: productImageSearchQueries(input),
  });
  expect(body.max_tool_calls).toBe(4);
});

test("search context uses explicit model, EAN, color and source while category placement shares one identity", () => {
  const full = productImageSearchInputSchema.parse({
    ...input,
    model: "65ELU720GTV",
    ean: "1234567890123",
    subcategory: "Televisions",
    sourceUrl: "https://manufacturer.example/tv",
    variants: ["black"],
  });
  expect(productImageSearchQueries(full).join(" ")).toMatch(
    /65ELU720GTV.*black/,
  );
  expect(productImageSearchQueries(full)).toContain(full.sourceUrl);
  expect(productImageSearchCacheIdentity(full)).toEqual(
    productImageSearchCacheIdentity({
      ...full,
      category: "Other category",
      subcategory: "Another placement",
      sourceUrl: "https://retailer.example/tv",
    }),
  );
  expect(productImageSearchCacheIdentity(full)).not.toEqual(
    productImageSearchCacheIdentity({ ...full, variants: ["white"] }),
  );
  expect(
    hasSuppliedModel(
      productImageSearchInputSchema.parse({
        ...input,
        name: "HUAWEI FreeClip Black",
        brand: "HUAWEI",
      }),
      { ...candidate, matchedModel: "FreeClip" },
    ),
  ).toBe(true);
  expect(
    hasSuppliedModel(
      productImageSearchInputSchema.parse({
        ...input,
        name: "Apple AirPods Max Blue",
        brand: "APPLE",
      }),
      { ...candidate, matchedModel: "AirPods Max" },
    ),
  ).toBe(true);
});
test("a model supplied in a model field or labelled specification may establish identity without inventing it", () => {
  const specified = productImageSearchInputSchema.parse({
    ...input,
    name: "FUEGO soundbar",
    model: "F999",
  });
  expect(
    hasSuppliedModel(specified, { ...candidate, matchedModel: "F999" }),
  ).toBe(true);
  expect(
    hasSuppliedModel(
      { ...specified, model: "", details: ["Model: F999"] },
      { ...candidate, matchedModel: "F999" },
    ),
  ).toBe(true);
  expect(
    hasSuppliedModel(
      { ...specified, model: "", details: ["Power: 1200 W"] },
      { ...candidate, matchedModel: "1200W" },
    ),
  ).toBe(false);
});
test("official lazy galleries can bind the exact family and selected color to the original image", async () => {
  const earbuds = productImageSearchInputSchema.parse({
    ...input,
    name: "HUAWEI FreeClip 2 Black",
    brand: "HUAWEI",
    details: [],
  });
  const exact = {
    ...candidate,
    matchedModel: "FreeClip 2",
    matchedName: earbuds.name,
  };
  const html = `<h1>HUAWEI FreeClip 2</h1><img data-src="${exact.imageUrl}" alt="HUAWEI FreeClip 2 black front view, display the black color">`;
  expect(
    (
      await verifyProductImage(
        earbuds,
        exact,
        [exact.sourceUrl],
        downloader(html),
      )
    ).json.found,
  ).toBe(true);
  for (const alt of [
    "HUAWEI FreeClip 2 White",
    "HUAWEI FreeClip Black",
    "Black",
    "HUAWEI FreeClip 2 Black comparison",
    "Woman wearing HUAWEI FreeClip 2 Black",
  ]) {
    expect(
      (
        await verifyProductImage(
          earbuds,
          exact,
          [exact.sourceUrl],
          downloader(
            `<h1>HUAWEI FreeClip 2</h1><img src="${exact.imageUrl}" alt="${alt}">`,
          ),
        )
      ).json.found,
    ).toBe(false);
  }
});
test("JSON-LD variant color and model metadata bind Beige SE3 without allowing SE2 or a standalone bundle substitute", async () => {
  const earbuds = productImageSearchInputSchema.parse({
    ...input,
    name: "HUAWEI FreeBuds SE 3 Beige",
    brand: "HUAWEI",
    details: [],
  });
  const exact = {
    ...candidate,
    matchedModel: "FreeBuds SE 3",
    matchedName: earbuds.name,
  };
  const metadata = (name: string, color: string) =>
    `<script type="application/ld+json">${JSON.stringify({ "@type": "ProductGroup", hasVariant: [{ "@type": "Product", name, brand: "HUAWEI", color, image: exact.imageUrl }] })}</script>`;
  expect(
    (
      await verifyProductImage(
        earbuds,
        exact,
        [exact.sourceUrl],
        downloader(metadata("HUAWEI FreeBuds SE 3", "Beige")),
      )
    ).json.found,
  ).toBe(true);
  expect(
    (
      await verifyProductImage(
        earbuds,
        exact,
        [exact.sourceUrl],
        downloader(metadata("HUAWEI FreeBuds SE 2", "Beige")),
      )
    ).json.found,
  ).toBe(false);
  const bundle = {
    ...earbuds,
    name: "HUAWEI FreeBuds SE 3 Beige BUNDLE",
    bundle: true,
  };
  expect(
    (
      await verifyProductImage(
        bundle,
        exact,
        [exact.sourceUrl],
        downloader(metadata("HUAWEI FreeBuds SE 3", "Beige")),
      )
    ).json.found,
  ).toBe(false);
});
test("an inaccessible candidate can fall back to another exact consulted candidate without a second provider call", async () => {
  const alternative = {
    ...candidate,
    sourceUrl: "https://second.example/exact",
  };
  const download = downloader();
  download.mockImplementation(async (url) => {
    if (url === candidate.sourceUrl) throw new Error("blocked retailer");
    if (url === alternative.sourceUrl)
      return {
        url,
        bytes: Buffer.from(
          `<h1>${input.name}</h1><meta property="og:image" content="${candidate.imageUrl}">`,
        ),
        mimeType: "text/html",
      };
    return { url, bytes: png, mimeType: "image/png" };
  });
  expect(
    (
      await verifyProductImage(
        input,
        { ...candidate, alternatives: [alternative] },
        [candidate.sourceUrl, alternative.sourceUrl],
        download,
      )
    ).json,
  ).toMatchObject({ found: true, sourceUrl: alternative.sourceUrl });
});
test("a clean no-match response completes without contacting any photo server", async () => {
  const download = downloader();
  const result = await verifyProductImage(
    input,
    { ...candidate, found: false, reason: "No exact model available." },
    [],
    download,
  );
  expect(result.json).toEqual({
    found: false,
    reason: "No exact model available.",
  });
  expect(download).not.toHaveBeenCalled();
});

test("Air Pods 4 ANC USB-C requires that exact edition and cannot inherit the non-ANC or Lightning photo", async () => {
  const apple = productImageSearchInputSchema.parse({
    ...input,
    code: "84062037",
    name: "KUFJE APPLE AIR PODS 4 (USB-C) ANC",
    brand: "APPLE",
    details: ["Bluetooth: v5.3"],
  });
  const exact = {
    ...candidate,
    matchedName: apple.name,
    matchedModel: "AirPods 4",
  };
  expect(namedProductFamily(apple.name)).toBe("AIR PODS 4");
  const header = (name: string) =>
    `<h1>${name}</h1><meta property="og:image" content="${exact.imageUrl}">`;
  expect(
    (
      await verifyProductImage(
        apple,
        exact,
        [exact.sourceUrl],
        downloader(
          header("Apple AirPods 4 with Active Noise Cancellation USB-C"),
        ),
      )
    ).json.found,
  ).toBe(true);
  for (const wrong of [
    "Apple AirPods 4 USB-C",
    "Apple AirPods 4 without ANC USB-C",
    "Apple AirPods 4 ANC Lightning",
    "Apple AirPods 3 ANC USB-C",
  ]) {
    expect(
      (
        await verifyProductImage(
          apple,
          exact,
          [exact.sourceUrl],
          downloader(header(wrong)),
        )
      ).json.found,
    ).toBe(false);
  }
  const disabledAnc = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Apple AirPods 4 USB-C", brand: "Apple", image: exact.imageUrl, additionalProperty: [{ name: "ANC", value: false }] })}</script>`;
  expect(
    (
      await verifyProductImage(
        apple,
        exact,
        [exact.sourceUrl],
        downloader(disabledAnc),
      )
    ).json.found,
  ).toBe(false);
});
