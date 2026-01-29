import { describe, expect, it } from "vitest";
import { parseCsv, serializeCsv } from "@shared/csv";

describe("csv", () => {
  it("parses headers and rows", () => {
    const input = "url,post\nhttps://example.com,Hello";
    const result = parseCsv(input);
    expect(result.headers).toEqual(["url", "post"]);
    expect(result.rows).toEqual([{ url: "https://example.com", post: "Hello" }]);
  });

  it("serializes rows", () => {
    const csv = serializeCsv(
      ["url", "post"],
      [{ url: "https://example.com", post: "Hello, world" }],
    );
    expect(csv).toContain('"Hello, world"');
  });
});
