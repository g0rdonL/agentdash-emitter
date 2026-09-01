# AgentDash Emitter

The companion daemon for [AgentDash](https://agentdash.gordonlee.xyz) — the
Android home-screen widget for your AI coding agents' status & usage limits.

Runs on your own machine. Reads local Happy/Claude Code/OpenCode/Paseo
session status, derives a coarse status
(`thinking | waiting | permission_required | disconnected`), and POSTs
`{ sessionId, status, projectLabel, updatedAt }` to your AgentDash account's
backend. **No message text, code, or prompts ever leave your machine** —
only session status metadata; any decryption needed to read that metadata is
done locally.

Get your account/API key by signing in at
[agentdash.gordonlee.xyz](https://agentdash.gordonlee.xyz) and creating a
key under API Keys.

## Run

1. `cp .env.example .env` and set `BACKEND_URL` + `ACCOUNT_TOKEN` (the same
   token the backend uses). Optionally set `HAPPY_SERVER_URL` (defaults to
   `https://api.cluster-fluster.com`).
2. Make sure you are logged into Happy on this machine (`~/.happy/access.key`
   and `~/.happy/sessions.json` exist).
3. `npm install && npm run dev`

## How it reads Happy (local only)

- Bearer token from `~/.happy/access.key`.
- Project labels + per-session keys from `~/.happy/sessions.json` (plaintext
  metadata).
- Live state via a user-scoped Socket.IO client to
  `{HAPPY_SERVER_URL}/v1/updates`.
- `agentState` is decrypted locally with the vendored `encryption.ts`.

## Test

`npx vitest run`
