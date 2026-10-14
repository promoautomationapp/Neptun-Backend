import {
  normalizeSearch,
  searchWords,
} from "../../src/modules/products/domain/search";
describe("catalog normalization", () => {
  test.each([
    ["Samsung 55", "samsung55"],
    ["QE-55Q60D", "qe55q60d"],
    ["qe 55 q60d", "qe55q60d"],
    ["çajnik", "cajnik"],
    ["PËRMASAT / 55.0", "permasat550"],
  ])("%s → %s", (input, expected) =>
    expect(normalizeSearch(input)).toBe(expected),
  );
  test("keeps individual words for reordered name searches", () =>
    expect(searchWords(" TV Samsung / 55 ")).toEqual(["tv", "samsung", "55"]));
});
