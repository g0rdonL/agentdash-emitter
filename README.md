# AgentDash Emitter

The companion daemon for [AgentDash](https://agentdash.gordonlee.xyz) — the
Android home-screen widget for your AI coding agents' status & usage limits.

Runs on your own machine. Reads local Claude Code / OpenCode session
status, derives a coarse status
(`thinking | waiting | permission_required | disconnected`), and POSTs
`{ sessionId, status, projectLabel, updatedAt }` to your AgentDash account's
backend. **No message text, code, or prompts ever leave your machine** —
only session status metadata.

Get your account/API key by signing in at
[agentdash.gordonlee.xyz](https://agentdash.gordonlee.xyz) and creating a
key under API Keys.

## Run

1. `cp .env.example .env` and set `BACKEND_URL` + `ACCOUNT_TOKEN` (the same
   token the backend uses).
2. `npm install && npm run dev`

## Sources

- **Claude Code** (`~/.claude/projects`): reports process-backed sessions as
  `thinking`; emits one `disconnected` when the process exits. Disable with
  `CLAUDE_POLLER=0`.
- **OpenCode** (local sqlite store): opt in with
  `OPENCODE_POLLER_ENABLED=1`.

## Test

`npx vitest run`
