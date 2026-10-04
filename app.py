"""UFC Bet Tracker v3: SQLite is the only application-data store."""
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from db import TrackerRepository
import odds_api
from import_legacy import map_legacy_bet

BASE_DIR = Path(__file__).resolve().parent
repo = TrackerRepository(Path(os.environ.get("UFC_V3_DB", BASE_DIR / "ufc-bet-tracker-v3.db")))
app = FastAPI(title="UFC Bet Tracker v3")


def load_legacy_embedded_data() -> dict:
    source = BASE_DIR / "data" / "ufc-db.js"
    if not source.is_file():
        api_error("data/ufc-db.js not found", 404)
    text = source.read_text(encoding="utf-8")
    match = re.search(r"window\.EMBEDDED_DATA\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not match:
        api_error("legacy embedded data could not be parsed")
    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError as e:
        api_error(f"legacy embedded data is invalid JSON: {e}")
    if not isinstance(data.get("events"), list) or not isinstance(data.get("cards"), dict):
        api_error("legacy embedded data missing events/cards")
    return data

def sync_events_from_legacy(event_id: str | None = None) -> dict:
    data = load_legacy_embedded_data()
    events = data["events"]
    cards = data["cards"]
    if event_id:
        events = [event for event in events if event.get("id") == event_id]
        if not events:
            api_error("event not found in legacy data", 404)
    synced = []
    for event in events:
        saved = repo.upsert_event(event)
        fights = cards.get(event["id"], [])
        repo.replace_event_fights(event["id"], fights)
        synced.append({"id": event["id"], "name": saved["name"], "fights": len(fights)})
    return {"source": "data/ufc-db.js", "synced_events": len(synced), "synced_fights": sum(x["fights"] for x in synced), "events": synced}


def _parse_yyyy_mm_dd(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _espn_date_window(event_date: str) -> str:
    event = _parse_yyyy_mm_dd(event_date)
    start = event - timedelta(days=1)
    end = event + timedelta(days=1)
    return f"{start:%Y%m%d}-{end:%Y%m%d}"


def _format_et_time(value: str) -> str:
    if not value:
        return ""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    et = dt.astimezone(ZoneInfo("America/New_York"))
    hour = et.strftime("%I").lstrip("0") or "0"
    return f"{hour}:{et:%M %p} ET"


def _event_by_id(event_id: str) -> dict | None:
    for event in repo.list_events():
        if event["id"] == event_id:
            return event
    return None


def _existing_fights_by_names(event_id: str) -> dict[str, dict]:
    with repo.connection() as conn:
        rows = conn.execute("SELECT * FROM fights WHERE event_id=?", (event_id,)).fetchall()
    def key(a: str, b: str) -> str:
        return "|".join(sorted([a.casefold(), b.casefold()]))
    return {key(row["fighter_a"], row["fighter_b"]): dict(row) for row in rows}


def _competition_fighters(comp: dict) -> tuple[str, str] | None:
    competitors = comp.get("competitors") or []
    if len(competitors) < 2:
        return None
    names = []
    for competitor in competitors[:2]:
        athlete = competitor.get("athlete") or {}
        names.append(athlete.get("displayName") or athlete.get("fullName") or athlete.get("shortName") or "")
    if not names[0] or not names[1]:
        return None
    return names[0], names[1]


def _espn_event_to_fights(event_id: str, espn_event: dict) -> list[dict]:
    competitions = espn_event.get("competitions") or []
    if not competitions:
        return []
    existing = _existing_fights_by_names(event_id)
    last_time = max((comp.get("date") or "" for comp in competitions), default="")
    fights = []
    for index, comp in enumerate(competitions):
        fighters = _competition_fighters(comp)
        if not fighters:
            continue
        fighter_a, fighter_b = fighters
        key = "|".join(sorted([fighter_a.casefold(), fighter_b.casefold()]))
        old = existing.get(key, {})
        is_main = (comp.get("date") == last_time) or (index >= max(0, len(competitions) - 5))
        fights.append({
            "fight_index": len(fights),
            "fighter_a": fighter_a,
            "fighter_b": fighter_b,
            "weight": (comp.get("type") or {}).get("abbreviation") or (comp.get("type") or {}).get("text") or (comp.get("type") or {}).get("name") or "",
            "odds_a": old.get("odds_a", -110),
            "odds_b": old.get("odds_b", -110),
            "ou_line": old.get("ou_line", 2.5),
            "is_main": is_main,
            "fight_time": _format_et_time(comp.get("date") or ""),
            "rounds": old.get("rounds"),
            "championship": old.get("championship", 0),
            "odds_source": old.get("odds_source", ""),
            "odds_updated_at": old.get("odds_updated_at", ""),
        })
    return fights


def sync_event_from_espn(event_id: str) -> dict:
    event = _event_by_id(event_id)
    if not event:
        api_error("event not found", 404)
    if not event.get("event_date"):
        api_error("event has no date for ESPN sync")
    url = f"https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates={_espn_date_window(event['event_date'])}"
    try:
        with urlopen(url, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, TimeoutError, json.JSONDecodeError) as e:
        api_error(f"ESPN sync failed: {e}", 502)
    candidates = data.get("events") or []
    espn_id = str(event.get("espn_id") or "")
    espn_event = next((candidate for candidate in candidates if str(candidate.get("id")) == espn_id), None) if espn_id else None
    if not espn_event and len(candidates) == 1:
        espn_event = candidates[0]
    if not espn_event:
        api_error("ESPN event not found in date window", 404)
    fights = _espn_event_to_fights(event_id, espn_event)
    if not fights:
        api_error("ESPN event had no fights", 502)
    updated = dict(event)
    updated["name"] = espn_event.get("name") or event["name"]
    updated["espn_id"] = str(espn_event.get("id") or event.get("espn_id") or "")
    times = [fight["fight_time"] for fight in fights if fight["fight_time"]]
    if times:
        updated["prelims_start"] = times[0]
        updated["main_start"] = fights[-1]["fight_time"]
    venue = ((espn_event.get("competitions") or [{}])[0].get("venue")) or {}
    if venue:
        address = venue.get("address") or {}
        city_state = ", ".join(part for part in [address.get("city"), address.get("state") or address.get("country")] if part)
        updated["venue"] = ", ".join(part for part in [venue.get("fullName"), city_state] if part)
    repo.upsert_event(updated)
    repo.replace_event_fights(event_id, fights)
    return {"source": "ESPN scoreboard", "synced_events": 1, "synced_fights": len(fights), "events": [{"id": event_id, "name": updated["name"], "fights": len(fights)}]}


@app.on_event("startup")
def startup():
    repo.initialize()


class LegIn(BaseModel):
    fight_name: str = ""
    selection: str = ""
    market: str = ""
    american_odds: int | None = None


class BetIn(BaseModel):
    event_id: str = ""
    event_name: str = ""
    book: str = ""
    fight_name: str = ""
    selection: str = ""
    bet_type: str = ""
    market: str = ""
    round_label: str = ""
    american_odds: int = 0
    cash_stake: float = Field(0, ge=0)
    bonus_stake: float = Field(0, ge=0)
    notes: str = ""
    is_live_stream: bool = False
    legs: list[LegIn] = []


class BetPatch(BaseModel):
    status: str | None = None
    payout: float | None = Field(None, ge=0)
    notes: str | None = None
    cash_stake: float | None = Field(None, ge=0)
    bonus_stake: float | None = Field(None, ge=0)
    american_odds: int | None = None
    book: str | None = None
    market: str | None = None
    round_label: str | None = None
    fight_name: str | None = None
    selection: str | None = None
    bet_type: str | None = None
    is_live_stream: bool | None = None


class LegPatch(BaseModel):
    status: str


class PosterPatch(BaseModel):
    poster_url: str = ""


class VenuePatch(BaseModel):
    venue: str = ""


def api_error(detail: str, status: int = 400):
    raise HTTPException(status, detail)


@app.get("/healthz")
def healthz():
    return {"ok": True, "storage": "sqlite"}


def _loopback_client(request: Request) -> bool:
    return bool(request.client) and request.client.host in ("127.0.0.1", "::1")


def _git(*args: str) -> tuple[int, str]:
    proc = subprocess.run(["git", *args], cwd=BASE_DIR, capture_output=True, text=True, timeout=120)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


@app.get("/api/update/check")
def update_check():
    """Report whether origin/main is ahead of the running checkout."""
    if os.environ.get("UFC_V3_UPDATE_DISABLE"):
        return {"repo": False, "behind": 0, "current": "", "has_updates": False}
    code, _ = _git("rev-parse", "--is-inside-work-tree")
    if code != 0:
        return {"repo": False, "behind": 0, "current": "", "has_updates": False}
    code, current = _git("rev-parse", "--short", "HEAD")
    code2, _ = _git("fetch", "origin", "--quiet")
    if code2 != 0:
        return {"repo": True, "behind": 0, "current": current, "has_updates": False, "fetch_error": True}
    code3, behind = _git("rev-list", "--count", "HEAD..origin/HEAD")
    if code3 != 0:
        code3, behind = _git("rev-list", "--count", "HEAD..origin/main")
    behind = int(behind or 0) if code3 == 0 else 0
    return {"repo": True, "behind": behind, "current": current, "has_updates": behind > 0}


@app.post("/api/update")
def update(request: Request):
    """Pull origin and install requirements. Loopback callers only."""
    if not _loopback_client(request):
        raise HTTPException(status_code=403, detail="update allowed from localhost only")
    code, out = _git("pull", "--ff-only", "origin")
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "git pull failed")
    lines = [out]
    reqs = BASE_DIR / "requirements.txt"
    if reqs.is_file():
        pip = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(reqs)],
                             capture_output=True, text=True, timeout=600)
        lines.append(pip.stdout.strip() or "requirements OK")
    return {"ok": True, "output": "\n".join(lines)}


