import { withPasswordWork } from "../../src/security/password-work";

test("only two costly password jobs start; rejected work never enters a wait queue", async () => {
  let firstDone!: () => void, secondDone!: () => void;
  const first = withPasswordWork(
    () =>
      new Promise<void>((resolve) => {
        firstDone = resolve;
      }),
  );
  const second = withPasswordWork(
    () =>
      new Promise<void>((resolve) => {
        secondDone = resolve;
      }),
  );
  const forbidden = jest.fn(async () => "never");
  try {
    await expect(withPasswordWork(forbidden)).rejects.toMatchObject({
      status: 429,
      response: { code: "PASSWORD_WORK_BUSY", retryAfterSeconds: 1 },
    });
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    firstDone();
    secondDone();
    await Promise.all([first, second]);
  }
  expect(await withPasswordWork(async () => "available")).toBe("available");
  expect(forbidden).not.toHaveBeenCalled();
});
test("slots are released after both synchronous and asynchronous failures", async () => {
  await expect(
    withPasswordWork(() => {
      throw new Error("synchronous failure");
    }),
  ).rejects.toThrow("synchronous failure");
  await expect(
    withPasswordWork(async () => {
      throw new Error("asynchronous failure");
    }),
  ).rejects.toThrow("asynchronous failure");
  let finish!: () => void;
  const first = withPasswordWork(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    expect(await withPasswordWork(async () => "second slot available")).toBe(
      "second slot available",
    );
  } finally {
    finish();
    await first;
  }
});
