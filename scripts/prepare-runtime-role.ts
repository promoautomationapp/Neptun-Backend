import { runtimeRolePlan } from "../src/database/runtime-role-plan";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--grants-only" && !arg.startsWith("--role=")))
    throw new Error(
      "Usage: prepare-runtime-role.ts [--role=neptun_runtime] [--grants-only]. This command only prints SQL; it never executes it.",
    );
  const role = args.find((arg) => arg.startsWith("--role="))?.slice(7);
  process.stdout.write(
    runtimeRolePlan(role, { grantsOnly: args.includes("--grants-only") }),
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Could not prepare the runtime role plan.",
  );
  process.exitCode = 1;
}
