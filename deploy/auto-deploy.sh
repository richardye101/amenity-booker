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

git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] && exit 0   # already up to date

echo "$(date -Is) new deployment ${LOCAL:0:7} -> ${REMOTE:0:7}"
git pull --ff-only origin main
npm install --no-audit --no-fund
# If Playwright itself was upgraded you may also need: npx playwright install chromium
systemctl --user restart buildinglink-panel.service
echo "$(date -Is) restarted panel"
