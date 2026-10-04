# UFC Bet Tracker

A self-hosted tracker for UFC bets: log singles and parlays, settle them per leg,
see P/L by event and matchup, and follow a card live with an outcome matrix.
FastAPI + SQLite, plain JS front end. Your data stays in one local `.db` file.

## Quick start

```bash
python3 -m venv venv && . venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8212
```

Open http://127.0.0.1:8212. The database is created on first run. Use
**Sync all cards** to load the bundled event catalog, then pick an active event.

## Configuration

Copy `.env.example` and export the variables (or set them in your service unit):

| Variable | Purpose |
|---|---|
| `UFC_V3_DB` | SQLite file path (default `./ufc-bet-tracker-v3.db`) |
| `THE_ODDS_API_KEY` | Optional; enables **Refresh odds** (moneylines from DraftKings/FanDuel) |

To share it on your LAN, bind `--host 0.0.0.0`. There is no authentication, so
don't expose it to the internet.

## Features
- Guided ticket entry (moneyline, method, round, totals, parlays, specials)
- Per-leg parlay settlement, bonus bets, cash-stake quick-add
- Per-event P/L charts, ledger filters, backups via `/api/export`
- Watch-along page with outcome matrix and ESPN result sync

## Tests

```bash
python -m unittest discover -s tests -v
npm ci && npx playwright install chromium && npx playwright test   # browser tests
```

## Backups
`GET /api/export` returns all data as JSON. Copying the `.db` file while the app is stopped also works.

## License
MIT
