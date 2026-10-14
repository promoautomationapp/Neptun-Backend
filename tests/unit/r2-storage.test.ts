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
});