@app.post("/api/restart")
def restart(request: Request):
    """Re-exec this process so pulled changes take effect."""
    if not _loopback_client(request):
        raise HTTPException(status_code=403, detail="restart allowed from localhost only")
    def _exec():
        os.execv(sys.argv[0], sys.argv)
    threading.Timer(1.0, _exec).start()
    return {"ok": True, "detail": "restarting"}


@app.get("/api/events")
def events():
    return {"events": repo.list_events(), "active_event": repo.active_event()}




@app.post("/api/events/sync")
def sync_all_events():
    return sync_events_from_legacy()


def _espn_method(result: dict) -> str | None:
    name = f"{result.get('name', '')} {result.get('displayName', '')}".lower()
    if "decision" in name: return "dec"
    if "sub" in name: return "sub"
    if "ko" in name: return "ko"
    return None  # DQ / no contest / draw etc: left for a manual call


def espn_results(event_id: str) -> list[dict]:
    event = _event_by_id(event_id)
    if not event: api_error("event not found", 404)
    url = f"https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates={_espn_date_window(event['event_date'])}"
    try:
        with urlopen(url, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, TimeoutError, json.JSONDecodeError) as e:
        api_error(f"ESPN results fetch failed: {e}", 502)
    espn_id = str(event.get("espn_id") or "")
    candidates = data.get("events") or []
    espn_event = next((c for c in candidates if str(c.get("id")) == espn_id), None) if espn_id else (candidates[0] if len(candidates) == 1 else None)
    if not espn_event: api_error("ESPN event not found in date window", 404)
    out = []
    for comp in espn_event.get("competitions") or []:
        status = comp.get("status") or {}
        if not (status.get("type") or {}).get("completed"): continue
        fighters = _competition_fighters(comp)
        winner = next((((c.get("athlete") or {}).get("displayName") or "") for c in comp.get("competitors") or [] if c.get("winner")), "")
        if not fighters or not winner: continue
        method = None
        try:
            with urlopen(f"https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/{espn_event.get('id')}/competitions/{comp.get('id')}/status", timeout=15) as r:
                method = _espn_method((json.loads(r.read().decode("utf-8")) or {}).get("result") or {})
        except (OSError, URLError, TimeoutError, json.JSONDecodeError):
            pass
        if not method: continue
        out.append({"fighter_a": fighters[0], "fighter_b": fighters[1], "winner": winner, "method": method, "round": None if method == "dec" else status.get("period"), "clock": status.get("displayClock") or ""})
    return out


