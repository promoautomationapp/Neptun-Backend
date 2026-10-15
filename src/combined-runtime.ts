export interface CombinedRuntimeOptions {
  apiArgs?: string[];
  workerArgs?: string[];
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/** Standalone so the same supervisor can run from Render's start command. */
export function startCombined(options: CombinedRuntimeOptions = {}): void {
  const { spawn } = process.getBuiltinModule("child_process");
  const { createInterface } = process.getBuiltinModule("readline");
  const children = new Set<ReturnType<typeof spawn>>();
  let stopping = false;
  let ready = false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    if (!children.size && stopping) {
      clearTimeout(forceStop);
      process.exit(process.exitCode === 0 ? 0 : 1);
    }
  };
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    clearTimeout(startup);
    for (const child of children) child.kill("SIGTERM");
    forceStop = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, options.shutdownTimeoutMs ?? 35_000);
    forceStop.unref();
    finish();
  };
  const launch = (name: string, args: string[], worker = false) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", worker ? "pipe" : "inherit", "inherit"],
      env: worker
        ? { ...process.env, UV_THREADPOOL_SIZE: "1", MALLOC_ARENA_MAX: "2" }
        : process.env,
    });
    children.add(child);
    child.once("error", (error) => {
      console.error(`Neptun ${name} could not start: ${error.message}`);
      stop(1);
    });
    child.once("close", (code, signal) => {
      children.delete(child);
      if (!stopping) {
        console.error(
          `Neptun ${name} exited unexpectedly (${code ?? signal}).`,
        );
        stop(1);
      }
      finish();
    });
    return child;
  };
  const startup = setTimeout(() => {
    console.error(
      "Neptun worker did not become ready before the startup deadline.",
    );
    stop(1);
  }, options.startupTimeoutMs ?? 120_000);
  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));

  const worker = launch(
    "worker",
    options.workerArgs ?? [
      "--max-old-space-size=160",
      "-e",
      'const sharp=require("sharp");sharp.cache({memory:16,files:0,items:50});sharp.concurrency(1);require("./dist/src/worker.js");',
    ],
    true,
  );
  const lines = createInterface({ input: worker.stdout! });
  lines.on("line", (line) => {
    console.log(line);
    if (line.includes("Worker startup failed")) stop(1);
    if (
      !ready &&
      !stopping &&
      line.includes("Neptun worker connected to PostgreSQL")
    ) {
      ready = true;
      clearTimeout(startup);
      console.log("Neptun combined runtime: worker ready; starting API.");
      launch(
        "API",
        options.apiArgs ?? ["--max-old-space-size=192", "dist/src/main.js"],
      );
    }
  });
}
