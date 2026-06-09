#!/bin/bash
# PostToolUse hook: captures session titles from change_title MCP calls.
# Writes to ~/.happy/session-titles.json for the emitter to read.
#
# Stdin receives JSON: {"session_id":"...","tool_name":"...","tool_input":{...},...}

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

TITLES_FILE="${HOME}/.happy/session-titles.json"
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TITLE=$(echo "$INPUT" | jq -r '.tool_input.title // empty' 2>/dev/null)

if [ -z "$SESSION_ID" ] || [ -z "$TITLE" ]; then
  exit 0
fi

# Atomic update: read existing, merge, write back
if [ -f "$TITLES_FILE" ]; then
  EXISTING=$(cat "$TITLES_FILE" 2>/dev/null)
else
  EXISTING='{}'
fi

echo "$EXISTING" | jq \
  --arg sid "$SESSION_ID" \
  --arg title "$TITLE" \
  --arg ts "$(date +%s)" \
  '.[$sid] = {"title": $title, "updatedAt": ($ts | tonumber)}' \
  > "${TITLES_FILE}.tmp" 2>/dev/null && mv "${TITLES_FILE}.tmp" "$TITLES_FILE"
