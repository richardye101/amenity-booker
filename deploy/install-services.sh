#!/usr/bin/env bash
# Install + enable the panel and the 1-minute auto-deploy timer as *user*
# systemd services (no sudo needed to self-restart). Run from anywhere:
#   bash deploy/install-services.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UD="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UD"

echo "==> Rendering unit files (repo = $REPO)"
for u in buildinglink-panel.service buildinglink-deploy.service buildinglink-deploy.timer; do
  sed "s#__REPO__#$REPO#g" "$REPO/deploy/$u" > "$UD/$u"
done
chmod +x "$REPO/deploy/auto-deploy.sh"

# Start user services at boot without an interactive login.
echo "==> Enabling linger for $USER (starts services at boot)"
loginctl enable-linger "$USER" 2>/dev/null || echo "   (couldn't enable linger — you may need: sudo loginctl enable-linger $USER)"

systemctl --user daemon-reload
systemctl --user enable --now buildinglink-panel.service
systemctl --user enable --now buildinglink-deploy.timer

echo
echo "Done. Handy commands:"
echo "  systemctl --user status buildinglink-panel"
echo "  journalctl --user -u buildinglink-panel -f"
echo "  systemctl --user list-timers buildinglink-deploy.timer"
systemctl --user --no-pager status buildinglink-panel.service | head -6 || true
