import { providerRetryDelay } from "../../src/worker/ai/retry-policy";

test("respects short provider cooldowns and releases the worker for long cooldowns", () => {
  expect(providerRetryDelay(0, 0)).toBe(3000);
  expect(providerRetryDelay(5000, 0)).toBe(5000);
  expect(providerRetryDelay(0, 2)).toBe(12_000);
  expect(providerRetryDelay(30_000, 0)).toBe(30_000);
  expect(providerRetryDelay(3_600_000, 0)).toBeNull();
  expect(providerRetryDelay(Infinity, 0)).toBeNull();
});
