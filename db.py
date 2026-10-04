"""SQLite persistence for UFC Bet Tracker v3."""
import itertools
import json
import re
import sqlite3
import unicodedata
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, event_date TEXT, prelims_start TEXT NOT NULL DEFAULT '',
  main_start TEXT NOT NULL DEFAULT '', espn_id TEXT NOT NULL DEFAULT '', poster_url TEXT NOT NULL DEFAULT '', venue TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fights (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, fight_index INTEGER NOT NULL,
  fighter_a TEXT NOT NULL, fighter_b TEXT NOT NULL, odds_a INTEGER NOT NULL, odds_b INTEGER NOT NULL,
  is_main INTEGER NOT NULL DEFAULT 0 CHECK(is_main IN (0,1)), weight TEXT NOT NULL DEFAULT '',
  rounds INTEGER, fight_time TEXT NOT NULL DEFAULT '', ou_line REAL, odds_source TEXT NOT NULL DEFAULT '',
  odds_updated_at TEXT NOT NULL DEFAULT '', championship INTEGER NOT NULL DEFAULT 0 CHECK(championship IN (0,1)),
  PRIMARY KEY(event_id, fight_index)
);
CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, event_id TEXT NOT NULL, event_name TEXT NOT NULL,
  book TEXT NOT NULL DEFAULT '', fight_name TEXT NOT NULL, selection TEXT NOT NULL,
  bet_type TEXT NOT NULL, market TEXT NOT NULL DEFAULT '', round_label TEXT NOT NULL DEFAULT '',
  american_odds INTEGER NOT NULL, cash_stake REAL NOT NULL DEFAULT 0 CHECK(cash_stake >= 0),
  bonus_stake REAL NOT NULL DEFAULT 0 CHECK(bonus_stake >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','win','loss','void')),
  payout REAL, legacy_net_pnl REAL, notes TEXT NOT NULL DEFAULT '',
  is_live_stream INTEGER NOT NULL DEFAULT 0 CHECK(is_live_stream IN (0,1)),
  placed_at TEXT NOT NULL, settled_at TEXT, source_json TEXT
);
CREATE TABLE IF NOT EXISTS bet_legs (
  bet_id TEXT NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  leg_index INTEGER NOT NULL, fight_name TEXT NOT NULL DEFAULT '', selection TEXT NOT NULL DEFAULT '',
  market TEXT NOT NULL DEFAULT '', american_odds INTEGER, status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','win','loss','void')),
  PRIMARY KEY (bet_id, leg_index)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports (fingerprint TEXT PRIMARY KEY, imported_at TEXT NOT NULL, imported_count INTEGER NOT NULL);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def bool_value(value: Any) -> bool:
    return bool(value)


def normalized_matchup(value: Any) -> str:
    return "".join(character for character in str(value or "").lower() if character.isalnum())


def scheduled_minutes(value: Any) -> int | None:
    match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", str(value or ""), re.I)
    if not match:
        return None
    hour, minute, meridiem = int(match.group(1)), int(match.group(2) or 0), match.group(3).lower()
    return (hour % 12 + (12 if meridiem == "pm" else 0)) * 60 + minute


@dataclass(frozen=True)
class MoneyOutcome:
    winner: str
    method: str
    round: int | None


RESULTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS fight_results (
  event_id TEXT NOT NULL, fight_key TEXT NOT NULL, fighter_a TEXT NOT NULL, fighter_b TEXT NOT NULL,
  winner TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('ko','sub','dec')), round INTEGER, clock TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK(source IN ('espn','manual')), updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, fight_key)
);
CREATE TABLE IF NOT EXISTS result_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('result','bet')),
  dkey TEXT NOT NULL, fight_key TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), resolution TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, resolved_at TEXT, UNIQUE(event_id, dkey)
);
"""


def clean_clock(clock: Any) -> str:
    """Finish time within a round as m:ss (0:00-5:00). Empty string = unknown."""
    text = str(clock or "").strip()
    if not text: return ""
    parts = text.split(":")
    if len(parts) != 2 or not (parts[0].isdigit() and len(parts[0]) == 1 and parts[1].isdigit() and len(parts[1]) == 2) or int(parts[1]) > 59 or int(parts[0]) * 60 + int(parts[1]) > 300:
        raise ValueError("finish time must look like m:ss (0:00 to 5:00)")
    return f"{int(parts[0])}:{parts[1]}"


class TrackerRepository:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            conn.executescript(SCHEMA)
            conn.executescript(RESULTS_SCHEMA)
            # v3 began with a minimal events table; upgrade it in place.
            known = {row["name"] for row in conn.execute("PRAGMA table_info(events)")}
            for column, definition in {"prelims_start": "TEXT NOT NULL DEFAULT ''", "main_start": "TEXT NOT NULL DEFAULT ''", "espn_id": "TEXT NOT NULL DEFAULT ''", "poster_url": "TEXT NOT NULL DEFAULT ''", "venue": "TEXT NOT NULL DEFAULT ''"}.items():
                if column not in known:
                    conn.execute(f"ALTER TABLE events ADD COLUMN {column} {definition}")

    @staticmethod
    def _bet(row: sqlite3.Row, legs: list[sqlite3.Row]) -> dict:
        bet = dict(row)
        bet["is_live_stream"] = bool(bet["is_live_stream"])
        bet["legs"] = [dict(leg) for leg in legs]
        return bet

    def _get_with_connection(self, conn, bet_id: str) -> dict | None:
        row = conn.execute("SELECT * FROM bets WHERE id=?", (bet_id,)).fetchone()
        if row is None:
            return None
        legs = conn.execute("SELECT * FROM bet_legs WHERE bet_id=? ORDER BY leg_index", (bet_id,)).fetchall()
        return self._bet(row, legs)

    def get_bet(self, bet_id: str) -> dict | None:
        with self.connection() as conn:
            return self._get_with_connection(conn, bet_id)

    def list_bets(self, status: str | None = None, event_id: str | None = None) -> list[dict]:
        terms, args = [], []
        if status: terms.append("status=?"); args.append(status)
        if event_id: terms.append("event_id=?"); args.append(event_id)
        where = " WHERE " + " AND ".join(terms) if terms else ""
        with self.connection() as conn:
            rows = conn.execute(f"SELECT * FROM bets{where} ORDER BY placed_at DESC, id DESC", args).fetchall()
            return [self._get_with_connection(conn, row["id"]) for row in rows]

    def create_bet(self, record: dict, *, bet_id: str | None = None, legacy_id: str | None = None,
                   source_json: str | None = None, legacy_net_pnl: float | None = None) -> dict:
        bet_id = bet_id or str(uuid.uuid4())
        now = utc_now()
        status = record.get("status", "pending")
        if status not in {"pending", "win", "loss", "void"}: raise ValueError("invalid status")
        with self.connection() as conn:
            event_id = record.get("event_id", "")
            event_name = record.get("event_name") or event_id
            existing_event = conn.execute("SELECT name FROM events WHERE id=?", (event_id,)).fetchone() if event_id else None
            if existing_event and (not event_name or event_name == event_id):
                event_name = existing_event["name"]
            conn.execute("INSERT OR IGNORE INTO events(id,name,created_at) VALUES (?,?,?)",
                         (event_id, event_name, now))
            conn.execute("""INSERT INTO bets (id,legacy_id,event_id,event_name,book,fight_name,selection,bet_type,market,round_label,
                       american_odds,cash_stake,bonus_stake,status,payout,legacy_net_pnl,notes,is_live_stream,placed_at,settled_at,source_json)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (bet_id, legacy_id, event_id, event_name, record.get("book", ""),
                 record.get("fight_name", ""), record.get("selection", ""), record.get("bet_type", ""), record.get("market", ""), record.get("round_label", ""),
                 int(record.get("american_odds", 0)), float(record.get("cash_stake", 0)), float(record.get("bonus_stake", 0)), status,
                 record.get("payout"), legacy_net_pnl, record.get("notes", ""), int(bool_value(record.get("is_live_stream", False))), now,
                 now if status != "pending" else None, source_json))
            for index, leg in enumerate(record.get("legs", [])):
                conn.execute("INSERT INTO bet_legs(bet_id,leg_index,fight_name,selection,market,american_odds,status) VALUES (?,?,?,?,?,?,?)",
                    (bet_id, int(leg.get("leg_index", index)), leg.get("fight_name", ""), leg.get("selection", ""), leg.get("market", ""), leg.get("american_odds"), leg.get("status", "pending")))
            return self._get_with_connection(conn, bet_id)

    def update_bet(self, bet_id: str, patch: dict) -> dict | None:
        allowed = {"status", "payout", "notes", "cash_stake", "bonus_stake", "american_odds", "book", "market", "round_label", "fight_name", "selection", "bet_type", "is_live_stream"}
        fields = {k: v for k, v in patch.items() if k in allowed}
        if "status" in fields and fields["status"] not in {"pending", "win", "loss", "void"}: raise ValueError("invalid status")
        if not fields: raise ValueError("nothing to update")
        with self.connection() as conn:
            # Serialize the read/derive/write transaction, including competing clients.
            conn.execute("BEGIN IMMEDIATE")
            current = self._get_with_connection(conn, bet_id)
            if current is None:
                return None
            updated = {**current, **fields}
            status = updated['status']
            if 'status' in fields:
                fields['settled_at'] = None if status == 'pending' else utc_now()
            if {'status', 'cash_stake', 'bonus_stake', 'american_odds', 'payout'} & fields.keys():
                if status == 'pending':
                    fields['payout'] = None
                elif status == 'loss':
                    fields['payout'] = 0
                elif status == 'void':
                    fields['payout'] = updated['cash_stake']
                elif fields.get('payout') is None:
                    odds = updated['american_odds']
                    if not odds:
                        raise ValueError('nonzero odds required to calculate a win; enter the actual payout instead')
                    factor = odds / 100 if odds > 0 else 100 / abs(odds)
                    fields['payout'] = round(updated['cash_stake'] + (updated['cash_stake'] + updated['bonus_stake']) * factor, 2)
            sets = ", ".join(f"{key}=?" for key in fields)
            conn.execute(f"UPDATE bets SET {sets} WHERE id=?", (*fields.values(), bet_id))
            return self._get_with_connection(conn, bet_id)

    def update_leg_status(self, bet_id: str, leg_index: int, status: str) -> dict | None:
        if status not in {"pending", "win", "loss", "void"}: raise ValueError("invalid status")
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = self._get_with_connection(conn, bet_id)
            if current is None:
                return None
            changed = conn.execute("UPDATE bet_legs SET status=? WHERE bet_id=? AND leg_index=?", (status, bet_id, leg_index)).rowcount
            if changed != 1:
                raise ValueError("leg not found")
            legs = [dict(row) for row in conn.execute("SELECT * FROM bet_legs WHERE bet_id=? ORDER BY leg_index", (bet_id,)).fetchall()]
            leg_statuses = [leg["status"] for leg in legs]
            if leg_statuses and all(value != "pending" for value in leg_statuses):
                parent_status = "loss" if "loss" in leg_statuses else ("void" if all(value == "void" for value in leg_statuses) else "win")
                cash = float(current["cash_stake"] or 0)
                bonus = float(current["bonus_stake"] or 0)
                payout = None
                if parent_status == "loss":
                    payout = 0
                elif parent_status == "void":
                    payout = cash
                else:
                    odds = int(current["american_odds"] or 0)
                    if not odds:
                        raise ValueError('nonzero odds required to calculate a win; enter the actual payout instead')
                    factor = odds / 100 if odds > 0 else 100 / abs(odds)
                    payout = round(cash + (cash + bonus) * factor, 2)
                conn.execute("UPDATE bets SET status=?, payout=?, settled_at=? WHERE id=?", (parent_status, payout, utc_now(), bet_id))
            return self._get_with_connection(conn, bet_id)

    def delete_bet(self, bet_id: str) -> bool:
        with self.connection() as conn:
            return conn.execute("DELETE FROM bets WHERE id=?", (bet_id,)).rowcount == 1

    def dashboard(self, event_id: str | None = None) -> dict:
        where, args = (" WHERE event_id=?", [event_id]) if event_id else ("", [])
        with self.connection() as conn:
            rows = conn.execute(f"SELECT status, COUNT(*) n, SUM(cash_stake) cash, SUM(bonus_stake) bonus, SUM(COALESCE(payout,0)) payout FROM bets{where} GROUP BY status", args).fetchall()
        by = {r["status"]: dict(r) for r in rows}
        won, loss = by.get("win", {}), by.get("loss", {})
        settled = won.get("n", 0) + loss.get("n", 0)
        profit = (won.get("payout", 0) or 0) - (won.get("cash", 0) or 0) - (loss.get("cash", 0) or 0)
        return {"total_bets": sum(r["n"] for r in rows), "pending": by.get("pending", {}).get("n", 0), "won": won.get("n", 0), "lost": loss.get("n", 0), "profit": round(profit, 2), "win_rate": round(won.get("n", 0) / settled, 4) if settled else None}

    def upsert_event(self, event: dict) -> dict:
        with self.connection() as conn:
            conn.execute("""INSERT INTO events(id,name,event_date,prelims_start,main_start,espn_id,poster_url,venue,created_at)
                         VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,event_date=excluded.event_date,
                         prelims_start=excluded.prelims_start,main_start=excluded.main_start,espn_id=excluded.espn_id,
                         poster_url=COALESCE(NULLIF(excluded.poster_url,''),events.poster_url),
                         venue=COALESCE(NULLIF(excluded.venue,''),events.venue)""",
                         (event["id"], event["name"], event.get("event_date") or event.get("date"), event.get("prelims_start") or event.get("prelimsStart") or "", event.get("main_start") or event.get("mainStart") or "", event.get("espn_id") or event.get("espnId") or "", event.get("poster_url") or event.get("posterUrl") or "", event.get("venue") or "", utc_now()))
            return dict(conn.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone())

    def update_event_poster(self, event_id: str, poster_url: str) -> dict | None:
        with self.connection() as conn:
            conn.execute("UPDATE events SET poster_url=? WHERE id=?", (poster_url.strip(), event_id))
            row = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            return dict(row) if row else None

    def update_event_venue(self, event_id: str, venue: str) -> dict | None:
        with self.connection() as conn:
            conn.execute("UPDATE events SET venue=? WHERE id=?", (venue.strip(), event_id))
            row = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            return dict(row) if row else None

    def replace_event_fights(self, event_id: str, fights: list[dict]) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM fights WHERE event_id=?", (event_id,))
            for index, fight in enumerate(fights):
                conn.execute("""INSERT INTO fights(event_id,fight_index,fighter_a,fighter_b,odds_a,odds_b,is_main,weight,rounds,fight_time,ou_line,odds_source,odds_updated_at,championship)
                             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (event_id, int(fight.get("fight_index", index)), fight.get("fighter_a") or fight.get("fighterA") or "", fight.get("fighter_b") or fight.get("fighterB") or "", int(fight.get("odds_a") or fight.get("oddsA") or 0), int(fight.get("odds_b") or fight.get("oddsB") or 0), int(bool(fight.get("is_main", fight.get("main", False)))), fight.get("weight") or "", fight.get("rounds"), fight.get("fight_time") or fight.get("time") or "", fight.get("ou_line", fight.get("ouLine")), fight.get("odds_source") or fight.get("oddsSource") or "", fight.get("odds_updated_at") or fight.get("oddsUpdatedAt") or "", int(bool(fight.get("championship", False)))))

    def update_fight_odds(self, event_id: str, updates: list[dict], source: str = "the-odds-api") -> int:
        with self.connection() as conn:
            for u in updates:
                conn.execute("UPDATE fights SET odds_a=?, odds_b=?, odds_source=?, odds_updated_at=? WHERE event_id=? AND fight_index=?",
                             (u["odds_a"], u["odds_b"], source, utc_now(), event_id, u["fight_index"]))
        return len(updates)

    def list_events(self) -> list[dict]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM events ORDER BY event_date DESC, name").fetchall()
            return [dict(row) for row in rows]

    def _event_with_fights(self, conn: sqlite3.Connection, event: sqlite3.Row | None) -> dict | None:
        if not event: return None
        result = dict(event)
        result["fights"] = [{**dict(f), "matchup": f'{f["fighter_a"]} vs. {f["fighter_b"]}'} for f in conn.execute("SELECT * FROM fights WHERE event_id=? ORDER BY fight_index", (event["id"],)).fetchall()]
        return result

    def _active_event_source(self, conn: sqlite3.Connection) -> str:
        row = conn.execute("SELECT value FROM settings WHERE key='active_event_source'").fetchone()
        return row["value"] if row else "auto"

    def maybe_advance_active_event(self, now: datetime | None = None) -> dict | None:
        """After 8am ET, advance a past active event to the next upcoming card.

        A manually selected event that was already past-dated at pick time is
        deliberate history browsing and is never auto-advanced.
        """
        eastern = ZoneInfo("America/New_York")
        current = (now or datetime.now(eastern))
        if current.tzinfo is None:
            current = current.replace(tzinfo=eastern)
        current = current.astimezone(eastern)
        if current.hour < 8:
            return None
        today = current.date().isoformat()
        with self.connection() as conn:
            if self._active_event_source(conn) == "manual":
                return None
            row = conn.execute("SELECT value FROM settings WHERE key='active_event_id'").fetchone()
            if not row:
                return None
            active = conn.execute("SELECT * FROM events WHERE id=?", (row["value"],)).fetchone()
            if not active or not active["event_date"] or active["event_date"] >= today:
                return None
            upcoming = conn.execute("""SELECT * FROM events
                WHERE event_date >= ? AND EXISTS (SELECT 1 FROM fights WHERE fights.event_id=events.id)
                ORDER BY event_date ASC, name LIMIT 1""", (today,)).fetchone()
            if not upcoming or upcoming["id"] == active["id"]:
                return None
            conn.execute("INSERT INTO settings(key,value) VALUES('active_event_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (upcoming["id"],))
            conn.execute("INSERT INTO settings(key,value) VALUES('active_event_source','auto') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            result = self._event_with_fights(conn, upcoming)
            if result:
                result["auto_advanced_from"] = active["id"]
            return result

    def active_event(self, auto_advance: bool = True) -> dict | None:
        with self.connection() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='active_event_id'").fetchone()
            event_id = row["value"] if row else None
            if event_id:
                event = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            else:
                event = conn.execute("SELECT * FROM events WHERE EXISTS (SELECT 1 FROM fights WHERE fights.event_id=events.id) ORDER BY event_date ASC LIMIT 1").fetchone()
            result = self._event_with_fights(conn, event)
        if auto_advance:
            advanced = self.maybe_advance_active_event()
            if advanced: return advanced
        return result

    def set_active_event(self, event_id: str, now: datetime | None = None) -> dict | None:
        with self.connection() as conn:
            if not conn.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone(): return None
            conn.execute("INSERT INTO settings(key,value) VALUES('active_event_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (event_id,))
            # A manually picked already-past card is deliberate history browsing;
            # current/future picks keep participating in the auto-advance chain.
            event = conn.execute("SELECT event_date FROM events WHERE id=?", (event_id,)).fetchone()
            current = now or datetime.now(ZoneInfo("America/New_York"))
            if current.tzinfo is None:
                current = current.replace(tzinfo=ZoneInfo("America/New_York"))
            today = current.astimezone(ZoneInfo("America/New_York")).date().isoformat()
            source = "manual" if event["event_date"] and event["event_date"] < today else "auto"
            conn.execute("INSERT INTO settings(key,value) VALUES('active_event_source',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (source,))
        return self.active_event(auto_advance=False)

    def statistics(self, event_id: str | None = None) -> dict:
        where, args = (" WHERE event_id=?", [event_id]) if event_id else ("", [])
        with self.connection() as conn:
            rows = conn.execute(f"SELECT * FROM bets{where}", args).fetchall()
            by_book = conn.execute(f"SELECT book,COUNT(*) count,SUM(cash_stake) cash_staked,SUM(COALESCE(payout,0)) payout FROM bets{where} GROUP BY book ORDER BY cash_staked DESC,book", args).fetchall()
        bets = [dict(row) for row in rows]
        settled = [b for b in bets if b["status"] in {"win", "loss"}]
        wins = [b for b in bets if b["status"] == "win"]
        cash_staked = sum(b["cash_stake"] for b in bets if b["status"] != "void")
        profit = sum((b["payout"] or 0) - b["cash_stake"] for b in wins) - sum(b["cash_stake"] for b in bets if b["status"] == "loss")
        return {"total_bets": len(bets), "cash_staked": round(cash_staked, 2), "bonus_staked": round(sum(b["bonus_stake"] for b in bets), 2), "profit": round(profit, 2), "win_rate": round(len(wins) / len(settled), 4) if settled else None, "roi": round(profit / cash_staked, 4) if cash_staked else None, "by_book": [dict(row) for row in by_book]}

    def profit_timeline(self, event_id: str | None = None) -> dict:
        """Return realized profit points for either one live event or all events."""
        terms, args = ["b.status IN ('win','loss','void')"], []
        if event_id:
            terms.append("b.event_id=?")
            terms.append("b.status != 'void'")  # voided bets have no P/L and must not create chart matchups
            terms.append("COALESCE(b.bet_type, '') != 'Parlay'")
            args.append(event_id)
        where = " WHERE " + " AND ".join(terms)
        with self.connection() as conn:
            rows = conn.execute(f"""SELECT b.*, COALESCE(e.event_date, '') AS event_date
                FROM bets b LEFT JOIN events e ON e.id=b.event_id{where}
                ORDER BY COALESCE(e.event_date, b.placed_at), b.settled_at, b.placed_at, b.id""", args).fetchall()
            fights = conn.execute("SELECT fight_index,fighter_a,fighter_b,fight_time FROM fights WHERE event_id=?", (event_id,)).fetchall() if event_id else []
            parlay_rows = conn.execute("SELECT b.*, COALESCE(e.event_date, '') AS event_date FROM bets b LEFT JOIN events e ON e.id=b.event_id WHERE b.event_id=? AND b.status IN ('win','loss') AND COALESCE(b.bet_type, '') = 'Parlay'", (event_id,)).fetchall() if event_id else []
            bet_ids = [row["id"] for row in rows] + [row["id"] for row in parlay_rows]
            legs_by_bet: dict[str, list[dict]] = {bet_id: [] for bet_id in bet_ids}
            if bet_ids:
                placeholders = ",".join("?" for _ in bet_ids)
                for leg in conn.execute(f"SELECT * FROM bet_legs WHERE bet_id IN ({placeholders}) ORDER BY bet_id, leg_index", bet_ids).fetchall():
                    legs_by_bet.setdefault(leg["bet_id"], []).append(dict(leg))
        settled = [dict(row) for row in rows]
        settled_parlays = [dict(row) for row in parlay_rows]

        def profit(bet: dict) -> float:
            if bet["status"] == "win": return float(bet["payout"] or 0) - float(bet["cash_stake"] or 0)
            if bet["status"] == "loss": return -float(bet["cash_stake"] or 0)
            return 0.0

        if event_id:
            card_order: dict[str, tuple] = {}
            card_labels: dict[str, str] = {}
            for fight in fights:
                matchup = f'{fight["fighter_a"]} vs. {fight["fighter_b"]}'
                normalized = normalized_matchup(matchup)
                start = scheduled_minutes(fight["fight_time"])
                # Use the scheduled bout start when provided; catalog fight_index is the durable fallback.
                card_order[normalized] = (0, start, fight["fight_index"]) if start is not None else (1, fight["fight_index"], 0)
                card_labels[normalized] = matchup
            def timeline_matchup(bet: dict) -> str:
                legs = [leg for leg in legs_by_bet.get(bet["id"], []) if leg.get("fight_name")]
                leg_matchups = {normalized_matchup(leg["fight_name"]): leg["fight_name"] for leg in legs}
                if bet.get("bet_type") == "Parlay" and len(leg_matchups) == 1:
                    normalized, label = next(iter(leg_matchups.items()))
                    return card_labels.get(normalized, label)
                return bet["fight_name"] or "Custom matchup"
            grouped: dict[str, dict] = {}
            for bet in settled:
                matchup = timeline_matchup(bet)
                group = grouped.setdefault(matchup, {"event_id": bet["event_id"], "label": matchup, "profit": 0.0, "settled": 0, "first_settled_at": bet["settled_at"], "first_placed_at": bet["placed_at"], "card_order": card_order.get(normalized_matchup(matchup))})
                group["profit"] += profit(bet); group["settled"] += 1
                group["first_settled_at"] = min(group["first_settled_at"] or bet["settled_at"], bet["settled_at"] or group["first_settled_at"])
            running, points = 0.0, []
            for index, group in enumerate(sorted(grouped.values(), key=lambda value: (value["card_order"] is None, value["card_order"] or (9, 0, 0), value["first_settled_at"] or value["first_placed_at"], value["label"])), 1):
                group["profit"] = round(group["profit"], 2); running += group["profit"]
                points.append({"index": index, "label": group["label"], "event_id": group["event_id"], "profit": group["profit"], "settled": group["settled"], "cumulative_profit": round(running, 2), "settled_at": group["first_settled_at"], "card_order": group["card_order"]})
            parlay_grouped: dict[str, dict] = {}
            for bet in settled_parlays:
                net = profit(bet)
                leg_labels: dict[str, str] = {}
                for leg in legs_by_bet.get(bet["id"], []):
                    name = leg.get("fight_name")
                    if name: leg_labels.setdefault(normalized_matchup(name), name)
                targets = [card_labels.get(norm, raw) for norm, raw in leg_labels.items()] or [bet["fight_name"] or "Custom matchup"]
                for label in targets:
                    group = parlay_grouped.setdefault(label, {"label": label, "profit": 0.0, "settled": 0, "first_settled_at": bet["settled_at"], "card_order": card_order.get(normalized_matchup(label))})
                    group["profit"] += net / len(targets); group["settled"] += 1
                    group["first_settled_at"] = min(group["first_settled_at"] or bet["settled_at"], bet["settled_at"] or group["first_settled_at"])
            running, parlay_points = 0.0, []
            for index, group in enumerate(sorted(parlay_grouped.values(), key=lambda value: (value["card_order"] is None, value["card_order"] or (9, 0, 0), value["first_settled_at"] or "", value["label"])), 1):
                group["profit"] = round(group["profit"], 2); running += group["profit"]
                parlay_points.append({"index": index, "label": group["label"], "event_id": event_id, "profit": group["profit"], "settled": group["settled"], "cumulative_profit": round(running, 2), "settled_at": group["first_settled_at"], "attributed": True, "card_order": group["card_order"]})
            def series_order(label: str) -> tuple:
                for source in (points, parlay_points):
                    for point in source:
                        if point["label"] == label:
                            order = point.get("card_order")
                            return (order is None, order or (9, 0, 0), label)
                return (True, (9, 0, 0), label)
            axis = sorted({point["label"] for point in points} | {point["label"] for point in parlay_points}, key=series_order)
            straight_by = {point["label"]: point["profit"] for point in points}
            # Combined line: straight P/L plus each parlay's net split evenly across its distinct leg matchups.
            share_by = {point["label"]: point["profit"] for point in parlay_points}
            parlay_series = []
            parlay_run = 0.0
            for label in axis:
                parlay_run += straight_by.get(label, 0.0) + share_by.get(label, 0.0)
                parlay_series.append(round(parlay_run, 2))
            straight_series = []
            straight_run = 0.0
            for label in axis:
                straight_run += straight_by.get(label, 0.0)
                straight_series.append(round(straight_run, 2))
            return {"scope": "active", "event_id": event_id, "points": points, "parlay_points": parlay_points, "series": {"labels": axis, "straight_cumulative": straight_series, "parlay_cumulative": parlay_series}}

        grouped: dict[str, dict] = {}
        for bet in settled:
            group = grouped.setdefault(bet["event_id"], {"event_id": bet["event_id"], "label": bet["event_name"] or bet["event_id"], "event_date": bet["event_date"], "profit": 0.0, "settled": 0})
            group["profit"] += profit(bet); group["settled"] += 1
        running, points = 0.0, []
        for group in sorted(grouped.values(), key=lambda value: (value["event_date"], value["label"], value["event_id"])):
            group["profit"] = round(group["profit"], 2); running += group["profit"]
            points.append({**group, "cumulative_profit": round(running, 2)})
        return {"scope": "all", "event_id": None, "points": points}

    def _watch_norm(self, text: Any) -> str:
        normalized = str(text or "").lower().replace("dooho", "doo ho").replace("joosang", "joo sang").replace("tko", "ko").replace(".", "").strip()
        decomposed = unicodedata.normalize("NFKD", normalized)
        return "".join(char for char in decomposed if not unicodedata.combining(char))

    def _watch_fight_key(self, fight: dict) -> str:
        return self._watch_norm(f"{fight['fighter_a']} vs {fight['fighter_b']}")

    def _watch_profit(self, bet: dict, win: bool) -> float:
        cash, bonus, price = float(bet.get("cash_stake") or 0), float(bet.get("bonus_stake") or 0), int(bet.get("american_odds") or 0)
        if not win:
            return -cash
        return (cash + bonus) * (price / 100 if price > 0 else 100 / abs(price))

    def _watch_resolve_fight(self, fights: list[dict], fight_name: str) -> dict:
        key = self._watch_norm(fight_name)
        for fight in fights:
            a, b = self._watch_norm(fight["fighter_a"]), self._watch_norm(fight["fighter_b"])
            if (a in key and b in key) or (a.split()[-1] in key and b.split()[-1] in key):
                return fight
        return None

    def _watch_predicate(self, fights: list[dict], selection: str, market: str, fight_name: str, outcome: MoneyOutcome) -> bool:
        if self._watch_resolve_fight(fights, fight_name) is None: return False
        text, market_text = self._watch_norm(selection), self._watch_norm(market)
        winner, distance = self._watch_norm(outcome.winner), outcome.method == "points"
        if "under 1.5" in text: return (not distance) and outcome.round == 1
        if "over 1.5" in text: return distance or bool(outcome.round and outcome.round >= 2)
        if "under 2.5" in text: return (not distance) and outcome.round in (1, 2)
        if "over 2.5" in text: return distance or outcome.round == 3
        if "fight does go the distance" in text or market_text in {"yes", "no"}:
            return (not distance) if ("no" in text or market_text == "no") else distance
        fight = self._watch_resolve_fight(fights, fight_name)
        named = next((candidate for candidate in (self._watch_norm(fight["fighter_a"]), self._watch_norm(fight["fighter_b"])) if candidate in text or candidate.split()[-1] in text), None)
        if not named or named != winner: return False
        if re.search(r"[+]\d+(?:\.5)?", text): return True
        if "ko or submission" in text or market_text == "ko or submission":
            if outcome.method not in {"ko", "submission"}: return False
        elif "submission" in text or market_text == "submission":
            if outcome.method != "submission": return False
        elif "ko" in text or market_text in {"ko", "ko/ko", "ko/tko"}:
            if outcome.method != "ko": return False
        elif "points" in text or "decision" in text or market_text in {"points", "decision"}:
            if outcome.method != "points": return False
        match = re.search(r"round\s*(\d)", text)
        if match and (distance or outcome.round != int(match.group(1))): return False
        return True

    def _watch_bet_win(self, fights: list[dict], bet: dict, outcomes: dict[str, MoneyOutcome]) -> bool | None:
        legs = bet["legs"] if bet.get("bet_type") == "Parlay" else [bet]
        for leg in legs:
            fight = self._watch_resolve_fight(fights, leg["fight_name"])
            if fight is None: return None
            key = self._watch_fight_key(fight)
            if key not in outcomes: return None
            if not self._watch_predicate(fights, leg.get("selection", ""), leg.get("market", ""), leg["fight_name"], outcomes[key]):
                return False
        return True

    def watch_guide(self, event_id: str, beam: int = 500, lottery_threshold: int | None = 10000) -> dict:
        with self.connection() as conn:
            event = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            if not event: raise ValueError("event not found")
            fights = [dict(row) for row in conn.execute("SELECT * FROM fights WHERE event_id=? ORDER BY fight_index", (event_id,)).fetchall()]
            bets = []
            for row in conn.execute("SELECT * FROM bets WHERE event_id=? AND status='pending'", (event_id,)).fetchall():
                bet = dict(row)
                bet["legs"] = [dict(leg) for leg in conn.execute("SELECT * FROM bet_legs WHERE bet_id=? ORDER BY leg_index", (bet["id"],)).fetchall()]
                bets.append(bet)
        relevant_legs = [leg for bet in bets for leg in (bet["legs"] if bet.get("bet_type") == "Parlay" else [bet]) if self._watch_resolve_fight(fights, leg["fight_name"]) is not None]
        unmapped: list[dict] = []
        def note_unmapped(bet: dict, items: list[dict]) -> None:
            for item in items:
                if self._watch_resolve_fight(fights, item["fight_name"]) is None:
                    unmapped.append({"bet_id": bet["id"], "fight_name": item["fight_name"], "selection": item.get("selection") or "", "bet_type": bet.get("bet_type") or ""})
        for bet in bets:
            note_unmapped(bet, bet.get("legs", []) if bet.get("bet_type") == "Parlay" else [bet])
        def candidates_for(fight: dict) -> list[MoneyOutcome]:
            max_rounds = int(fight.get("rounds") or (5 if fight.get("championship") else 3))
            universe = [MoneyOutcome(fighter, method, rnd) for fighter, method in itertools.product([fight["fighter_a"], fight["fighter_b"]], ["ko", "submission", "points"]) for rnd in ([None] if method == "points" else list(range(1, max_rounds + 1)))]
            related = [leg for leg in relevant_legs if self._watch_resolve_fight(fights, leg["fight_name"]) == fight]
            chosen = [outcome for outcome in universe if any(self._watch_predicate(fights, leg.get("selection", ""), leg.get("market", ""), leg["fight_name"], outcome) for leg in related)] + universe
            dedup, seen = [], set()
            for outcome in chosen:
                marker = (outcome.winner, outcome.method, outcome.round)
                if marker not in seen: seen.add(marker); dedup.append(outcome)
            return dedup
        def is_lottery(bet: dict) -> bool:
            return bool(lottery_threshold and int(bet.get("american_odds") or 0) >= lottery_threshold)
        def score(outcomes: dict[str, MoneyOutcome]) -> float:
            total = 0.0
            for bet in bets:
                if is_lottery(bet): continue
                win = self._watch_bet_win(fights, bet, outcomes)
                if win is not None: total += self._watch_profit(bet, bool(win))
            return total
        states = [{}]
        for fight in fights:
            key = self._watch_fight_key(fight)
            next_states = []
            for base in states:
                for outcome in candidates_for(fight):
                    merged = dict(base); merged[key] = outcome; next_states.append(merged)
            next_states.sort(key=score, reverse=True)
            states = next_states[:beam]
        best = (sorted(states, key=score, reverse=True) or [{}])[0]
        wins, losses = [], []
        for bet in bets:
            win = self._watch_bet_win(fights, bet, best)
            if win is None: continue
            profit = self._watch_profit(bet, bool(win))
            (wins if win else losses).append({"profit": round(profit, 2), "id": bet["id"], "fight_name": bet["fight_name"], "selection": bet["selection"], "american_odds": bet["american_odds"], "cash_stake": bet["cash_stake"], "bonus_stake": bet["bonus_stake"], "is_lottery": is_lottery(bet), "legs": bet["legs"]})
        def label(outcome: MoneyOutcome) -> str:
            return f"{outcome.winner} by Decision" if outcome.method == "points" else f"{outcome.winner} by {outcome.method.upper()} Round {outcome.round}"
        matchup_rows = []
        for fight in fights:
            key = self._watch_fight_key(fight); outcome = best.get(key)
            matchup = f'{fight["fighter_a"]} vs. {fight["fighter_b"]}'
            related = [bet for bet in bets if (self._watch_resolve_fight(fights, bet["fight_name"]) if bet.get("bet_type") != "Parlay" else None) is fight or any(self._watch_resolve_fight(fights, leg["fight_name"]) is fight for leg in bet.get("legs", []))]
            matchup_rows.append({"fight_index": fight["fight_index"], "matchup": matchup, "fighter_a": fight["fighter_a"], "fighter_b": fight["fighter_b"], "best_outcome": None if not outcome else {"winner": outcome.winner, "method": outcome.method, "round": outcome.round, "time": None, "label": label(outcome)}, "pending_bets": len(related), "pending_cash": round(sum(float(b.get("cash_stake") or 0) for b in related), 2)})
        return {"event": dict(event), "pending_bets": len(bets), "pending_cash_stake": round(sum(float(b.get("cash_stake") or 0) for b in bets), 2), "estimated_scored_net": round(sum(item["profit"] for item in wins + losses if not item["is_lottery"]), 2), "estimated_all_ticket_net": round(sum(item["profit"] for item in wins + losses), 2), "wins": len(wins), "losses": len(losses), "lottery_excluded": sum(1 for item in wins + losses if item["is_lottery"]), "unmapped": unmapped, "matchups": matchup_rows, "largest_winning_tickets": sorted(wins, key=lambda item: item["profit"], reverse=True)[:12]}

    # ---- Fight results & disputes. Never reads-for-write or writes bets/bet_legs: results are display/what-if data only. ----
    @staticmethod
    def _rnorm(text: Any) -> str:
        return "".join(c for c in unicodedata.normalize("NFKD", str(text or "").lower()) if c.isalnum() or c == " ").strip()

    def _rkey(self, a: str, b: str) -> str:
        return "|".join(sorted([self._rnorm(a), self._rnorm(b)]))

    def _result_view(self, row: sqlite3.Row, fights: list[dict]) -> dict:
        r = dict(row)
        fight = next((f for f in fights if self._rkey(f["fighter_a"], f["fighter_b"]) == r["fight_key"]), None)
        r["fight_index"] = fight["fight_index"] if fight else None
        r["matchup"] = f'{fight["fighter_a"]} vs. {fight["fighter_b"]}' if fight else f'{r["fighter_a"]} vs. {r["fighter_b"]}'
        r["winner_side"] = None
        if fight:
            r["winner_side"] = "a" if self._rnorm(r["winner"]) == self._rnorm(fight["fighter_a"]) else "b" if self._rnorm(r["winner"]) == self._rnorm(fight["fighter_b"]) else None
        return r

    def list_results(self, event_id: str) -> dict:
        with self.connection() as conn:
            fights = [dict(x) for x in conn.execute("SELECT * FROM fights WHERE event_id=? ORDER BY fight_index", (event_id,)).fetchall()]
            results = [self._result_view(x, fights) for x in conn.execute("SELECT * FROM fight_results WHERE event_id=?", (event_id,)).fetchall()]
            disputes = []
            for x in conn.execute("SELECT * FROM result_disputes WHERE event_id=? ORDER BY status DESC, id DESC", (event_id,)).fetchall():
                d = dict(x); d["detail"] = json.loads(d["detail"] or "{}"); disputes.append(d)
        return {"results": [r for r in results if r["fight_index"] is not None], "disputes": disputes}

    def _open_dispute(self, conn, event_id: str, kind: str, dkey: str, fight_key: str, detail: dict) -> bool:
        cur = conn.execute("INSERT OR IGNORE INTO result_disputes(event_id,kind,dkey,fight_key,detail,created_at) VALUES(?,?,?,?,?,?)", (event_id, kind, dkey, fight_key, json.dumps(detail), utc_now()))
        return cur.rowcount > 0

    def set_result(self, event_id: str, fight_index: int, winner_side: str, method: str, rnd: int | None, clock: str = "", source: str = "manual") -> dict:
        if winner_side not in ("a", "b"): raise ValueError("winner must be a or b")
        if method not in ("ko", "sub", "dec"): raise ValueError("method must be ko, sub or dec")
        if method != "dec" and (rnd is None or not 1 <= int(rnd) <= 5): raise ValueError("finish needs round 1-5")
        clock = "" if method == "dec" else clean_clock(clock)
        with self.connection() as conn:
            fight = conn.execute("SELECT * FROM fights WHERE event_id=? AND fight_index=?", (event_id, fight_index)).fetchone()
            if not fight: raise ValueError("fight not found")
            key = self._rkey(fight["fighter_a"], fight["fighter_b"])
            conn.execute("""INSERT INTO fight_results(event_id,fight_key,fighter_a,fighter_b,winner,method,round,clock,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(event_id,fight_key) DO UPDATE SET winner=excluded.winner,method=excluded.method,round=excluded.round,clock=excluded.clock,source=excluded.source,updated_at=excluded.updated_at""",
                (event_id, key, fight["fighter_a"], fight["fighter_b"], fight["fighter_a"] if winner_side == "a" else fight["fighter_b"], method, None if method == "dec" and rnd is None else int(rnd), clock, source, utc_now()))
            # Declaring a result settles any open result-vs-result dispute for this fight (bet disputes stay until reviewed).
            conn.execute("UPDATE result_disputes SET status='resolved',resolution='manual_override',resolved_at=? WHERE event_id=? AND fight_key=? AND kind='result' AND status='open'", (utc_now(), event_id, key))
        return self.list_results(event_id)

    def clear_result(self, event_id: str, fight_index: int) -> dict:
        with self.connection() as conn:
            fight = conn.execute("SELECT * FROM fights WHERE event_id=? AND fight_index=?", (event_id, fight_index)).fetchone()
            if not fight: raise ValueError("fight not found")
            conn.execute("DELETE FROM fight_results WHERE event_id=? AND fight_key=?", (event_id, self._rkey(fight["fighter_a"], fight["fighter_b"])))
        return self.list_results(event_id)

    def apply_espn_results(self, event_id: str, items: list[dict]) -> dict:
        """items: {fighter_a,fighter_b,winner,method,round,clock}. Insert when empty; same -> no-op; different -> open dispute, never overwrite."""
        summary = {"created": 0, "unchanged": 0, "disputed": 0, "skipped": 0, "filled": 0}
        with self.connection() as conn:
            for it in items:
                key = self._rkey(it["fighter_a"], it["fighter_b"])
                if not conn.execute("SELECT 1 FROM fights WHERE event_id=?", (event_id,)).fetchone() or it.get("method") not in ("ko", "sub", "dec") or not it.get("winner"):
                    summary["skipped"] += 1; continue
                cur = conn.execute("SELECT * FROM fight_results WHERE event_id=? AND fight_key=?", (event_id, key)).fetchone()
                if not cur:
                    conn.execute("INSERT INTO fight_results(event_id,fight_key,fighter_a,fighter_b,winner,method,round,clock,source,updated_at) VALUES(?,?,?,?,?,?,?,?,'espn',?)", (event_id, key, it["fighter_a"], it["fighter_b"], it["winner"], it["method"], it.get("round"), it.get("clock") or "", utc_now()))
                    summary["created"] += 1; continue
                same = self._rnorm(cur["winner"]) == self._rnorm(it["winner"]) and cur["method"] == it["method"] and (cur["method"] == "dec" or cur["round"] == it.get("round"))
                if same:
                    # Same winner/method/round: only back-fill a missing finish time; never touches anything else.
                    try: espn_clock = clean_clock(it.get("clock")) if it["method"] != "dec" else ""
                    except ValueError: espn_clock = ""
                    if espn_clock and not cur["clock"]:
                        conn.execute("UPDATE fight_results SET clock=?,updated_at=? WHERE event_id=? AND fight_key=?", (espn_clock, utc_now(), event_id, key)); summary["filled"] += 1
                    else: summary["unchanged"] += 1
                    continue
                sig = f'{self._rnorm(it["winner"])}:{it["method"]}:{it.get("round")}<-{self._rnorm(cur["winner"])}:{cur["method"]}:{cur["round"]}'
                opened = self._open_dispute(conn, event_id, "result", f"result:{key}:{sig}", key, {"current": {k: cur[k] for k in ("winner", "method", "round", "clock", "source")}, "proposed": {"winner": it["winner"], "method": it["method"], "round": it.get("round"), "clock": it.get("clock") or "", "source": "espn"}, "fighter_a": it["fighter_a"], "fighter_b": it["fighter_b"]})
                summary["disputed"] += 1 if opened else 0
                summary["unchanged"] += 0 if opened else 1
        return summary

    def register_bet_conflicts(self, event_id: str, conflicts: list[dict]) -> dict:
        n = 0
        with self.connection() as conn:
            for c in conflicts:
                if self._open_dispute(conn, event_id, "bet", str(c["dkey"])[:300], str(c.get("fight_key") or ""), c.get("detail") or {}): n += 1
        return {"registered": n}

    def resolve_dispute(self, dispute_id: int, resolution: str, note: str = "") -> dict:
        if resolution not in ("keep", "accept", "dismiss"): raise ValueError("resolution must be keep, accept or dismiss")
        with self.connection() as conn:
            d = conn.execute("SELECT * FROM result_disputes WHERE id=?", (dispute_id,)).fetchone()
            if not d: raise ValueError("dispute not found")
            if d["status"] != "open": raise ValueError("dispute already resolved")
            detail = json.loads(d["detail"] or "{}")
            if resolution == "accept":
                if d["kind"] != "result": raise ValueError("only result disputes can accept a proposed result")
                p = detail["proposed"]
                conn.execute("UPDATE fight_results SET winner=?,method=?,round=?,clock=?,source=?,updated_at=? WHERE event_id=? AND fight_key=?", (p["winner"], p["method"], p.get("round"), p.get("clock") or "", p.get("source") or "espn", utc_now(), d["event_id"], d["fight_key"]))
            conn.execute("UPDATE result_disputes SET status='resolved',resolution=?,note=?,resolved_at=? WHERE id=?", (resolution, note[:500], utc_now(), dispute_id))
            event_id = d["event_id"]
        return self.list_results(event_id)

    def export(self) -> dict:
        return {"exported_at": utc_now(), "bets": self.list_bets(), "events": self.list_events(), "active_event": self.active_event(), "dashboard": self.dashboard(), "statistics": self.statistics()}
