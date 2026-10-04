"""The Odds API (the-odds-api.com) moneyline refresh. Key comes from THE_ODDS_API_KEY only."""
import json, os, unicodedata
from urllib.parse import urlencode
from urllib.request import urlopen

URL = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/"


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().lower()
    return "".join(c for c in s if c.isalnum())


def fetch_moneylines(bookmakers: str = "draftkings,fanduel") -> dict[frozenset, dict[str, int]]:
    """Return {frozenset({normA, normB}): {normName: american_price}} using the first listed book that has the fight."""
    key = os.environ.get("THE_ODDS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("THE_ODDS_API_KEY is not set")
    query = urlencode({"apiKey": key, "regions": "us", "markets": "h2h", "oddsFormat": "american", "bookmakers": bookmakers})
    with urlopen(f"{URL}?{query}", timeout=20) as response:
        events = json.load(response)
    order = bookmakers.split(",")
    result: dict[frozenset, dict[str, int]] = {}
    for event in events:
        books = sorted(event.get("bookmakers", []), key=lambda b: order.index(b["key"]) if b["key"] in order else 99)
        for book in books:
            market = next((m for m in book.get("markets", []) if m.get("key") == "h2h"), None)
            if not market or len(market.get("outcomes", [])) != 2:
                continue
            prices = {_norm(o["name"]): int(round(o["price"])) for o in market["outcomes"]}
            result[frozenset(prices)] = prices
            break
    return result


def match_prices(fights: list[dict], lines: dict[frozenset, dict[str, int]]) -> tuple[list[dict], list[str]]:
    updates, missing = [], []
    for fight in fights:
        a, b = _norm(fight["fighter_a"]), _norm(fight["fighter_b"])
        prices = lines.get(frozenset({a, b}))
        if prices and a in prices and b in prices:
            updates.append({"fight_index": fight["fight_index"], "odds_a": prices[a], "odds_b": prices[b]})
        else:
            missing.append(f'{fight["fighter_a"]} vs. {fight["fighter_b"]}')
    return updates, missing
