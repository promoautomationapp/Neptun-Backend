import { Readable } from "node:stream";
import { StorageReadLimitError } from "../../src/modules/storage/storage-read-limit";
import { S3Client } from "@aws-sdk/client-s3";
import { R2Storage } from "../../src/modules/storage/r2.storage";

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return { ...actual, S3Client: jest.fn() };
});

describe("complete R2 media reads", () => {
  test("restarts an interrupted stream and returns only the complete original bytes", async () => {
    const original = Buffer.from("approved full resolution photo");
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => {
            throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
          },
        },
      })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => original },
      });
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
    const result = await new R2Storage().read("org/tenant/assets/approved.png");
    expect(result).toEqual(original);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].input.Key).toBe(
      "org/tenant/assets/approved.png",
    );
  });
  test("does not retry missing objects or authorization failures", async () => {
    const error = Object.assign(new Error("Missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest.fn().mockRejectedValue(error);
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
    await expect(new R2Storage().read("missing")).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("bounds stalled response bodies, destroys each stream and stops after bounded retries", async () => {
    jest.useFakeTimers();
    try {
      const destroy = jest.fn();
      const send = jest.fn().mockResolvedValue({
        Body: {
          destroy,
          transformToByteArray: () => new Promise(() => {}),
        },
      });
      (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
      const pending = new R2Storage().read("org/tenant/stalled-photo");
      const rejected = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await jest.runAllTimersAsync();
      await rejected;
      expect(send).toHaveBeenCalledTimes(3);
      expect(destroy).toHaveBeenCalledTimes(3);
      expect(send.mock.calls.every((call) => call[1].abortSignal.aborted)).toBe(
        true,
      );
    } finally {
      jest.useRealTimers();
    }
  });
  test("bounds writes even if the transport fails to reject after abort", async () => {
    jest.useFakeTimers();
    try {
      const send = jest.fn().mockImplementation(() => new Promise(() => {}));
      (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
      const rejected = expect(
        new R2Storage().put("photo", Buffer.from("data"), "image/png"),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      await jest.runAllTimersAsync();
      await rejected;
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("bounded untrusted R2 staging reads", () => {
  test("rejects an oversized ContentLength before consuming and destroys the body without retrying", async () => {
    const consume = jest.fn(async () => Buffer.from("never read"));
    const destroy = jest.fn();
    const send = jest.fn().mockResolvedValue({
      ContentLength: 101,
      Body: { destroy, transformToByteArray: consume },
    });
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
    await expect(
      new R2Storage().read("org/owned/staging/intent", 100),
    ).rejects.toBeInstanceOf(StorageReadLimitError);
    expect(consume).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, 1])(
    "bounds actual chunks when ContentLength is %s and stops before later chunks",
    async (ContentLength) => {
      let readLastChunk = false;
      let closed = false;
      const source = (async function* () {
        try {
          yield Buffer.from("1234");
          yield Buffer.from("5678");
          readLastChunk = true;
          yield Buffer.from("must not be read");
        } finally {
          closed = true;
        }
      })();
      const destroy = jest.fn();
      const body = { [Symbol.asyncIterator]: () => source, destroy };
      const send = jest.fn().mockResolvedValue({ ContentLength, Body: body });
      (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
      await expect(
        new R2Storage().read("org/owned/staging/intent", 6),
      ).rejects.toBeInstanceOf(StorageReadLimitError);
      expect(readLastChunk).toBe(false);
      expect(closed).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  test("accepts an exact-size streamed body and preserves its original bytes", async () => {
    const body = Readable.from([Buffer.from("123"), Buffer.from("456")]);
    const send = jest.fn().mockResolvedValue({ ContentLength: 6, Body: body });
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
    expect(await new R2Storage().read("org/owned/staging/intent", 6)).toEqual(
      Buffer.from("123456"),
    );
  });

  test("rejects invalid limits before sending storage requests", async () => {
    const send = jest.fn();
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
    for (const maxBytes of [0, -1, NaN, Infinity, 1.5])
      await expect(
        new R2Storage().read("org/owned/staging/intent", maxBytes),
      ).rejects.toThrow("Invalid storage read limit");
    expect(send).not.toHaveBeenCalled();
  });
});
