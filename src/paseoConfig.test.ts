import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandTilde, loadConfig } from "./paseoConfig.js";
import process from "node:process";

// Save & restore process.env so tests can mutate freely.
const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PASEO_BASE_URL",
  "PASEO_AGENTS_DIR",
  "POLL_INTERVAL_SEC",
  "IDLE_TTL_MIN",
  "HEALTH_FAILURES_MAX",
];

beforeEach(() => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  // Clean slate so defaults apply cleanly.
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe("expandTilde", () => {
  it("expands a bare ~", () => {
    expect(expandTilde("~")).toBe(process.env.HOME);
  });
  it("expands ~/path", () => {
    expect(expandTilde("~/foo/bar")).toBe(`${process.env.HOME}/foo/bar`);
  });
  it("leaves absolute paths untouched", () => {
    expect(expandTilde("/var/lib/paseo")).toBe("/var/lib/paseo");
  });
  it("leaves relative paths untouched", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});

describe("loadConfig", () => {
  it("applies defaults for optional vars and converts units", () => {
    const cfg = loadConfig({});
    expect(cfg.paseoBaseUrl).toBe("http://127.0.0.1:6767");
    expect(cfg.paseoAgentsDir).toBe(`${process.env.HOME}/.paseo/agents`);
    expect(cfg.pollIntervalMs).toBe(5000); // 5 sec → 5000 ms
    expect(cfg.idleTtlMs).toBe(30 * 60_000); // 30 min → 1,800,000 ms
    expect(cfg.healthFailuresMax).toBe(3);
  });

  it("honors explicit values and converts sec→ms, min→ms", () => {
    const cfg = loadConfig({
      PASEO_BASE_URL: "http://10.0.0.1:7000/",
      PASEO_AGENTS_DIR: "/custom/agents",
      POLL_INTERVAL_SEC: "10",
      IDLE_TTL_MIN: "1",
      HEALTH_FAILURES_MAX: "5",
    });
    expect(cfg.paseoBaseUrl).toBe("http://10.0.0.1:7000"); // trailing slash stripped
    expect(cfg.paseoAgentsDir).toBe("/custom/agents");
    expect(cfg.pollIntervalMs).toBe(10_000);
    expect(cfg.idleTtlMs).toBe(60_000);
    expect(cfg.healthFailuresMax).toBe(5);
  });

  it("expands ~ in PASEO_AGENTS_DIR", () => {
    const cfg = loadConfig({ PASEO_AGENTS_DIR: "~/.paseo/agents" });
    expect(cfg.paseoAgentsDir).toBe(`${process.env.HOME}/.paseo/agents`);
  });

  it("rejects non-numeric POLL_INTERVAL_SEC", () => {
    expect(() => loadConfig({ POLL_INTERVAL_SEC: "soon" })).toThrow(
      /POLL_INTERVAL_SEC/,
    );
  });

  it("rejects zero or negative POLL_INTERVAL_SEC", () => {
    expect(() => loadConfig({ POLL_INTERVAL_SEC: "0" })).toThrow(
      /POLL_INTERVAL_SEC/,
    );
    expect(() => loadConfig({ POLL_INTERVAL_SEC: "-5" })).toThrow(
      /POLL_INTERVAL_SEC/,
    );
  });

  it("rejects non-numeric IDLE_TTL_MIN", () => {
    expect(() => loadConfig({ IDLE_TTL_MIN: "lots" })).toThrow(/IDLE_TTL_MIN/);
  });

  it("rejects negative HEALTH_FAILURES_MAX but allows 0", () => {
    expect(() => loadConfig({ HEALTH_FAILURES_MAX: "-1" })).toThrow(
      /HEALTH_FAILURES_MAX/,
    );
    const cfg = loadConfig({ HEALTH_FAILURES_MAX: "0" });
    expect(cfg.healthFailuresMax).toBe(0);
  });

  it("uses process.env when no argument is provided", () => {
    process.env.PASEO_BASE_URL = "http://custom.example:9999";
    const cfg = loadConfig();
    expect(cfg.paseoBaseUrl).toBe("http://custom.example:9999");
  });
});