class ResultIn(BaseModel):
    winner_side: str
    method: str
    round: int | None = None
    clock: str = ""


class DisputeResolveIn(BaseModel):
    resolution: str
    note: str = ""


class ConflictsIn(BaseModel):
    conflicts: list[dict] = Field(default_factory=list)


def _value_error(fn):
    try: return fn()
    except ValueError as e: api_error(str(e), 400)


@app.get("/api/events/{event_id}/results")
def get_results(event_id: str):
    return repo.list_results(event_id)


@app.post("/api/events/{event_id}/results/sync")
def sync_results(event_id: str):
    summary = repo.apply_espn_results(event_id, espn_results(event_id))
    return {**summary, **repo.list_results(event_id)}


@app.put("/api/events/{event_id}/results/{fight_index}")
def put_result(event_id: str, fight_index: int, body: ResultIn):
    return _value_error(lambda: repo.set_result(event_id, fight_index, body.winner_side, body.method, body.round, body.clock, "manual"))


@app.delete("/api/events/{event_id}/results/{fight_index}")
def delete_result(event_id: str, fight_index: int):
    return _value_error(lambda: repo.clear_result(event_id, fight_index))


@app.post("/api/events/{event_id}/results/conflicts")
def post_conflicts(event_id: str, body: ConflictsIn):
    repo.register_bet_conflicts(event_id, body.conflicts)
    return repo.list_results(event_id)


