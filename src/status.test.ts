import { describe, expect, it } from "vitest";
import { deriveStatus } from "./status";

describe("deriveStatus", () => {
  it("maps inactive sessions to disconnected", () => {
    expect(
      deriveStatus({ active: false, thinking: true, pendingRequestCount: 2 }),
    ).toBe("disconnected");
  });
  it("prefers permission_required when there are pending requests (even while thinking)", () => {
    expect(
      deriveStatus({ active: true, thinking: true, pendingRequestCount: 1 }),
    ).toBe("permission_required");
  });
  it("maps active + thinking + no requests to thinking", () => {
    expect(
      deriveStatus({ active: true, thinking: true, pendingRequestCount: 0 }),
    ).toBe("thinking");
  });
  it("maps active + not thinking + no requests to waiting", () => {
    expect(
      deriveStatus({ active: true, thinking: false, pendingRequestCount: 0 }),
    ).toBe("waiting");
  });
});
