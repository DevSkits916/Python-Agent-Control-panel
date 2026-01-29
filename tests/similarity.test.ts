import { describe, expect, it } from "vitest";
import { jaccardSimilarity, pickNextPost } from "@shared/similarity";

describe("similarity", () => {
  it("detects high similarity", () => {
    const score = jaccardSimilarity("Hello world", "Hello world!!");
    expect(score).toBeGreaterThan(0.8);
  });

  it("selects a non-duplicate post", () => {
    const pool = ["A quick update", "A quick update", "Different news"];
    const result = pickNextPost(pool, ["A quick update"]);
    expect(result.value).toBe("Different news");
  });
});
