import {
  discoverCategories,
  embeddedModel,
  normalizeHierarchy,
  productModel,
  healthyFullCrawl,
  siteUrl,
  normalizeProductCode,
  siteTransport,
} from "../../src/modules/catalog/neptun-source";
describe("Neptun authoritative catalog parsing", () => {
  test("website timeouts retry and explain that the existing catalog is preserved", async () => {
    jest.useFakeTimers();
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(timeout);
    try {
      const pending = expect(
        siteTransport.get("https://www.neptun-ks.com/"),
      ).rejects.toThrow("The existing catalog is kept; try again later.");
      await jest.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      fetchMock.mockRestore();
      jest.useRealTimers();
    }
  });
  test("normalizes padded website product codes before lookup and missing detection", () => {
    expect(normalizeProductCode(" 84063149 \u00a0")).toBe("84063149");
    expect(normalizeProductCode(84063149)).toBe("84063149");
  });
  test("keeps every category level and strips navigation bullets and home", () => {
    expect(
      normalizeHierarchy(
        "SHTEPIA > •TV & AUDIO & VIDEO > -AKSESORË > KABLLO > Adapterë",
      ),
    ).toEqual(["TV & AUDIO & VIDEO", "AKSESORË", "KABLLO", "Adapterë"]);
  });
  test("walks arbitrary nested menu depth and excludes brand navigation", () => {
    const categories = discoverCategories(
      '<nav id="mainNMenu"><ul><li><a>Produktet</a><ul><li><a data-label-parent="Shtëpia.nspx">IT</a><ul><li><a href="/Aksesore.nspx">AKSESORË</a><ul><li><a href="/Mouse.nspx">Mouse</a><ul><li><a href="/Mouse_Pad.nspx">Mouse Pad</a></li></ul></li></ul></li></ul><div class="brands"><ul><li><a href="/manufacturers/manufacturer-products.nspx">HAMA</a></li></ul></div></li></ul></li></ul></nav>',
    );
    expect(categories.at(-1)?.path).toEqual([
      "IT",
      "AKSESORË",
      "Mouse",
      "Mouse Pad",
    ]);
    expect(categories).toHaveLength(3);
  });
  test("reads HTML escaped structured models and retail price, never installment", () => {
    const model = {
      CodeNumber: "84066693",
      Title: "TV FUEGO",
      Category: { Id: 174, Name: "TV", Url: "tv" },
      Manufacturer: { Name: "FUEGO" },
      RegularPrice: 139,
      RatePrice: 3.86,
      ActualPrice: 119,
      NavigationPath: [{ Name: "•TV & AUDIO & VIDEO" }, { Name: "TV" }],
      ShortDescription: '* Përmasat: 32"<br/>* Wi-Fi',
      Warranty: 12,
      Thumbnail: "2026/07/tv.jpg",
      Url: "TV-FUEGO",
    };
    const html = `<div data-productModel="${JSON.stringify(model).replaceAll('"', "&quot;")}"></div>`;
    const product = productModel(embeddedModel(html, "productModel"), []);
    expect(product.regular).toBe(139);
    expect(product.sale).toBe(119);
    expect(product.warranty).toBe("1 vit");
    expect(product.specs["Përmasat"]).toBe('32"');
    expect(product.categoryPath).toBe("TV & AUDIO & VIDEO > TV");
    expect(product.imageUrls).toEqual([
      "https://www.neptun-ks.com/2026/07/tv.jpg",
    ]);
  });
  test("refuses missing codes and remote-host image URLs", () => {
    expect(() => productModel({ Title: "TV" }, [])).toThrow("stable code");
    expect(() => siteUrl("https://example.com/image.jpg")).toThrow("Untrusted");
  });
  test("keeps product details and photos when a gallery includes YouTube videos", () => {
    const product = productModel(
      {
        CodeNumber: "84052013",
        Title: "PHILIPS FC9351/01",
        Url: "PHILIPS-FC9351-01",
        Category: { Url: "fshese_elektrike1" },
        ShortDescription: "* Fuqia: 900 W",
        Thumbnail: "2019/09/20/9351.jpg",
        Images: [
          {
            Type: "video",
            RelativePath: "https://img.youtube.com/vi/example/0.jpg",
          },
          { Type: " VIDEO ", url: "https://youtu.be/example" },
          { Type: null, RelativePath: "2019/09/20/9351.jpg" },
          { RelativePath: "2019/09/20/9351.1.jpg" },
        ],
      },
      ["ELEKTROSHTËPIAKE TË VOGLA", "FSHESE ELEKTRIKE"],
    );
    expect(product.specs.Fuqia).toBe("900 W");
    expect(product.imageUrls).toEqual([
      "https://www.neptun-ks.com/2019/09/20/9351.jpg",
      "https://www.neptun-ks.com/2019/09/20/9351.1.jpg",
    ]);
  });
  test("still rejects external photos when video entries are excluded", () => {
    expect(() =>
      productModel(
        {
          CodeNumber: "84052013",
          Title: "Product",
          Url: "product",
          Images: [
            { Type: "video", url: "https://youtu.be/example" },
            { Type: null, RelativePath: "https://example.com/photo.jpg" },
          ],
        },
        [],
      ),
    ).toThrow("Untrusted Neptun URL");
  });
  test("does not mark missing on incomplete, empty or suspiciously smaller crawls", () => {
    expect(healthyFullCrawl(2000, 2300, 0)).toBe(true);
    expect(healthyFullCrawl(2000, 1000, 0)).toBe(false);
    expect(healthyFullCrawl(2000, 2300, 1)).toBe(false);
    expect(healthyFullCrawl(0, 0, 0)).toBe(false);
  });
});

describe("complete product category membership", () => {
  const item = {
    CodeNumber: "123",
    Title: "Adapter",
    Category: { Name: "USB-C", Url: "usb-c" },
    Url: "adapter",
    Images: [],
  };
  test("keeps authoritative intermediate menu branches when detail breadcrumbs skip them", () => {
    expect(
      productModel(
        { ...item, NavigationPath: [{ Name: "IT" }, { Name: "USB-C" }] },
        ["IT", "AKSESORË", "Kabllo", "USB-C"],
      ).categoryPath,
    ).toBe("IT > AKSESORË > Kabllo > USB-C");
    expect(
      productModel({ ...item, NavigationPath: [] }, [
        "IT",
        "AKSESORË",
        "Kabllo",
        "USB-C",
      ]).categoryPath,
    ).toBe("IT > AKSESORË > Kabllo > USB-C");
  });
  test("keeps a product's own different primary breadcrumb instead of mixing unrelated branches", () => {
    expect(
      productModel(
        { ...item, NavigationPath: [{ Name: "TELEFONIA" }, { Name: "USB-C" }] },
        ["IT", "AKSESORË", "Kabllo", "USB-C"],
      ).categoryPath,
    ).toBe("TELEFONIA > USB-C");
  });
});
