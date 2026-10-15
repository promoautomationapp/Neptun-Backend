import { estimateAiCost } from "../../src/modules/ai/domain/pricing";
test("text cost includes cached input and image-search tools without treating missing historical tool details as zero", () => {
  expect(
    estimateAiCost("gpt-4o-mini", "proofread", {
      inputTokens: 1000,
      outputTokens: 100,
      usageJson: { input_tokens_details: { cached_tokens: 200 } },
    }).costUsd,
  ).toBeCloseTo(0.000195, 8);
  expect(
    estimateAiCost("gpt-4.1-mini", "product_image_search", {
      inputTokens: 1000,
      outputTokens: 100,
      usageJson: { web_search_calls: 2 },
    }).costUsd,
  ).toBeCloseTo(0.02056, 8);
  expect(
    estimateAiCost("gpt-4.1-mini", "product_image_search", {
      inputTokens: 1000,
      outputTokens: 100,
    }),
  ).toMatchObject({ costUsd: null, basis: "partial", maximumUsd: null });
});
test("image token modalities use separate rates and old totals are presented as a range", () => {
  expect(
    estimateAiCost("gpt-image-2.5-sunburst", "cutout", {
      inputTokens: 1000,
      outputTokens: 2000,
      usageJson: {
        input_tokens_details: { text_tokens: 200, image_tokens: 800 },
      },
    }),
  ).toMatchObject({ costUsd: 0.0674, basis: "estimated" });
  expect(
    estimateAiCost("gpt-image-2.5-sunburst", "cutout", {
      inputTokens: 1000,
      outputTokens: 2000,
    }),
  ).toMatchObject({
    costUsd: null,
    minimumUsd: 0.065,
    maximumUsd: 0.068,
    basis: "range",
  });
  expect(
    estimateAiCost("unknown", "cutout", {
      inputTokens: 1000,
      outputTokens: 2000,
    }).basis,
  ).toBe("unknown");
  expect(
    estimateAiCost("gpt-image-2.5-sunburst", "cutout", {
      inputTokens: null,
      outputTokens: null,
    }).costUsd,
  ).toBeNull();
});
