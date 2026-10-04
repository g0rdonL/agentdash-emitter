#!/bin/bash
# AgentDash emitter watchdog: DM Gordon (Lark, Ops bot via notify.sh) when the
# emitter stops reaching the backend, and again when it recovers.
#
# Signal: snapshot.emitterLastSeenAt, which every emitter ping/event refreshes
# (the emitter pings every 60s even with zero sessions). Credentials are read
# from the installed emitter plist at run time; nothing is stored or printed.
#
# Env overrides (for testing): AGE_LIMIT_S (default 600), STATE_FILE,
# REMIND_S (default 21600), NOTIFY.

set -uo pipefail

PLIST="${PLIST:-$HOME/Library/LaunchAgents/ink.agentdash.emitter.plist}"
STATE_FILE="${STATE_FILE:-$HOME/.local/state/agentdash-emitter/watchdog.state}"
AGE_LIMIT_S="${AGE_LIMIT_S:-600}"
REMIND_S="${REMIND_S:-21600}"
NOTIFY="${NOTIFY:-/opt/skills/notify/notify.sh}"

pb() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null; }
URL="$(pb BACKEND_URL)"; TOKEN="$(pb ACCOUNT_TOKEN)"
mkdir -p "$(dirname "$STATE_FILE")"
now=$(date +%s)

problem=""
if [[ -z "$URL" || -z "$TOKEN" ]]; then
  problem="cannot read BACKEND_URL/ACCOUNT_TOKEN from $PLIST"
else
  body="$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" "$URL/snapshot" || true)"
  last_ms="$(printf '%s' "$body" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("emitterLastSeenAt") or "")
except Exception: print("")' 2>/dev/null)"
  if [[ -z "$body" ]]; then
    problem="backend unreachable from this Mac (snapshot request failed)"
  elif [[ -z "$last_ms" ]]; then
    problem="backend has never seen the emitter (or snapshot returned an error)"
  else
    age=$(( now - last_ms / 1000 ))
    (( age > AGE_LIMIT_S )) && problem="emitter last reached the backend $((age / 60)) min ago (limit $((AGE_LIMIT_S / 60)) min)"
  fi
fi

# State file: "<alerted_at_epoch>" while an alert is outstanding, absent when healthy.
alerted_at=""; [[ -f "$STATE_FILE" ]] && alerted_at="$(cat "$STATE_FILE")"

if [[ -n "$problem" ]]; then
  state="$(launchctl print "gui/$(id -u)/ink.agentdash.emitter" 2>/dev/null | awk '/^\tstate =/{print $3; exit}')"
  msg="$problem. launchd state: ${state:-not loaded}. Check ~/Library/Logs/agentwidget-emitter.log; restart: launchctl kickstart -k gui/$(id -u)/ink.agentdash.emitter"
  if [[ -z "$alerted_at" ]] || (( now - alerted_at >= REMIND_S )); then
    if "$NOTIFY" -t "AgentDash emitter DOWN" "$msg"; then echo "$now" > "$STATE_FILE"; fi
  fi
elif [[ -n "$alerted_at" ]]; then
  if "$NOTIFY" -t "AgentDash emitter recovered" "Emitter is reaching the backend again."; then rm -f "$STATE_FILE"; fi
fi
