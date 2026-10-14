export function isTransientStorageError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const detail = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "EAI_AGAIN"].includes(
      detail.code ?? "",
    ) ||
    ["AbortError", "TimeoutError", "RequestTimeout", "SlowDown"].includes(
      detail.name ?? "",
    ) ||
    [429, 500, 502, 503, 504].includes(detail.$metadata?.httpStatusCode ?? 0)
  );
}

/** Retry the complete read, including consumption of the response stream. */
export async function readWithStorageRetry<T>(
  read: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2 || !isTransientStorageError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}
