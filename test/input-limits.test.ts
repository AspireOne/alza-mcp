import { describe, expect, it } from "vitest";
import { productSchema, searchSchema } from "../src/domain/inputs.js";

describe("tool input limits", () => {
  it("accepts search filters at the supported collection limit", () => {
    expect(searchSchema.safeParse({ query: "disk", filters: {
      manufacturers: Array(100).fill(1),
      facets: Array.from({ length: 100 }, () => ({ id: 1, values: Array(100).fill("value") })),
      condition: ["new", "opened", "used"],
    } }).success).toBe(true);
  });

  it.each([
    { manufacturers: Array(101).fill(null) },
    { facets: Array(101).fill(null) },
    { facets: [{ id: 1, values: Array(101).fill(null) }] },
    { condition: Array(4).fill(null) },
  ])("rejects oversized filters without validating each element: %j", filters => {
    const parsed = searchSchema.safeParse({ query: "disk", filters });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map(issue => issue.code)).toEqual(["too_big"]);
  });

  it("rejects oversized product section lists before reading their elements", () => {
    const sections = Array(1000);
    Object.defineProperty(sections, 0, { get() { throw new Error("Section was read"); } });
    const parsed = productSchema.safeParse({ product_id: 1, sections });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map(issue => issue.code)).toEqual(["too_big"]);
  });
});
