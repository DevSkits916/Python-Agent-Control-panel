import { describe, expect, it } from "vitest";
import { validateMessage } from "@shared/schema";

describe("schema validation", () => {
  it("accepts valid messages", () => {
    const message = {
      type: "CONTROL_PAUSE_RUN",
      payload: { runId: "run-123" },
    };
    expect(validateMessage(message)).toBe(true);
  });

  it("rejects invalid messages", () => {
    const message = {
      type: "CONTROL_PAUSE_RUN",
      payload: {},
    };
    expect(validateMessage(message)).toBe(false);
  });
});
