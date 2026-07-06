#!/usr/bin/env bash
# Poll the git remote; if there's a new commit, pull + reinstall + restart the
# panel. Skips while a booking/login is active so it never kills an armed job.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"

# Defer if a browser session (booking or login) is currently active.
if curl -sf -m 5 "http://localhost:${PORT}/api/state" 2>/dev/null | grep -q '"activeId":"'; then
  echo "$(date -Is) busy (active session) — deferring deploy"
  exit 0
fi

# Defer if a booking is running or fires within 15 min. Read queue.json off disk
# (not the HTTP API) so a slow/unreachable panel can't fail this check open and
# let a restart kill an armed booking — the exact failure from 2026-07-05.
if [ -f webapp/queue.json ] && node -e '
  const q = require("./webapp/queue.json");
  const soon = Date.now() + 15 * 60 * 1000;
  process.exit(q.some((e) => e.status === "running" || (e.status === "queued" && e.fireAt <= soon)) ? 0 : 1);
' 2>/dev/null; then
  echo "$(date -Is) booking running/imminent — deferring deploy"
  exit 0
fi

git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] && exit 0   # already up to date

echo "$(date -Is) new deployment ${LOCAL:0:7} -> ${REMOTE:0:7}"
git reset --hard origin/main    # deploy target: force-match remote (handles local drift)
npm install --no-audit --no-fund
# If Playwright itself was upgraded you may also need: npx playwright install chromium
systemctl --user restart buildinglink-panel.service
echo "$(date -Is) restarted panel"
