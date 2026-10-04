import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from db import TrackerRepository


class WatchGuideTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = TrackerRepository(Path(self.tmp.name) / "tracker.db")
        self.repo.initialize()
        self.repo.upsert_event({"id": "event-watch", "name": "UFC Watch", "date": "2026-09-19"})
        self.repo.replace_event_fights("event-watch", [
            {"fight_index": 0, "fighter_a": "Alpha One", "fighter_b": "Beta Two", "rounds": 3},
            {"fight_index": 1, "fighter_a": "Gamma Three", "fighter_b": "Delta Four", "rounds": 3},
        ])

    def tearDown(self):
        self.tmp.cleanup()

    def test_watch_guide_recalculates_best_outcome_from_pending_bets(self):
        self.repo.create_bet({"event_id": "event-watch", "event_name": "UFC Watch", "book": "DK", "fight_name": "Alpha One vs. Beta Two", "selection": "Alpha One by KO in Round 2", "bet_type": "Fighter Parlay", "market": "KO", "american_odds": 900, "cash_stake": 5})
        guide = self.repo.watch_guide("event-watch")
        alpha = guide["matchups"][0]
        self.assertEqual(alpha["best_outcome"]["winner"], "Alpha One")
        self.assertEqual(alpha["best_outcome"]["method"], "ko")
        self.assertEqual(alpha["best_outcome"]["round"], 2)
        self.repo.create_bet({"event_id": "event-watch", "event_name": "UFC Watch", "book": "FD", "fight_name": "Alpha One vs. Beta Two", "selection": "Beta Two by Submission in Round 1", "bet_type": "Fighter Parlay", "market": "Submission", "american_odds": 3000, "cash_stake": 10})
        changed = self.repo.watch_guide("event-watch")
        self.assertEqual(changed["matchups"][0]["best_outcome"]["winner"], "Beta Two")
        self.assertEqual(changed["matchups"][0]["best_outcome"]["method"], "submission")
        self.assertEqual(changed["matchups"][0]["best_outcome"]["round"], 1)

    def test_watch_guide_includes_parlay_legs_for_matchup_counts(self):
        self.repo.create_bet({
            "event_id": "event-watch", "event_name": "UFC Watch", "book": "DK", "fight_name": "2-leg parlay", "selection": "Parlay", "bet_type": "Parlay", "american_odds": 500, "cash_stake": 4,
            "legs": [
                {"fight_name": "Alpha One vs. Beta Two", "selection": "Alpha One"},
                {"fight_name": "Gamma Three vs. Delta Four", "selection": "Gamma Three by KO in Round 1", "market": "KO"},
            ],
        })
        guide = self.repo.watch_guide("event-watch")
        self.assertEqual([row["pending_bets"] for row in guide["matchups"]], [1, 1])
        self.assertEqual(guide["pending_cash_stake"], 4)

    def test_watch_guide_maps_unaccented_bet_to_accented_card(self):
        self.repo.replace_event_fights("event-watch", [
            {"fight_index": 0, "fighter_a": "Roberto Soldić", "fighter_b": "Khaos Williams", "rounds": 3},
            {"fight_index": 1, "fighter_a": "Alpha One", "fighter_b": "Beta Two", "rounds": 3},
        ])
        self.repo.create_bet({"event_id": "event-watch", "event_name": "UFC Watch", "book": "DK", "fight_name": "Roberto Soldic vs. Khaos Williams", "selection": "Roberto Soldic by KO in Round 2", "bet_type": "Fighter Parlay", "market": "KO", "american_odds": 900, "cash_stake": 5})
        guide = self.repo.watch_guide("event-watch")
        soldic = guide["matchups"][0]
        self.assertEqual(soldic["matchup"], "Roberto Soldić vs. Khaos Williams")
        self.assertEqual(soldic["pending_bets"], 1)
        self.assertEqual(soldic["best_outcome"]["winner"], "Roberto Soldić")
        self.assertEqual(soldic["best_outcome"]["round"], 2)

    def test_watch_guide_maps_unaccented_parlay_leg_to_accented_card(self):
        self.repo.replace_event_fights("event-watch", [
            {"fight_index": 0, "fighter_a": "Roberto Soldić", "fighter_b": "Khaos Williams", "rounds": 3},
        ])
        self.repo.create_bet({
            "event_id": "event-watch", "event_name": "UFC Watch", "book": "DK", "fight_name": "2 Pick Parlay", "selection": "Parlay", "bet_type": "Parlay", "american_odds": 400, "cash_stake": 2,
            "legs": [
                {"fight_name": "Roberto Soldic vs. Khaos Williams", "selection": "Roberto Soldic"},
            ],
        })
        guide = self.repo.watch_guide("event-watch")
        self.assertEqual(guide["matchups"][0]["pending_bets"], 1)

    def test_watch_guide_skips_bets_unmapped_to_card(self):
        self.repo.create_bet({"event_id": "event-watch", "event_name": "UFC Watch", "book": "DK", "fight_name": "Ghost Fighter vs. Phantom Opponent", "selection": "Ghost Fighter", "bet_type": "Moneyline", "american_odds": 150, "cash_stake": 5})
        guide = self.repo.watch_guide("event-watch")
        self.assertEqual([row["matchup"] for row in guide["matchups"]], ["Alpha One vs. Beta Two", "Gamma Three vs. Delta Four"])
        self.assertEqual([u["fight_name"] for u in guide["unmapped"]], ["Ghost Fighter vs. Phantom Opponent"])
        self.assertEqual(guide["losses"], 0)
        self.assertEqual(guide["matchups"][0]["pending_bets"], 0)


if __name__ == "__main__":
    unittest.main()
