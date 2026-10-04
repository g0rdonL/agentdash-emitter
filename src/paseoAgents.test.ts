import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { paseoSessionIds } from "./paseoAgents.js";

describe("paseoSessionIds", () => {
  it("collects persistence.sessionId across project dirs, skipping bad files", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-agents-"));
    mkdirSync(join(dir, "Users-gordon"));
    mkdirSync(join(dir, "Users-gordon-dev-x"));
    writeFileSync(join(dir, "Users-gordon", "a.json"),
      JSON.stringify({ provider: "claude", persistence: { sessionId: "68c30d0a" } }));
    writeFileSync(join(dir, "Users-gordon-dev-x", "b.json"),
      JSON.stringify({ provider: "opencode", persistence: { sessionId: "ses_abc" } }));
    writeFileSync(join(dir, "Users-gordon-dev-x", "c.json"), "{not json");
    writeFileSync(join(dir, "Users-gordon-dev-x", "d.json"), JSON.stringify({ persistence: {} }));
    writeFileSync(join(dir, "Users-gordon-dev-x", "notes.txt"), "ignored");
    expect([...paseoSessionIds(dir)].sort()).toEqual(["68c30d0a", "ses_abc"]);
  });

  it("returns an empty set when the agents dir is missing", () => {
    expect(paseoSessionIds("/nonexistent/paseo/agents").size).toBe(0);
  });
});
