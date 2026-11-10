/** PostgreSQL attaches its full client to idle-pool errors. Never serialize
 * arbitrary error properties: they can contain connection/session internals. */
export function serializeLogError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!error || typeof error !== "object")
    return {
      type: "Error",
      message:
        typeof error === "string" ? logText(error, 8_000) : "Unknown error",
    };
  const value = error as Record<string, unknown>;
  const result: Record<string, unknown> = {
    type: typeof value.name === "string" ? logText(value.name, 100) : "Error",
    message:
      typeof value.message === "string"
        ? logText(value.message, 8_000)
        : "Unknown error",
  };
  if (typeof value.stack === "string")
    result.stack = logText(value.stack, 16_000);
  for (const key of ["code", "errno", "syscall"] as const) {
    const field = value[key];
    if (typeof field === "string") result[key] = logText(field, 100);
    else if (typeof field === "number" && Number.isFinite(field))
      result[key] = field;
  }
  if (depth === 0 && value.cause)
    result.cause = serializeLogError(value.cause, 1);
  return result;
}

function logText(value: string, limit: number) {
  return value
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s"'<>]+/gi, "$1[redacted]")
    .slice(0, limit);
}
