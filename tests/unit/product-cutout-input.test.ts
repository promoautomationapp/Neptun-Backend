import "reflect-metadata";
import sharp from "sharp";
import type { Database } from "../../src/database/database";
import type { StoragePort } from "../../src/modules/storage/storage.port";
import type { Actor } from "../../src/modules/auth/domain/actor";
import type { DocumentAssets } from "../../src/modules/assets/document-assets";
import type { LifestyleRepository } from "../../src/modules/ai/lifestyle.repository";
import type { JsonObject } from "../../src/shared/json";
import { AiRepository } from "../../src/modules/ai/ai.repository";
import { imageBackgroundSignature } from "../../src/modules/ai/domain/image-context";
import { OpenAiProvider } from "../../src/worker/ai/provider";

const primaryId = "00000000-0000-4000-8000-000000000001";
const backgroundId = "00000000-0000-4000-8000-000000000002";
const primary = `/api/assets/${primaryId}`;
const background = `/api/assets/${backgroundId}`;
const actor: Actor = {
  organizationId: "organization",
  userId: "user",
  email: "staff@example.test",
  role: "editor",
  reviewRole: "staff",
  accountRole: "staff",
  mustChangePassword: false,
};
let cutout: Buffer;
beforeAll(async () => {
  cutout = await sharp(
    Buffer.from(
      '<svg width="20" height="20"><rect x="2" y="2" width="16" height="16" fill="#123456"/></svg>',
    ),
  )
    .png()
    .toBuffer();
});
function providerFetch() {
  return jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ data: [{ b64_json: cutout.toString("base64") }] }),
          { status: 200 },
        ),
    );
}
function providerBody(fetchImpl: ReturnType<typeof providerFetch>) {
  return JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as {
    images: { image_url: string }[];
    prompt: string;
  };
}

test.each(["missing", "oversized", "storage-failure"])(
  "an optional %s brochure reference does not stop the authorized product cutout",
  async (failure) => {
    const query = jest.fn(async (_sql: string, values: unknown[]) => {
      if (values[1] === primaryId)
        return [
          {
            mime_type: "image/png",
            size: cutout.length,
            storage_key: "primary",
          },
        ];
      return failure === "missing"
        ? []
        : [
            {
              mime_type: "image/png",
              size: failure === "oversized" ? 14_000_001 : 100,
              storage_key: "background",
            },
          ];
    });
    const read = jest.fn(async (key: string, _limit: number) => {
      if (key === "background")
        throw new Error("Reference could not be loaded");
      return cutout;
    });
    const fetchImpl = providerFetch();
    const provider = new OpenAiProvider(
      { query } as unknown as Database,
      { read } as unknown as StoragePort,
      actor.organizationId,
      fetchImpl,
    );
    const context = { kind: "image", image: background, color: "#1b4075" };
    const result = await provider.run(
      "cutout",
      { image: primary, backgroundContext: context },
      "gpt-image-2.5-sunburst",
    );
    expect(result.bytes).toEqual(cutout);
    expect(result.json.backgroundSignature).toBe(
      imageBackgroundSignature(context),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = providerBody(fetchImpl);
    expect(body.images).toHaveLength(1);
    expect(body.prompt).not.toMatch(
      /second supplied|SECOND image|\/api\/assets\//,
    );
    expect(body.prompt).toContain('"kind":"solid"');
    expect(read).toHaveBeenCalledWith("primary", 14_000_000);
    expect(
      query.mock.calls.every(
        ([, values]) => values[0] === actor.organizationId,
      ),
    ).toBe(true);
  },
);

test("a missing or unauthorized primary photo still fails before a provider request", async () => {
  const read = jest.fn();
  const fetchImpl = providerFetch();
  const provider = new OpenAiProvider(
    { query: jest.fn().mockResolvedValue([]) } as unknown as Database,
    { read } as unknown as StoragePort,
    actor.organizationId,
    fetchImpl,
  );
  await expect(
    provider.run(
      "cutout",
      {
        image: primary,
        backgroundContext: { kind: "image", image: background },
      },
      "gpt-image-2.5-sunburst",
    ),
  ).rejects.toThrow("source image");
  expect(read).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("GIF provider input is a PNG of only the first frame while the animated original remains unchanged", async () => {
  const frames = Buffer.alloc(16 * 32 * 4);
  for (let index = 0; index < 16 * 32; index++)
    frames.set(
      index < 16 * 16 ? [255, 0, 0, 255] : [0, 0, 255, 255],
      index * 4,
    );
  const gif = await sharp(frames, {
    raw: { width: 16, height: 32, channels: 4, pageHeight: 16 },
  })
    .gif({ delay: [100, 100], loop: 0 })
    .toBuffer();
  expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
  const unchanged = Buffer.from(gif);
  const read = jest.fn().mockResolvedValue(gif);
  const put = jest.fn();
  const fetchImpl = providerFetch();
  const provider = new OpenAiProvider(
    {
      query: jest
        .fn()
        .mockResolvedValue([
          {
            mime_type: "image/gif",
            size: gif.length,
            storage_key: "original.gif",
          },
        ]),
    } as unknown as Database,
    { read, put } as unknown as StoragePort,
    actor.organizationId,
    fetchImpl,
  );
  await provider.run("cutout", { image: primary }, "gpt-image-2.5-sunburst");
  const dataUrl = providerBody(fetchImpl).images[0]!.image_url;
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  const sent = Buffer.from(dataUrl.split(",")[1]!, "base64");
  expect(await sharp(sent).metadata()).toMatchObject({
    format: "png",
    width: 16,
    height: 16,
  });
  const pixel = await sharp(sent)
    .extract({ left: 8, top: 8, width: 1, height: 1 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  expect([...pixel]).toEqual([255, 0, 0, 255]);
  expect(gif).toEqual(unchanged);
  expect(put).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledWith("original.gif", 14_000_000);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "enqueue keeps the primary source mandatory when an optional background is unavailable (primary unavailable: %s)",
  async (primaryUnavailable) => {
    const externalize = jest.fn(async (_org: string, value: JsonObject) => {
      if (value.backgroundContext || primaryUnavailable)
        throw new Error("Document refers to an unavailable asset.");
      return structuredClone(value);
    });
    const query = jest
      .fn()
      .mockResolvedValue([{ id: primaryId, sha256: "primary-hash" }]);
    const clientQuery = jest.fn(async (sql: string, _values: unknown[]) => ({
      rows: sql.startsWith("SELECT * FROM ai_results")
        ? [
            {
              id: "saved",
              operation: "cutout",
              status: "completed",
              output_asset_id: "prepared",
              output_json: {},
            },
          ]
        : [],
    }));
    const db = {
      query,
      transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation({ query: clientQuery }),
    } as unknown as Database;
    const repo = new AiRepository(
      db,
      { externalize } as unknown as DocumentAssets,
      {} as LifestyleRepository,
    );
    const request = repo.enqueue(actor, {
      operation: "cutout",
      params: {
        image: primary,
        backgroundContext: { kind: "image", image: background },
      },
      regenerate: false,
    });
    if (primaryUnavailable) {
      await expect(request).rejects.toThrow("unavailable asset");
      expect(query).not.toHaveBeenCalled();
      expect(clientQuery).not.toHaveBeenCalled();
    } else {
      await expect(request).resolves.toMatchObject({
        cached: true,
        status: "succeeded",
      });
      expect(externalize).toHaveBeenNthCalledWith(
        1,
        actor.organizationId,
        { image: primary },
        actor.userId,
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("organization_id=$1"),
        [actor.organizationId, [primaryId, backgroundId]],
      );
    }
  },
);
