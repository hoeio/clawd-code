#!/bin/sh
# Handoff delivery for UserPromptSubmit / Stop. Synchronous, so it's installed only when
# handoff is enabled. Prints at most ONE approved instruction for this session, exactly once.
# Always exits 0. Fast path: empty queue -> exit without reading anything.
D="${CLAWD_HOME:-$HOME/.clawd-companion}"
EV="$1"
set -- "$D"/handoff/queue/*/*
[ -d "$1" ] || exit 0

in=$(cat)
# Loop guard: Claude is already continuing because of a stop hook. Deliver nothing.
case "$in" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
sid=$(printf '%s' "$in" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9-]*\)".*/\1/p')
[ -n "$sid" ] || exit 0

for item in "$D/handoff/queue/$sid"/*; do
  [ -f "$item/$EV.json" ] || exit 0
  claim="$D/handoff/claimed.$$"
  # Atomic claim: if another hook got here first, mv fails and we try the next item.
  mv "$item" "$claim" 2>/dev/null || continue
  cat "$claim/$EV.json"
  rm -rf "$claim"
  exit 0
done
exit 0
