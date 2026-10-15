import type { JsonObject } from "../../../shared/json";

// Standard USD rates verified against official OpenAI documentation on 2026-10-15.
export const PRICING_VERSION = "openai-standard-2026-10-15";
export const PRICING_URL = "https://developers.openai.com/api/docs/pricing";
export interface UsageNumbers {
  inputTokens: number | null;
  outputTokens: number | null;
  usageJson?: JsonObject;
}
export function estimateAiCost(
  model: string,
  operation: string,
  usage: UsageNumbers,
) {
  const input = usage.inputTokens,
    output = usage.outputTokens;
  const raw = usage.usageJson ?? {};
  if (input === null || output === null)
    return {
      costUsd: null,
      minimumUsd: null,
      maximumUsd: null,
      basis: "unknown" as const,
    };
  const details = raw.input_tokens_details as JsonObject | undefined;
  const cached = Number(details?.cached_tokens ?? 0);
  let minimum: number, maximum: number;
  const text = /^gpt-4o-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
    ? [0.15, 0.075, 0.6]
    : /^gpt-4\.1-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
      ? [0.4, 0.1, 1.6]
      : null;
  if (text) {
    minimum = maximum =
      ((input - Math.min(input, cached)) * text[0]! +
        Math.min(input, cached) * text[1]! +
        output * text[2]!) /
      1e6;
  } else {
    const rate = /^gpt-image-2\.5-(sunburst|flare)$/.test(model)
      ? [5, 8, 30]
      : model === "gpt-image-1.5"
        ? [5, 8, 32]
        : model === "gpt-image-1"
          ? [5, 10, 40]
          : null;
    if (!rate)
      return {
        costUsd: null,
        minimumUsd: null,
        maximumUsd: null,
        basis: "unknown" as const,
      };
    const textInput = Number(details?.text_tokens),
      imageInput = Number(details?.image_tokens);
    if (
      Number.isFinite(textInput) &&
      Number.isFinite(imageInput) &&
      textInput + imageInput === input &&
      cached === 0
    ) {
      minimum = maximum =
        (textInput * rate[0]! + imageInput * rate[1]! + output * rate[2]!) /
        1e6;
    } else {
      minimum =
        (input * Math.min(rate[0]!, rate[1]!) + output * rate[2]!) / 1e6;
      maximum =
        (input * Math.max(rate[0]!, rate[1]!) + output * rate[2]!) / 1e6;
      // Missing modality/cache detail cannot be presented as an exact cost.
      if (cached > 0) minimum = (output * rate[2]!) / 1e6;
    }
  }
  const searchCalls = raw.web_search_calls;
  if (operation === "product_image_search") {
    if (typeof searchCalls !== "number")
      return {
        costUsd: null,
        minimumUsd: minimum,
        maximumUsd: null,
        basis: "partial" as const,
      };
    minimum += searchCalls * 0.01;
    maximum += searchCalls * 0.01;
  }
  const round = (value: number) => Number(value.toFixed(8));
  return {
    costUsd: minimum === maximum ? round(minimum) : null,
    minimumUsd: round(minimum),
    maximumUsd: round(maximum),
    basis: minimum === maximum ? ("estimated" as const) : ("range" as const),
  };
}
