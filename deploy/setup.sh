#!/usr/bin/env bash
# One-time setup for running the BuildingLink panel on a headless Linux box.
# Assumes Debian/Ubuntu (apt). Run from the project root: bash deploy/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing Xvfb (virtual display for the headed browser)..."
sudo apt-get update
sudo apt-get install -y xvfb

echo "==> Installing Node deps..."
npm install

echo "==> Installing Chromium + its OS libraries for Playwright..."
npx playwright install --with-deps chromium

echo
echo "Setup done."
echo "NEXT: seed the login session (no screen to type credentials on a server):"
echo "  - Locally (a machine with a display):  npm run login   (sign in)"
echo "  - Then copy the profile here:          scp -r user-data/ <server>:$(pwd)/"
echo
echo "Then start it:  xvfb-run -a npm start     (or install the systemd service)"
