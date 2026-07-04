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
echo "Setup done. NEXT:"
echo "  1. Credentials for unattended auto-login:"
echo "       cp .env.example .env && chmod 600 .env   # add BL_USERNAME / BL_PASSWORD"
echo "     (or seed manually: 'npm run login' on a laptop, then scp -r user-data/ here)"
echo "  2. Install boot + auto-deploy services:"
echo "       bash deploy/install-services.sh"
echo "  3. Browse to http://<server-ip>:3000"
