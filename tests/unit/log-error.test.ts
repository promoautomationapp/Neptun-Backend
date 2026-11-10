import { serializeLogError } from "../../src/shared/log-error";

test("queue errors keep useful diagnostics without serializing attached PostgreSQL clients", () => {
  const client: Record<string, unknown> = {
    connectionParameters: { password: "must-not-log", host: "private-host" },
    secretKey: 123456,
  };
  client.self = client;
  const error = Object.assign(new Error("read ECONNABORTED"), {
    code: "ECONNABORTED",
    errno: -103,
    syscall: "read",
    client,
  });
  const serialized = serializeLogError(error);
  expect(serialized).toMatchObject({
    type: "Error",
    message: "read ECONNABORTED",
    code: "ECONNABORTED",
    errno: -103,
    syscall: "read",
  });
  expect(serialized.stack).toContain("ECONNABORTED");
  expect(serialized).not.toHaveProperty("client");
  expect(JSON.stringify(serialized)).not.toMatch(
    /must-not-log|private-host|secretKey/,
  );
});

test("connection URLs and nested client internals stay out of error diagnostics", () => {
  const error = new Error(
    "Cannot connect to postgres://runtime:password@private-host/database",
  );
  error.cause = Object.assign(new Error("socket ended"), {
    client: { secretKey: 123 },
    cause: error,
  });
  const serialized = serializeLogError(error);
  expect(serialized.message).toBe("Cannot connect to postgres://[redacted]");
  expect(JSON.stringify(serialized)).not.toMatch(
    /password|private-host|secretKey/,
  );
  expect(serialized.cause).toMatchObject({ message: "socket ended" });
  expect(serialized.cause).not.toHaveProperty("cause");
});

test("untrusted error payloads are bounded and do not traverse arbitrary properties", () => {
  expect(
    serializeLogError({
      message: "x".repeat(20_000),
      request: { token: "private" },
    }).message,
  ).toHaveLength(8_000);
  expect(serializeLogError(null)).toEqual({
    type: "Error",
    message: "Unknown error",
  });
});
