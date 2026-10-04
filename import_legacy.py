"""Lossless mapping from the legacy tracker JSON records to v3 rows."""
import json
from typing import Any

VALID_STATUS = {"win", "loss", "pending"}


def normalized_status(value: Any) -> str:
    status = str(value or "Pending").strip().lower()
    return status if status in VALID_STATUS else "pending"


def map_legacy_bet(raw: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Map one legacy record; retain raw JSON for fields not yet modeled."""
    if not isinstance(raw, dict) or not raw.get("id"):
        raise ValueError("legacy bet requires a non-empty id")
    bet_type = raw.get("betType") or raw.get("type") or ""
    is_parlay = bool(raw.get("isParlay", False))
    bet = {
        "legacy_id": str(raw["id"]),
        "event_id": str(raw.get("eventId") or ""),
        "book": str(raw.get("book") or ""),
        "fight_name": str(raw.get("fightName") or ""),
        "selection": str(raw.get("selection") or ""),
        "bet_type": str(bet_type),
        "status": normalized_status(raw.get("result")),
        "is_parlay": is_parlay,
        "american_odds": int(raw.get("odds") or 0),
        "stake": float(raw.get("wager") or 0),
        "payout": float(raw.get("payout") or 0),
        "legacy_net_pnl": raw.get("netPnL"),
        "notes": str(raw.get("notes") or ""),
        "is_bonus_bet": bool(raw.get("isBonusBet", False)),
        "is_live_stream": bool(raw.get("isLiveStream", False)),
        "source_json": json.dumps(raw, separators=(",", ":"), ensure_ascii=False),
    }
    if bet["legacy_net_pnl"] is not None:
        bet["legacy_net_pnl"] = float(bet["legacy_net_pnl"])

    legs = []
    for index, leg in enumerate(raw.get("legs") or []):
        if not isinstance(leg, dict):
            continue
        odds = leg.get("odds")
        legs.append({
            "bet_legacy_id": bet["legacy_id"],
            "leg_index": index,
            "fight_name": str(leg.get("fightName") or ""),
            "selection": str(leg.get("selection") or ""),
            "status": normalized_status(leg.get("result")),
            "american_odds": int(odds) if odds is not None else None,
        })
    return bet, legs
