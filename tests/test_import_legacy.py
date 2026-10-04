import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from import_legacy import map_legacy_bet


class LegacyImportTests(unittest.TestCase):
    def test_maps_current_parlay_and_preserves_ordered_legs(self):
        raw = {
            "id": "1780000000000", "eventId": "event_test", "book": "DK",
            "fightName": "Multiple Fights", "selection": "Parlay", "betType": "Parlay",
            "result": "Loss", "isParlay": True, "odds": 240, "wager": 10,
            "payout": 34, "isBonusBet": True, "isLiveStream": False, "notes": "test",
            "legs": [
                {"fightName": "A vs B", "selection": "A ML", "result": "Win", "odds": -110},
                {"fightName": "C vs D", "selection": "Over", "result": "Pending"},
            ],
        }
        bet, legs = map_legacy_bet(raw)
        self.assertEqual(bet["legacy_id"], "1780000000000")
        self.assertEqual(bet["status"], "loss")
        self.assertTrue(bet["is_parlay"])
        self.assertTrue(bet["is_bonus_bet"])
        self.assertEqual([leg["leg_index"] for leg in legs], [0, 1])
        self.assertEqual(legs[0]["american_odds"], -110)
        self.assertIsNone(legs[1]["american_odds"])

    def test_maps_old_cohort_type_and_nullable_net_pnl(self):
        bet, legs = map_legacy_bet({
            "id": "old-1", "eventId": "event_old", "book": "FD", "fightName": "A vs B",
            "selection": "A", "type": "ML", "result": "Win", "isParlay": False,
            "odds": -140, "wager": 5, "payout": 8.57, "netPnL": 3.57,
        })
        self.assertEqual(bet["bet_type"], "ML")
        self.assertEqual(bet["status"], "win")
        self.assertEqual(bet["legacy_net_pnl"], 3.57)
        self.assertEqual(legs, [])


if __name__ == "__main__":
    unittest.main()
