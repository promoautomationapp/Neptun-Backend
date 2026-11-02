import { createImageWorkBudget } from "../../src/security/image-work";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => jest.useRealTimers());
test("immediate work admission bounds native operations without retaining an unbounded queue", async () => {
  const budget = createImageWorkBudget({ maxConcurrent: 1, maxBytes: 100 });
  const pending = deferred<string>();
  const first = budget.run(60, () => pending.promise);
  const excess = jest.fn(() => "should not start");
  await expect(budget.run(1, excess)).rejects.toMatchObject({
    status: 429,
    response: { code: "IMAGE_WORK_BUSY", retryAfterSeconds: 1 },
  });
  expect(excess).not.toHaveBeenCalled();
  pending.resolve("ready");
  await expect(first).resolves.toBe("ready");
  await expect(budget.run(100, () => "reused")).resolves.toBe("reused");
});
test("byte reservations also bound parallel work and are released after asynchronous or synchronous errors", async () => {
  const budget = createImageWorkBudget({ maxConcurrent: 3, maxBytes: 100 });
  const pending = deferred<void>();
  const first = budget.run(60, () => pending.promise);
  const never = jest.fn();
  await expect(budget.run(41, never)).rejects.toMatchObject({ status: 429 });
  await expect(
    budget.run(40, async () => {
      throw new Error("read failed");
    }),
  ).rejects.toThrow("read failed");
  await expect(
    budget.run(40, () => {
      throw new Error("decode failed");
    }),
  ).rejects.toThrow("decode failed");
  expect(never).not.toHaveBeenCalled();
  pending.resolve();
  await first;
  await expect(budget.run(100, () => 1)).resolves.toBe(1);
});
test("the media waiting room has a fixed bound and starts reads only when their reservation fits", async () => {
  const budget = createImageWorkBudget({
    maxConcurrent: 2,
    maxBytes: 100,
    maxQueued: 2,
  });
  const first = deferred<void>();
  const second = deferred<void>();
  const reads = jest.fn();
  const running = budget.run(100, () => first.promise);
  const waiting = budget.run(60, async () => {
    reads("second");
    await second.promise;
  });
  const third = budget.run(50, () => reads("third"));
  await expect(budget.run(1, () => reads("overflow"))).rejects.toMatchObject({
    status: 429,
  });
  expect(reads).not.toHaveBeenCalled();
  first.resolve();
  await running;
  expect(reads).toHaveBeenCalledTimes(1);
  expect(reads).toHaveBeenCalledWith("second");
  second.resolve();
  await Promise.all([waiting, third]);
  expect(reads.mock.calls).toEqual([["second"], ["third"]]);
});
test("waiting requests expire instead of owning a queue entry forever", async () => {
  jest.useFakeTimers();
  const budget = createImageWorkBudget({
    maxConcurrent: 1,
    maxBytes: 100,
    maxQueued: 1,
    maxWaitMs: 10,
  });
  const pending = deferred<void>();
  const running = budget.run(100, () => pending.promise);
  const work = jest.fn();
  const rejected = expect(budget.run(1, work)).rejects.toMatchObject({
    status: 429,
  });
  await jest.advanceTimersByTimeAsync(10);
  await rejected;
  expect(work).not.toHaveBeenCalled();
  pending.resolve();
  await running;
  await expect(budget.run(100, () => "after timeout")).resolves.toBe(
    "after timeout",
  );
});
test.each([0, -1, 101, NaN, Infinity, 1.5])(
  "invalid or oversized reservation %s never starts work",
  async (size) => {
    const budget = createImageWorkBudget({ maxConcurrent: 1, maxBytes: 100 });
    const work = jest.fn();
    await expect(budget.run(size, work)).rejects.toMatchObject({
      status: 400,
      response: { code: "IMAGE_SIZE_LIMIT" },
    });
    expect(work).not.toHaveBeenCalled();
    await expect(budget.run(100, () => true)).resolves.toBe(true);
  },
);
