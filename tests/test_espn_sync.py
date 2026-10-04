import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import app
from db import TrackerRepository


class EspnSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_repo = app.repo
        self.repo = TrackerRepository(Path(self.tmp.name) / "tracker.db")
        self.repo.initialize()
        app.repo = self.repo
        self.repo.upsert_event({"id": "event-a", "name": "UFC Test", "event_date": "2026-09-19", "espn_id": "123"})
        self.repo.replace_event_fights("event-a", [
            {"fighter_a": "Removed A", "fighter_b": "Removed B", "odds_a": 200, "odds_b": -240, "weight": "Lightweight", "is_main": True},
            {"fighter_a": "Keep A", "fighter_b": "Keep B", "odds_a": 155, "odds_b": -180, "weight": "Featherweight", "is_main": True, "rounds": 5},
        ])

    def tearDown(self):
        app.repo = self.old_repo
        self.tmp.cleanup()

    def test_espn_card_parser_replaces_removed_bouts_and_preserves_matching_odds(self):
        espn_event = {"id": "123", "name": "UFC Test", "competitions": [
            {"date": "2026-09-19T23:00Z", "type": {"abbreviation": "Featherweight"}, "competitors": [
                {"athlete": {"displayName": "Keep A"}}, {"athlete": {"displayName": "Keep B"}}
            ]},
            {"date": "2026-09-20T01:00Z", "type": {"abbreviation": "Heavyweight"}, "competitors": [
                {"athlete": {"displayName": "Replacement A"}}, {"athlete": {"displayName": "Replacement B"}}
            ]},
        ]}
        fights = app._espn_event_to_fights("event-a", espn_event)
        matchups = [f"{fight['fighter_a']} vs. {fight['fighter_b']}" for fight in fights]
        self.assertEqual(matchups, ["Keep A vs. Keep B", "Replacement A vs. Replacement B"])
        self.assertEqual(fights[0]["odds_a"], 155)
        self.assertEqual(fights[0]["rounds"], 5)
        self.assertEqual(fights[1]["odds_a"], -110)
        self.assertEqual(fights[1]["fight_time"], "9:00 PM ET")
        self.assertTrue(fights[1]["is_main"])

    def test_espn_date_window_covers_overnight_ufc_cards(self):
        self.assertEqual(app._espn_date_window("2026-09-19"), "20260918-20260920")


if __name__ == "__main__":
    unittest.main()
