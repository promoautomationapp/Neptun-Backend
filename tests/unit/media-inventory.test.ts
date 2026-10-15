import { MediaInventoryCache } from "../../src/modules/insights/media-inventory";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
describe("nonblocking media inventory", () => {
  afterEach(() => jest.useRealTimers());
  test("returns immediately, deduplicates concurrent scans and isolates organizations", async () => {
    let finish!: (value: {
      objects: number;
      bytes: number;
      checkedAt: string;
    }) => void;
    const scan = jest.fn(
      () =>
        new Promise<{ objects: number; bytes: number; checkedAt: string }>(
          (resolve) => {
            finish = resolve;
          },
        ),
    );
    const cache = new MediaInventoryCache(scan);
    expect(cache.status("a")).toMatchObject({
      bucket: null,
      bucketPending: true,
      bucketError: false,
    });
    cache.status("a");
    expect(scan).toHaveBeenCalledTimes(1);
    finish({ objects: 42, bytes: 1000, checkedAt: "2026-10-15T10:00:00Z" });
    await flush();
    expect(cache.status("a")).toMatchObject({
      bucket: { objects: 42 },
      bucketPending: false,
      bucketStale: false,
    });
    expect(cache.status("b")).toMatchObject({
      bucket: null,
      bucketPending: true,
    });
    expect(scan).toHaveBeenCalledTimes(2);
    finish({ objects: 0, bytes: 0, checkedAt: "2026-10-15T10:00:01Z" });
    await flush();
  });
  test("ends a hanging scan, avoids a retry storm and never reports failed inventory as zero", async () => {
    jest.useFakeTimers();
    const scan = jest.fn(() => new Promise<never>(() => {}));
    const cache = new MediaInventoryCache(scan);
    cache.status("a");
    await jest.advanceTimersByTimeAsync(45_001);
    expect(cache.status("a")).toEqual({
      bucket: null,
      bucketPending: false,
      bucketStale: false,
      bucketError: true,
    });
    cache.status("a");
    expect(scan).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_001);
    expect(cache.status("a").bucketPending).toBe(true);
    expect(scan).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(45_001);
  });
  test("retains a successful checked inventory when the next refresh fails", async () => {
    jest.useFakeTimers();
    const checked = {
      objects: 12,
      bytes: 450,
      checkedAt: "2026-10-15T10:00:00Z",
    };
    const scan = jest
      .fn()
      .mockResolvedValueOnce(checked)
      .mockRejectedValueOnce(new Error("offline"));
    const cache = new MediaInventoryCache(scan);
    cache.status("a");
    await flush();
    await jest.advanceTimersByTimeAsync(300_001);
    expect(cache.status("a")).toMatchObject({
      bucket: checked,
      bucketPending: true,
      bucketStale: true,
    });
    await flush();
    expect(cache.status("a")).toEqual({
      bucket: checked,
      bucketPending: false,
      bucketStale: true,
      bucketError: true,
    });
  });
});
