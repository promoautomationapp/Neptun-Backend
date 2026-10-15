/** Bound the entire operation, including a response body that stops producing data. */
export async function withStorageDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds = 30_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error("Media storage timed out."), {
        name: "TimeoutError",
      });
      controller.abort(error);
      reject(error);
    }, milliseconds);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
