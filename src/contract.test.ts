import { describe, expect, it } from "vitest";
import { StatusEventSchema, WIDGET_STATUSES } from "./contract";

describe("StatusEventSchema", () => {
  it("accepts a valid event", () => {
    const e = {
      sessionId: "s1",
      status: "waiting",
      projectLabel: "widget",
      updatedAt: 123,
    };
    expect(StatusEventSchema.parse(e)).toEqual(e);
  });
  it("rejects an unknown status", () => {
    expect(() =>
      StatusEventSchema.parse({
        sessionId: "s1",
        status: "nope",
        projectLabel: "x",
        updatedAt: 1,
      })
    ).toThrow();
  });
  it("rejects a missing field", () => {
    expect(() =>
      StatusEventSchema.parse({ sessionId: "s1", status: "waiting" })
    ).toThrow();
  });
  it("exposes the four statuses", () => {
    expect(WIDGET_STATUSES).toEqual([
      "permission_required",
      "waiting",
      "thinking",
      "disconnected",
    ]);
  });
});
