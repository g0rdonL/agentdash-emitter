import { HappyAdapter } from "./adapter.js";
import { BackendSender } from "./sender.js";
import { loadCredentials } from "./happyFiles.js";
import { ClaudePoller } from "./claudePoller.js";
import { OpencodePoller } from "./opencodePoller.js";
import { McpSource } from "./paseoMcp.js";
import { DiskSource } from "./paseoDisk.js";
import { TransitionTracker } from "./paseoTracker.js";
import { loadConfig as loadPaseoConfig } from "./paseoConfig.js";
import type { StatusEvent } from "./contract.js";
import type { SourceResult } from "./paseoTypes.js";
import process from "node:process";

const backendUrl = process.env.BACKEND_URL;
const accountToken = process.env.ACCOUNT_TOKEN;
if (!backendUrl || !accountToken) {
  console.error("BACKEND_URL and ACCOUNT_TOKEN are required");
  process.exit(1);
}
const happyServerUrl = process.env.HAPPY_SERVER_URL ??
  "https://api.cluster-fluster.com";

// The socket auth uses the user's OWN Happy token from ~/.happy/access.key.
// Happy was removed 2026-10-03; without the key, skip the adapter instead of
// crash-looping so the Claude/OpenCode pollers keep running.
let adapter: HappyAdapter | null = null;
try {
  const happyToken = loadCredentials().token;
  adapter = new HappyAdapter({
    serverUrl: happyServerUrl,
    accountToken: happyToken,
  });
} catch (err) {
  console.log(`[emitter] happy=off (${(err as Error).message})`);
}

const sender = new BackendSender({ backendUrl, accountToken });

adapter?.start((event) => {
  sender.sendEvent(event).catch((err) => {
    console.error(
      `[emitter] failed to send event for ${event.sessionId}:`,
      err,
    );
  });
  console.log(
    `[emitter] ${event.projectLabel} ${event.sessionId} -> ${event.status}`,
  );
});

// Standalone Claude Code sessions (not under Happy) — disabled via CLAUDE_POLLER=0.
const claudePoller = process.env.CLAUDE_POLLER === "0"
  ? null
  : new ClaudePoller();
claudePoller?.start((event) => {
  sender.sendEvent(event).catch((err) => {
    console.error(
      `[emitter] failed to send claude event for ${event.sessionId}:`,
      err,
    );
  });
  console.log(
    `[emitter/claude] ${event.projectLabel} ${event.sessionId} -> ${event.status}`,
  );
});

// ── OpenCode sessions ───────────────────────────────────────────────
// Local OpenCode sqlite store — disabled by default (OPENCODE_POLLER_ENABLED=1).
let opencodePoller: OpencodePoller | null = null;
if (process.env.OPENCODE_POLLER_ENABLED === "1") {
  opencodePoller = new OpencodePoller();
  opencodePoller.start((event) => {
    sender.sendEvent(event).catch((err) => {
      console.error(
        `[emitter/opencode] failed to send event for ${event.sessionId}:`,
        err,
      );
    });
    console.log(
      `[emitter/opencode] ${event.projectLabel} ${event.sessionId} -> ${event.status}`,
    );
  });
} else {
  console.log("[emitter] opencodePoller=off (OPENCODE_POLLER_ENABLED!=1)");
}

// ── Paseo agent poller ──────────────────────────────────────────────

let paseoTimer: ReturnType<typeof setTimeout> | null = null;
let paseoStopped = false;
const paseoEnabled = process.env.PASEO_POLLER !== "0";

if (paseoEnabled) {
  const paseoConfig = loadPaseoConfig();

  const mcpSource = new McpSource({
    baseUrl: paseoConfig.paseoBaseUrl,
    agentsDir: paseoConfig.paseoAgentsDir,
  });
  const diskSource = new DiskSource({ agentsDir: paseoConfig.paseoAgentsDir });

  const tracker = new TransitionTracker({
    idleTtlMs: paseoConfig.idleTtlMs,
    healthFailuresMax: paseoConfig.healthFailuresMax,
  });

  function dispatch(events: StatusEvent[]): void {
    for (const e of events) {
      sender.sendEvent(e).catch((err) => {
        console.error(
          `[emitter/paseo] failed to send event for ${e.sessionId}:`,
          err,
        );
      });
      console.log(
        `[emitter/paseo] ${e.projectLabel} ${e.sessionId} -> ${e.status}`,
      );
    }
  }

  async function tick(): Promise<void> {
    let result: SourceResult;
    try {
      result = await mcpSource.poll();
    } catch (err) {
      console.error("[emitter/paseo] mcp poll threw:", err);
      result = { ok: false, reason: "error", detail: String(err) };
    }

    if (result.ok) {
      dispatch(tracker.update(result.agents));
      return;
    }

    if (result.reason === "daemon-down") {
      dispatch(tracker.recordFailure());
      return;
    }

    // `auth` or `error` — fall back to disk for this tick.
    const disk = await diskSource.poll().catch((err) => {
      console.error("[emitter/paseo] disk fallback poll failed:", err);
      return null;
    });
    if (disk && disk.ok) {
      dispatch(tracker.update(disk.agents));
    } else if (disk && !disk.ok) {
      dispatch(tracker.recordFailure());
    }
  }

  async function loop(): Promise<void> {
    try {
      await tick();
    } catch (err) {
      console.error("[emitter/paseo] tick failed:", err);
    } finally {
      if (!paseoStopped) {
        paseoTimer = setTimeout(loop, paseoConfig.pollIntervalMs);
      }
    }
  }

  void loop();

  console.log(
    `[emitter] paseoPoller=on; paseo=${paseoConfig.paseoBaseUrl} agentsDir=${paseoConfig.paseoAgentsDir} poll=${paseoConfig.pollIntervalMs}ms idleTtl=${paseoConfig.idleTtlMs}ms failMax=${paseoConfig.healthFailuresMax}`,
  );
} else {
  console.log("[emitter] paseoPoller=off (PASEO_POLLER=0)");
}

// ────────────────────────────────────────────────────────────────────

console.log(
  `[emitter] started; Happy=${adapter ? happyServerUrl : "off"} backend=${backendUrl} claudePoller=${
    claudePoller ? "on" : "off"
  } opencodePoller=${opencodePoller ? "on" : "off"} paseoPoller=${
    paseoEnabled ? "on" : "off"
  }`,
);

const shutdown = () => {
  console.log("[emitter] shutting down");
  adapter?.stop();
  claudePoller?.stop();
  opencodePoller?.stop();
  paseoStopped = true;
  if (paseoTimer) clearTimeout(paseoTimer);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
