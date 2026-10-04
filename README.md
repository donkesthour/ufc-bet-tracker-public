# UFC Bet Tracker

Self-hosted tracker for UFC betting. Log singles and parlays, settle them per leg,
watch a card live with an outcome matrix, and see P/L by event and matchup.
FastAPI + SQLite on the backend, plain JavaScript on the frontend. All your data
lives in one local `.db` file — nothing leaves your machine.

## Quick start — Windows

1. Install Python from [python.org/downloads](https://www.python.org/downloads/) — tick **Add python.exe to PATH** during install.
2. Download this repository (**Code → Download ZIP**), then unzip it.
3. Double-click **setup.bat** — one time.
4. Double-click **start.bat** whenever you want to use the tracker. It opens
   the page and prints the addresses. **stop.bat** stops it.

The first start may ask Windows Firewall for permission — click **Allow**.

## Quick start — Mac / Linux

```bash
./launch.sh
```

That's it. On first run the script creates a Python virtual environment,
installs dependencies, starts the server on
[http://127.0.0.1:8212](http://127.0.0.1:8212), and opens the page in your
browser. Run it again any time to start the app.

Options:

```bash
./launch.sh --host 0.0.0.0 --port 8212 --no-open
```

Prefer to run it yourself:

```bash
python3 -m venv venv && . venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8212
```

The SQLite database is created automatically on first run. Click **Sync all
cards** to load the bundled event catalog, then pick an active event and start
logging bets.

## Using the tracker

- **Fight desk** — the main page. Pick the active event, log bets through the
  guided ticket (sportsbook → matchup → bet type → selection → odds → stake),
  and settle them from the ledger. Singles and parlays both supported; parlays
  settle per leg and auto-settle the ticket when every leg is decided.
- **Bet types** — moneyline, method of victory, round props, totals (over/under),
  go the distance, specials, and custom matchups for bets that aren't on a card.
- **Bonus bets** — tick the Bonus box on the ticket; they're graded as stake-free
  cash (winnings only).
- **Ledger** — filter by status, sportsbook, or matchup; edit/duplicate rows;
  correct the actual bookmaker payout after a settlement.
- **Watch along** — a second page for fight night: matchup P/L, an outcome
  matrix showing what every pending ticket is worth for each possible result,
  and optional ESPN result sync (display only — it never rewrites your bets).
- **Statistics** — per-event and all-time P/L, ROI, win rate, and a cumulative
  P/L chart (straight bets and parlays split evenly across legs).
- **Export JSON** (header) — download everything as JSON for backup. Copying
  the `.db` file while the app is stopped also works.

## Sharing with someone

The tracker has no login, so choose the sharing method carefully:

- **Same Wi-Fi / house network:** run `start.bat` and share the
  `http://<PC-IP>:8214` address it prints. Works for anyone connected to your
  router; nothing is exposed to the internet.
- **Over the internet:** run `start.bat`, then double-click
  **share-online.bat**. It creates a temporary public link
  (`https://<random>.trycloudflare.com`) that you can send to anyone. The link
  changes every time, and **anyone who has it can see and edit your bets** — it
  disappears when you close the window.
- **Private, permanent access:** install [Tailscale](https://tailscale.com) on
  both machines (free) and use the tailnet address. Requires no open ports.

## Updating

Two ways to pull new features:

**In-app (recommended).** An **↑ Update** button appears in the header (top
right) when a newer version is available. Click it: the app pulls the latest
code, installs any new dependencies, restarts itself, and reloads the page.
This works for git clones **and** for ZIP downloads (a ZIP install refreshes
itself by re-downloading the archive — your database and settings are kept).

**From the terminal.**

```bash
git pull
# if requirements.txt changed:
pip install -r requirements.txt
# then restart the app (Ctrl+C and ./launch.sh again)
```

ZIP users: just click the in-app **↑ Update** button instead.

The update endpoints are restricted to requests from the same machine
(localhost), so a LAN visitor can't trigger them.

## Configuration

Copy `.env.example` to `.env` (the launch script loads it automatically):

| Variable | Purpose |
|---|---|
| `UFC_V3_DB` | SQLite file path (default `./ufc-bet-tracker-v3.db`) |
| `THE_ODDS_API_KEY` | Optional — enables **Refresh odds** (moneylines from DraftKings/FanDuel via [the-odds-api.com](https://the-odds-api.com)) |
| `UFC_V3_UPDATE_DISABLE` | Set to `1` to hide the in-app updater |

## Running as a service

Example systemd user unit:

```ini
[Unit]
Description=UFC Bet Tracker
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/ufc-bet-tracker
Environment=UFC_V3_DB=/path/to/ufc-bet-tracker-v3.db
ExecStart=/path/to/ufc-bet-tracker/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8212
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

> **Note:** the app has no authentication. It's meant for personal use on a
> trusted network — don't forward it to the internet.

## Development

```bash
python -m unittest discover -s tests -v          # API and repository tests
npm ci && npx playwright install chromium
npx playwright test                              # browser contract tests
node --check static/app.js                       # JS syntax
```

The Playwright suite starts its own isolated server with a throwaway database;
it never touches yours.

## License

[MIT](LICENSE)
