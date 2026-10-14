import { legacyNeptunImageUrl } from "../../src/modules/assets/export-image";
import { downloadPublic } from "../../src/shared/public-download";
import type { PublicDownloadDependencies } from "../../src/shared/public-download";

test("legacy export permits only the two explicit public Neptun HTTPS hosts", () => {
  expect(
    legacyNeptunImageUrl("https://www.neptun-ks.com/photos/tv.png").hostname,
  ).toBe("www.neptun-ks.com");
  expect(
    legacyNeptunImageUrl("https://neptun-ks.com/photos/tv.png").hostname,
  ).toBe("neptun-ks.com");
  for (const source of [
    "https://neptun-ks.com.evil.example/photos/tv.png",
    "https://private.neptun-ks.com/photos/tv.png",
    "http://www.neptun-ks.com/photos/tv.png",
    "https://www.neptun-ks.com:8443/photos/tv.png",
    "https://user:secret@www.neptun-ks.com/photos/tv.png",
    "https://127.0.0.1/photos/tv.png",
    "https://169.254.169.254/photos/tv.png",
    "file:///tmp/tv.png",
    "/api/assets/other-org-asset",
  ])
    expect(() => legacyNeptunImageUrl(source)).toThrow(
      "original public Neptun HTTPS",
    );
});
test("the shared safe downloader revalidates explicit host policy on every redirect", async () => {
  const request = jest
    .fn<
      ReturnType<PublicDownloadDependencies["request"]>,
      Parameters<PublicDownloadDependencies["request"]>
    >()
    .mockResolvedValue({
      status: 302,
      location: "https://another-public.example/tv.png",
      mimeType: "",
      bytes: Buffer.alloc(0),
    });
  const resolve = jest
    .fn<
      ReturnType<PublicDownloadDependencies["resolve"]>,
      Parameters<PublicDownloadDependencies["resolve"]>
    >()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  await expect(
    downloadPublic(
      "https://www.neptun-ks.com/tv.png",
      100,
      { request, resolve },
      (url) => {
        legacyNeptunImageUrl(url.href);
      },
    ),
  ).rejects.toThrow("original public Neptun HTTPS");
  expect(request).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledTimes(1);
});
test("an allowed Neptun hostname cannot resolve to loopback or metadata addresses", async () => {
  const request = jest.fn<
    ReturnType<PublicDownloadDependencies["request"]>,
    Parameters<PublicDownloadDependencies["request"]>
  >();
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.2",
    "::ffff:127.0.0.1",
  ])
    await expect(
      downloadPublic(
        "https://www.neptun-ks.com/tv.png",
        100,
        { request, resolve: async () => [{ address, family: 4 }] },
        (url) => {
          legacyNeptunImageUrl(url.href);
        },
      ),
    ).rejects.toThrow("public address");
  expect(request).not.toHaveBeenCalled();
});
