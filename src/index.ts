import { BackendSender } from "./sender.js";
import { ClaudePoller } from "./claudePoller.js";
import { OpencodePoller } from "./opencodePoller.js";
import { paseoSessionIds } from "./paseoAgents.js";
import process from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";

const backendUrl = process.env.BACKEND_URL;
const accountToken = process.env.ACCOUNT_TOKEN;
if (!backendUrl || !accountToken) {
  console.error("BACKEND_URL and ACCOUNT_TOKEN are required");
  process.exit(1);
}

const sender = new BackendSender({ backendUrl, accountToken });

// Standalone Claude Code sessions — disabled via CLAUDE_POLLER=0.
const claudePoller = process.env.CLAUDE_POLLER === "0"
  ? null
  : new ClaudePoller({
    statePath: join(homedir(), ".local", "state", "agentdash-emitter", "claude-known.json"),
  });
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
  // Sessions run by Paseo agents are reported by the agentdash Paseo plugin.
  opencodePoller = new OpencodePoller({ excludeSessionIds: () => paseoSessionIds() });
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

console.log(
  `[emitter] started; backend=${backendUrl} claudePoller=${
    claudePoller ? "on" : "off"
  } opencodePoller=${opencodePoller ? "on" : "off"}`,
);

const shutdown = () => {
  console.log("[emitter] shutting down");
  claudePoller?.stop();
  opencodePoller?.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
