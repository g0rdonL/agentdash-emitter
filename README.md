# AgentDash Emitter

Runs on the user's Mac. Reads local Happy session status, derives a coarse
status (`thinking | waiting | permission_required | disconnected`), and POSTs
`{ sessionId, status, projectLabel, updatedAt }` to the backend. **No message
text, code, or keys ever leave the machine** — decryption is local.

## Run
1. `cp .env.example .env` and set `BACKEND_URL` + `ACCOUNT_TOKEN` (the same
   token the backend uses). Optionally set `HAPPY_SERVER_URL`
   (defaults to `https://api.cluster-fluster.com`).
2. Make sure you are logged into Happy on this machine (`~/.happy/access.key`
   and `~/.happy/sessions.json` exist).
3. `npm install && npm run dev`

## How it reads Happy (local only)
- Bearer token from `~/.happy/access.key`.
- Project labels + per-session keys from `~/.happy/sessions.json` (plaintext metadata).
- Live state via a user-scoped Socket.IO client to `{HAPPY_SERVER_URL}/v1/updates`.
- `agentState` is decrypted locally with the vendored `encryption.ts`.

## Test
`npx vitest run`
