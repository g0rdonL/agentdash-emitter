import { describe, expect, it } from "vitest";
import {
  parseCredentials,
  parsePersistedSessions,
  projectLabel,
} from "./happyFiles";

describe("projectLabel", () => {
  it("takes the last path segment", () => {
    expect(projectLabel("/Users/me/dev/agent-status-widget")).toBe(
      "agent-status-widget",
    );
  });
  it("handles a trailing slash", () => {
    expect(projectLabel("/Users/me/dev/happy/")).toBe("happy");
  });
  it('falls back to "unknown" for empty input', () => {
    expect(projectLabel("")).toBe("unknown");
  });
});

describe("parseCredentials", () => {
  it("parses dataKey credentials", () => {
    const json = JSON.stringify({
      token: "tok",
      encryption: { publicKey: "AAAA", machineKey: "BBBB" },
    });
    const c = parseCredentials(json);
    expect(c).toEqual({ token: "tok", encryptionVariant: "dataKey" });
  });
  it("parses legacy credentials", () => {
    const json = JSON.stringify({ token: "tok", secret: "CCCC" });
    const c = parseCredentials(json);
    expect(c).toEqual({ token: "tok", encryptionVariant: "legacy" });
  });
  it("throws on malformed credentials", () => {
    expect(() => parseCredentials('{"nope":1}')).toThrow();
  });
});

describe("parsePersistedSessions", () => {
  it("extracts id, encryptionKey, variant, and project label", () => {
    const json = JSON.stringify({
      sessions: {
        s1: {
          encryptionKey: "KEY1",
          encryptionVariant: "dataKey",
          metadata: { path: "/Users/me/dev/happy" },
          savedAt: 1,
        },
        s2: {
          encryptionKey: "KEY2",
          encryptionVariant: "legacy",
          metadata: { path: "/Users/me/dev/widget/" },
          savedAt: 2,
        },
      },
    });
    const sessions = parsePersistedSessions(json).sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId)
    );
    expect(sessions).toEqual([
      {
        sessionId: "s1",
        encryptionKey: "KEY1",
        encryptionVariant: "dataKey",
        projectLabel: "happy",
      },
      {
        sessionId: "s2",
        encryptionKey: "KEY2",
        encryptionVariant: "legacy",
        projectLabel: "widget",
      },
    ]);
  });
  it("returns [] for a missing/empty sessions object", () => {
    expect(parsePersistedSessions("{}")).toEqual([]);
  });
});