@app.post("/api/disputes/{dispute_id}/resolve")
def resolve_dispute(dispute_id: int, body: DisputeResolveIn):
    return _value_error(lambda: repo.resolve_dispute(dispute_id, body.resolution, body.note))


@app.post("/api/events/{event_id}/sync")
def sync_one_event(event_id: str):
    return sync_event_from_espn(event_id)


@app.post("/api/events/{event_id}/odds")
def refresh_event_odds(event_id: str):
    event = repo.active_event(auto_advance=False) if False else next((e for e in repo.list_events() if e["id"] == event_id), None)
    if not event: api_error("event not found", 404)
    fights = repo.get_event_fights(event_id) if hasattr(repo, "get_event_fights") else None
    if fights is None:
        with repo.connection() as conn:
            fights = [dict(r) for r in conn.execute("SELECT fight_index,fighter_a,fighter_b FROM fights WHERE event_id=? ORDER BY fight_index", (event_id,))]
    try:
        lines = odds_api.fetch_moneylines()
    except RuntimeError as exc:
        api_error(str(exc), 503)
    except Exception as exc:
        api_error(f"Odds API request failed: {exc}", 502)
    updates, missing = odds_api.match_prices(fights, lines)
    repo.update_fight_odds(event_id, updates)
    return {"updated": len(updates), "missing": missing}


@app.patch("/api/events/{event_id}/poster")
def update_event_poster(event_id: str, patch: PosterPatch):
    url = patch.poster_url.strip()
    if url and not url.startswith(("https://", "http://")):
        api_error("poster_url must be an http(s) URL")
    event = repo.update_event_poster(event_id, url)
    if not event: api_error("event not found", 404)
    return event


@app.patch("/api/events/{event_id}/venue")
def update_venue(event_id: str, patch: VenuePatch):
    event = repo.update_event_venue(event_id, patch.venue.strip())
    if not event: api_error("event not found", 404)
    return event


@app.get("/api/events/active")
def active_event():
    event = repo.active_event()
    if not event: api_error("no active event", 404)
    return event


@app.put("/api/events/active/{event_id}")
def set_active_event(event_id: str):
    event = repo.set_active_event(event_id)
    if not event: api_error("event not found", 404)
    return event


@app.get("/api/statistics")
def statistics(event_id: str | None = None):
    return repo.statistics(event_id)


@app.get("/api/profit-timeline")
def profit_timeline(event_id: str | None = None):
    return repo.profit_timeline(event_id)


@app.get("/api/watch-guide")
def watch_guide(event_id: str | None = None, beam: int = 10, lottery_threshold: int = 10000):
    selected_event_id = event_id or (repo.active_event() or {}).get("id")
    if not selected_event_id: api_error("no active event", 404)
    return repo.watch_guide(selected_event_id, max(1, min(beam, 250)), lottery_threshold or None)


@app.get("/api/bets")
def list_bets(status: str | None = None, event_id: str | None = None):
    return {"bets": repo.list_bets(status, event_id)}


