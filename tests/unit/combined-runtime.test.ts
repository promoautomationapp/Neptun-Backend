import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  startCombined,
  type CombinedRuntimeOptions,
} from "../../src/combined-runtime";

const ready = 'console.log("Neptun worker connected to PostgreSQL");';
const keepAlive = "setInterval(()=>{},1000);";
const terminate = (name: string) =>
  `process.on("SIGTERM",()=>{console.log("${name}-stopped");process.exit(0)});`;

function run(
  worker: string,
  api: string,
  overrides: CombinedRuntimeOptions = {},
) {
  const options: CombinedRuntimeOptions = {
    workerArgs: ["-e", worker],
    apiArgs: ["-e", api],
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
    ...overrides,
  };
  const child = spawn(
    process.execPath,
    ["-e", `(${startCombined.toString()})(${JSON.stringify(options)})`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const ended = once(child, "close").then(([code]) => ({ code, output }));
  const until = async (text: string) => {
    const deadline = Date.now() + 3_000;
    while (!output.includes(text)) {
      if (Date.now() > deadline) throw new Error(`Missing ${text}: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { child, ended, until };
}

test("API starts after worker readiness and SIGTERM stops both children", async () => {
  const running = run(
    `${terminate("worker")}${ready}${keepAlive}`,
    `${terminate("api")}console.log("api-ready");${keepAlive}`,
  );
  try {
    await running.until("api-ready");
    running.child.kill("SIGTERM");
    const result = await running.ended;
    expect(result.code).toBe(0);
    expect(result.output).toContain("worker-stopped");
    expect(result.output).toContain("api-stopped");
    expect(result.output.indexOf("worker ready")).toBeLessThan(
      result.output.indexOf("api-ready"),
    );
  } finally {
    running.child.kill("SIGKILL");
  }
});

test.each([0, 23])(
  "worker exit %i stops the API and fails the service",
  async (code) => {
    const running = run(
      `${ready}setTimeout(()=>process.exit(${code}),250);`,
      `${terminate("api")}${keepAlive}`,
    );
    const result = await running.ended;
    expect(result.code).toBe(1);
    expect(result.output).toContain("api-stopped");
    expect(result.output).toContain("worker exited unexpectedly");
  },
);

test("repeated shutdown signals allow the worker to finish draining", async () => {
  const running = run(
    `process.on("SIGTERM",()=>setTimeout(()=>{console.log("worker-stopped");process.exit(0)},150));${ready}${keepAlive}`,
    `${terminate("api")}console.log("api-ready");${keepAlive}`,
  );
  await running.until("api-ready");
  running.child.kill("SIGTERM");
  await running.until("api-stopped");
  running.child.kill("SIGTERM");
  const result = await running.ended;
  expect(result.code).toBe(0);
  expect(result.output).toContain("worker-stopped");
});

test("API failure stops the worker", async () => {
  const running = run(
    `${terminate("worker")}${ready}${keepAlive}`,
    "process.exit(8);",
  );
  const result = await running.ended;
  expect(result.code).toBe(1);
  expect(result.output).toContain("worker-stopped");
});

test("fatal worker startup never exposes a healthy API", async () => {
  const running = run(
    `console.log("Worker startup failed");${keepAlive}`,
    'console.log("api-started");',
  );
  const result = await running.ended;
  expect(result.code).toBe(1);
  expect(result.output).not.toContain("api-started");
});

test("worker startup deadline stops a hung process", async () => {
  const running = run(keepAlive, 'console.log("api-started");', {
    startupTimeoutMs: 100,
  });
  const result = await running.ended;
  expect(result.code).toBe(1);
  expect(result.output).toContain("startup deadline");
  expect(result.output).not.toContain("api-started");
});

test("shutdown deadline terminates children that ignore SIGTERM", async () => {
  const running = run(
    `process.on("SIGTERM",()=>{});${ready}${keepAlive}`,
    "process.exit(1);",
    { shutdownTimeoutMs: 100 },
  );
  const result = await running.ended;
  expect(result.code).toBe(1);
});
