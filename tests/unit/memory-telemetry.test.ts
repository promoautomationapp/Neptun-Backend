import { startMemoryTelemetry } from "../../src/shared/memory-telemetry";
import { logger } from "../../src/shared/logger";
import { readFile } from "node:fs/promises";
jest.mock("node:fs/promises", () => ({ readFile: jest.fn() }));
jest.mock("../../src/shared/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn() },
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() =>
  Object.defineProperty(process, "platform", { ...platform, value: "linux" }),
);

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  jest.restoreAllMocks();
  jest.useRealTimers();
  jest.clearAllMocks();
});
test("memory monitoring logs only numeric memory fields, warns before the container cap, and stops its timer", async () => {
  jest.useFakeTimers();
  (readFile as jest.Mock).mockImplementation(async (path: string) =>
    path.endsWith("current")
      ? String(450 * 1024 * 1024)
      : String(512 * 1024 * 1024),
  );
  const stop = startMemoryTelemetry("api");
  await jest.advanceTimersByTimeAsync(1);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      role: "api",
      containerMiB: 450,
      containerLimitMiB: 512,
      rssMiB: expect.any(Number),
      heapUsedMiB: expect.any(Number),
    }),
    "Runtime memory pressure",
  );
  expect(Object.keys((logger.warn as jest.Mock).mock.calls[0]![0])).not.toEqual(
    expect.arrayContaining(["headers", "cookie", "url", "userId"]),
  );
  stop();
  await jest.advanceTimersByTimeAsync(120_000);
  expect(logger.warn).toHaveBeenCalledTimes(1);
});

test("unavailable container counters cannot crash the process or generate an unhandled rejection", async () => {
  jest.useFakeTimers();
  (readFile as jest.Mock).mockRejectedValue(new Error("not available"));
  const stop = startMemoryTelemetry("worker");
  await jest.advanceTimersByTimeAsync(60_001);
  stop();
  expect(logger.info).toHaveBeenCalledTimes(2);
  expect(logger.warn).not.toHaveBeenCalled();
});