@app.get("/api/bets/{bet_id}")
def get_bet(bet_id: str):
    bet = repo.get_bet(bet_id)
    if not bet: api_error("bet not found", 404)
    return bet


@app.post("/api/bets", status_code=201)
def create_bet(payload: BetIn):
    if not payload.fight_name.strip() and not payload.selection.strip(): api_error("fight name or selection is required")
    if not payload.american_odds: api_error("American odds must be nonzero")
    if not all(math.isfinite(v) for v in (payload.cash_stake, payload.bonus_stake)):
        api_error("stakes must be finite")
    if payload.cash_stake + payload.bonus_stake <= 0: api_error("a cash or bonus stake is required")
    return repo.create_bet(payload.model_dump())


@app.patch("/api/bets/{bet_id}")
def update_bet(bet_id: str, payload: BetPatch):
    fields = payload.model_dump(exclude_unset=True)
    if any(value is None and key != 'payout' for key, value in fields.items()):
        api_error("only payout can be cleared with null")
    if fields.get('american_odds') == 0: api_error("American odds must be nonzero")
    if any(not math.isfinite(fields[key]) for key in ('cash_stake', 'bonus_stake', 'payout') if fields.get(key) is not None):
        api_error("money amounts must be finite")
    try:
        bet = repo.update_bet(bet_id, fields)
    except ValueError as e:
        api_error(str(e))
    if not bet: api_error("bet not found", 404)
    return bet


@app.patch("/api/bets/{bet_id}/legs/{leg_index}")
def update_leg_status(bet_id: str, leg_index: int, payload: LegPatch):
    try:
        bet = repo.update_leg_status(bet_id, leg_index, payload.status)
    except ValueError as e:
        api_error(str(e))
    if not bet: api_error("bet not found", 404)
    return bet


@app.delete("/api/bets/{bet_id}", status_code=204)
def delete_bet(bet_id: str):
    if not repo.delete_bet(bet_id): api_error("bet not found", 404)


@app.get("/api/dashboard")
def dashboard(event_id: str | None = None):
    return repo.dashboard(event_id)


@app.get("/api/export")
def export():
    return repo.export()


@app.post("/api/import/legacy")
async def import_legacy(request: Request, dry_run: bool = True):
    body = await request.json()
    raw_bets = body.get("bets", body) if isinstance(body, dict) else body
    if not isinstance(raw_bets, list): api_error("expected an array of legacy bets or {'bets': [...]}")
    mapped = []
    errors = []
    for index, raw in enumerate(raw_bets):
        try:
            mapped.append(map_legacy_bet(raw))
        except (TypeError, ValueError) as e:
            errors.append({"index": index, "error": str(e)})
    source_ids = [bet["legacy_id"] for bet, _ in mapped]
    duplicates = len(source_ids) - len(set(source_ids))
    report = {"received": len(raw_bets), "valid": len(mapped), "invalid": errors, "duplicate_source_ids": duplicates, "dry_run": dry_run}
    if dry_run or errors or duplicates: return report
    imported = 0
    for legacy, legs in mapped:
        existing = None
        with repo.connection() as conn:
            existing = conn.execute("SELECT id FROM bets WHERE legacy_id=?", (legacy["legacy_id"],)).fetchone()
        if existing: continue
        record = {"event_id": legacy["event_id"], "event_name": legacy["event_id"], "book": legacy["book"], "fight_name": legacy["fight_name"], "selection": legacy["selection"], "bet_type": legacy["bet_type"], "american_odds": legacy["american_odds"], "cash_stake": 0 if legacy["is_bonus_bet"] else legacy["stake"], "bonus_stake": legacy["stake"] if legacy["is_bonus_bet"] else 0, "status": legacy["status"], "payout": legacy["payout"], "notes": legacy["notes"], "is_live_stream": legacy["is_live_stream"], "legs": legs}
        repo.create_bet(record, legacy_id=legacy["legacy_id"], source_json=legacy["source_json"], legacy_net_pnl=legacy["legacy_net_pnl"])
        imported += 1
    return {**report, "imported": imported}


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/static/{asset}")
def static_asset(asset: str):
    path = BASE_DIR / "static" / asset
    if not path.is_file(): api_error("asset not found", 404)
    return FileResponse(path)
