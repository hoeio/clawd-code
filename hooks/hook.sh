#!/bin/sh
# Claude Code hook (all events). Forwards the payload to the clawd daemon in the
# background and exits 0 immediately. Must never block or fail Claude Code.
D="${CLAWD_HOME:-$HOME/.clawd-companion}"
body=$(cat)
(
  # curlrc (written by the daemon, mode 600) holds the URL and the per-run token.
  send() { printf '%s' "$body" | curl -s -m 1 -K "$D/curlrc" --data-binary @- >/dev/null 2>&1; }
  send && exit 0
  # Daemon not reachable: only SessionStart tries to start it.
  case "$body" in *'"SessionStart"'*) ;; *) exit 0 ;; esac
  [ -f "$D/env" ] && . "$D/env"
  "${CLAWD_NODE:-node}" "$CLAWD_ENTRY" start
  for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.3; send && exit 0; done
) </dev/null >/dev/null 2>&1 &
exit 0
