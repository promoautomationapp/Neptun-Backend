import { directConnection } from "../../src/database/direct-connection";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { belgradeMonth, cacheKey } from "../../src/modules/ai/domain/request";
import { safeTextSuggestion } from "../../src/worker/ai/provider";
test("Belgrade calendar month includes daylight-saving offset", () => {
  expect(belgradeMonth(new Date("2026-03-31T22:30:00Z"))).toBe("2026-04");
  expect(belgradeMonth(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11");
});
test("cache keys are stable by object order and scoped to organization", () => {
  const base = {
    organizationId: "a",
    operation: "proofread" as const,
    sourceSha256: null,
    params: { b: 1, a: "text" },
    model: "gpt-4o-mini",
    quality: null,
    promptVersion: "1",
  };
  expect(cacheKey(base)).toBe(
    cacheKey({ ...base, params: { a: "text", b: 1 } }),
  );
  expect(cacheKey(base)).not.toBe(cacheKey({ ...base, organizationId: "b" }));
});
test("proofreading protects identity, numbers and HTML", () => {
  expect(
    safeTextSuggestion(
      'Tevelizor Samsung 55"',
      'Televizor Samsung 55"',
      "Samsung",
    ),
  ).toBe(true);
  expect(safeTextSuggestion('Samsung 55"', 'Samsung 65"', "Samsung")).toBe(
    false,
  );
  expect(safeTextSuggestion("<b>Tevelizor</b>", "Televizor")).toBe(false);
});
test("HTTP modules and query handlers cannot call the OpenAI provider", () => {
  const files = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(resolve(directory, entry.name))
        : [resolve(directory, entry.name)],
    );
  for (const path of files(resolve("src/modules")).filter((x) =>
    x.endsWith(".ts"),
  )) {
    const text = readFileSync(path, "utf8");
    expect(text).not.toMatch(
      /from ['"][^'"]*(?:worker\/ai|provider)['"]|api\.openai\.com|new OpenAiProvider/,
    );
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isClassDeclaration(node) &&
        ts
          .getDecorators(node)
          ?.some((x) => x.getText(source).startsWith("@QueryHandler"))
      ) {
        const body = node.getText(source);
        expect(body).not.toMatch(
          /\.enqueue\(|\.accept\(|\.run\(|CommandBus|\.execute\(new .*Command/,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("worker and backup session features require the direct Neon connection", () => {
  const pooled =
    "postgresql://user:password@ep-example-pooler.eu-central-1.aws.neon.tech/neondb";
  const direct =
    "postgresql://user:password@ep-example.eu-central-1.aws.neon.tech/neondb";
  expect(() => directConnection(pooled)).toThrow("DIRECT_DATABASE_URL");
  expect(directConnection(pooled, direct)).toBe(direct);
  expect(directConnection("postgresql://localhost/neptun_studio")).toBe(
    "postgresql://localhost/neptun_studio",
  );
  expect(() =>
    directConnection(pooled, "postgresql://localhost/another_database"),
  ).toThrow("same database");
});
