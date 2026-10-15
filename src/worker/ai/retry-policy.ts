/** A long provider cooldown must not occupy the only photo worker indefinitely.
 * Do not retry earlier than the provider requested; leave a visible failure. */
export function providerRetryDelay(
  retryAfterMs: number,
  attempt: number,
): number | null {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs > 30_000) return null;
  return Math.min(30_000, Math.max(retryAfterMs, 3000 * 2 ** attempt));
}
