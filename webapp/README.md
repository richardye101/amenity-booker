# BuildingLink Booking Panel

A tiny self-hosted control panel for the amenity booking bot. Zero external
dependencies — it drives `../reserve-fast.js` (and `../login.js`) under the hood.

## Run

```bash
cd ~/buildinglink-bot
npm start            # = node webapp/server.js  → http://localhost:3000
```

Other scripts: `npm run login`, `npm run scan`, `npm run map-amenities`.
Set `PORT=8080 npm start` to change the port.

## Running on a headless server (no display)

This bot must drive a **headed** browser — BuildingLink's SSO redirects to the
login page under true headless Chromium. On a server with no display, use a
virtual framebuffer (Xvfb):

```bash
sudo apt-get install -y xvfb
xvfb-run -a npm start
```

- The **control panel** needs no display — open `http://<server-ip>:3000` from
  any browser on your network.
- **Login** (no screen to type credentials): easiest is to log in once locally
  (`npm run login`) and copy the `user-data/` profile folder to the server. The
  session has `offline_access` (a refresh token), so it persists across
  restarts. Alternatively run noVNC/VNC against the Xvfb display to do the
  one-time login remotely.
- `caffeinate` is macOS-only; on Linux the server just spawns `node` directly
  (servers don't idle-sleep).

### Debian/Ubuntu quickstart

```bash
# on the server, from the project root
bash deploy/setup.sh                 # installs xvfb, node deps, chromium + libs
# seed login: run `npm run login` on a laptop, then copy the profile over:
#   scp -r user-data/ <server>:/opt/buildinglink-bot/
xvfb-run -a npm start                # manual run, or install the service below
```

Run on boot with systemd:

```bash
sudo cp deploy/buildinglink-panel.service /etc/systemd/system/
sudoedit /etc/systemd/system/buildinglink-panel.service   # set User=, WorkingDirectory=, PATH=
sudo systemctl daemon-reload
sudo systemctl enable --now buildinglink-panel
journalctl -u buildinglink-panel -f                       # watch logs
```

Then browse to `http://<server-ip>:3000`. The panel binds all interfaces; if
that's too open, run it bound to localhost and reach it over an SSH tunnel
(`ssh -L 3000:localhost:3000 <server>`).

## Use

1. **Session** — click *Log in / refresh*. A browser window opens; sign into
   BuildingLink once. The session is saved in `../user-data` and reused.
2. **Reservation** — pick amenity (Tennis / Pool / BBQ2, or a custom
   `amenityId`), date, start/end time, and optionally a fallback slot that's
   tried only if the first is taken.
3. **When to fire** —
   - *When this slot opens (auto)* — **default & recommended.** Uses each
     amenity's scanned booking window to compute the exact moment your chosen
     date becomes bookable, and fires then. The panel shows that time live.
   - *At next midnight* — fire tonight at 00:00.
   - *Now* — book immediately (already-open slots / testing).
   - *Specific time* — pick an exact datetime.
   - *Dry run* — fills everything but doesn't click Save.
4. Click **Arm booking**. A browser window warms up and holds until fire time,
   then books (and, if it fails, tries the fallback). Watch live status, log
   tail, and a screenshot in the **Status** panel.

## Notes

- **One booking at a time.** BuildingLink's login profile can only be used by
  one browser at once, so arming is disabled while a session is active.
- On macOS the booking runs under `caffeinate -i` so the Mac won't idle-sleep
  while waiting. Still keep the lid open / plugged in (lid-close sleeps anyway).
- Keep the browser window and this server running until the booking fires.
- Logs/screenshots are written to `../run-logs/`.

## Amenities & booking windows

All 22 amenities are pre-loaded in the dropdown (via `map-amenities.js`). If the
building adds new ones, re-run `npm run map-amenities`, or use **Custom
amenityId** (copy `amenityId=` from any reservation page URL).

`npm run scan` visits each amenity and records **when reservations open**, into
`webapp/amenities-meta.json`. The panel shows each amenity's window and, in
*auto* timing mode, computes the exact fire time. Three rule types are detected:

- **fixed** — opens a set number of days ahead. e.g. Tennis "Current & Next
  Day" and BBQ "Next 1 Day" → the date opens at **00:00 the night before**.
  Party Room is ~211 days (6 months).
- **week** — the whole Sun–Sat week opens at **Sunday 00:00** (Pool, Squash,
  Basketball, Bowling, Movie Theater, Ping Pong, 1st Floor Lounge).
- **far / always open** — Guest Suites & Service Elevators (bookable years out).

Re-run `npm run scan` periodically (windows/hours can change). It reuses the
saved login (and `.env` auto-login if configured).

**Auto-refresh:** the server re-scans on a schedule — `SCAN_INTERVAL_HOURS`
(default `168` = weekly; set `0` to disable). It runs on startup only if the
data is missing/older than the interval, and skips while a booking/login is
active (retrying 30 min later), so it never fights for the browser profile.
