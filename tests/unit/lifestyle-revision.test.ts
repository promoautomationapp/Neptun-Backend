import { normalizeAiParams } from "../../src/modules/ai/domain/params";
test("lifestyle revisions retain their reference asset and wallpaper context in the cache identity", () => {
  expect(normalizeAiParams("lifestyle", { prompt: " Softer light ", image: "/api/assets/reference", context: "tv", orientation: "landscape" })).toEqual({ prompt: "Softer light", image: "/api/assets/reference", context: "tv", orientation: "landscape", products: [] });
});
