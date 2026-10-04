import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parents[1]))
from db import TrackerRepository


class EventAndStatisticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = TrackerRepository(Path(self.tmp.name) / "tracker.db")
        self.repo.initialize()

    def tearDown(self):
        self.tmp.cleanup()

    def test_active_event_includes_its_card_and_can_be_changed(self):
        self.repo.upsert_event({"id": "event-a", "name": "Event A", "event_date": "2026-09-12", "prelims_start": "6:00 PM ET", "main_start": "10:00 PM ET", "espn_id": "123"})
        self.repo.replace_event_fights("event-a", [{"fight_index": 0, "fighter_a": "Alpha", "fighter_b": "Bravo", "odds_a": -150, "odds_b": 130, "is_main": True, "weight": "Lightweight", "rounds": 5}])
        self.repo.set_active_event("event-a")
        active = self.repo.active_event()
        self.assertEqual(active["id"], "event-a")
        self.assertEqual(active["fights"][0]["matchup"], "Alpha vs. Bravo")
        self.assertEqual(active["fights"][0]["odds_a"], -150)

    def test_active_event_auto_advances_after_8am_et_when_current_card_is_past(self):
        self.repo.upsert_event({"id": "ufc-331", "name": "UFC 331", "event_date": "2026-09-19"})
        self.repo.replace_event_fights("ufc-331", [{"fighter_a": "Old", "fighter_b": "Card"}])
        self.repo.upsert_event({"id": "dwcs-week-7", "name": "DWCS Week 7", "event_date": "2026-09-22"})
        self.repo.replace_event_fights("dwcs-week-7", [{"fighter_a": "Next", "fighter_b": "Card"}])
        self.repo.upsert_event({"id": "later", "name": "Later", "event_date": "2026-09-29"})
        self.repo.replace_event_fights("later", [{"fighter_a": "Later", "fighter_b": "Card"}])
        self.repo.set_active_event("ufc-331")
        with self.repo.connection() as conn:
            conn.execute("INSERT INTO settings(key,value) VALUES('active_event_source','auto') ON CONFLICT(key) DO UPDATE SET value=excluded.value")

        advanced = self.repo.maybe_advance_active_event(datetime(2026, 9, 22, 8, 0, tzinfo=ZoneInfo("America/New_York")))

        self.assertEqual(advanced["id"], "dwcs-week-7")
        self.assertEqual(advanced["auto_advanced_from"], "ufc-331")
        self.assertEqual(self.repo.active_event(auto_advance=False)["id"], "dwcs-week-7")

    def test_active_event_does_not_auto_advance_before_8am_et(self):
        self.repo.upsert_event({"id": "past", "name": "Past", "event_date": "2026-09-19"})
        self.repo.replace_event_fights("past", [{"fighter_a": "Old", "fighter_b": "Card"}])
        self.repo.upsert_event({"id": "today", "name": "Today", "event_date": "2026-09-22"})
        self.repo.replace_event_fights("today", [{"fighter_a": "New", "fighter_b": "Card"}])
        self.repo.set_active_event("past")
        with self.repo.connection() as conn:
            conn.execute("INSERT INTO settings(key,value) VALUES('active_event_source','auto') ON CONFLICT(key) DO UPDATE SET value=excluded.value")

        advanced = self.repo.maybe_advance_active_event(datetime(2026, 9, 22, 7, 59, tzinfo=ZoneInfo("America/New_York")))

        self.assertIsNone(advanced)
        self.assertEqual(self.repo.active_event(auto_advance=False)["id"], "past")

    def test_manual_pick_of_past_event_is_not_auto_advanced(self):
        self.repo.upsert_event({"id": "noche", "name": "Noche UFC", "event_date": "2026-09-12"})
        self.repo.replace_event_fights("noche", [{"fighter_a": "Old", "fighter_b": "Card"}])
        self.repo.upsert_event({"id": "today", "name": "Today", "event_date": "2026-09-26"})
        self.repo.replace_event_fights("today", [{"fighter_a": "New", "fighter_b": "Card"}])
        self.repo.set_active_event("noche")

        advanced = self.repo.maybe_advance_active_event(datetime(2026, 9, 26, 9, 0, tzinfo=ZoneInfo("America/New_York")))

        self.assertIsNone(advanced)
        self.assertEqual(self.repo.active_event()["id"], "noche")

    def test_manual_pick_of_current_event_still_auto_advances_once_stale(self):
        self.repo.upsert_event({"id": "today", "name": "Today", "event_date": "2026-09-26"})
        self.repo.replace_event_fights("today", [{"fighter_a": "New", "fighter_b": "Card"}])
        self.repo.upsert_event({"id": "next", "name": "Next", "event_date": "2026-09-29"})
        self.repo.replace_event_fights("next", [{"fighter_a": "Next", "fighter_b": "Card"}])
        self.repo.set_active_event("today", datetime(2026, 9, 26, 9, 0, tzinfo=ZoneInfo("America/New_York")))

        advanced = self.repo.maybe_advance_active_event(datetime(2026, 9, 29, 8, 0, tzinfo=ZoneInfo("America/New_York")))

        self.assertEqual(advanced["id"], "next")
        self.assertEqual(advanced["auto_advanced_from"], "today")
        # After an auto-advance the chain continues on subsequent mornings.
        advanced2 = self.repo.maybe_advance_active_event(datetime(2026, 9, 30, 8, 0, tzinfo=ZoneInfo("America/New_York")))
        self.assertIsNone(advanced2)
        self.assertEqual(self.repo.active_event(auto_advance=False)["id"], "next")

    def test_statistics_excludes_bonus_stake_from_cash_exposure(self):
        self.repo.create_bet({"event_id":"event-a","event_name":"Event A","fight_name":"A vs B","selection":"A","bet_type":"Moneyline","american_odds":100,"cash_stake":10,"bonus_stake":0,"status":"win","payout":20})
        self.repo.create_bet({"event_id":"event-a","event_name":"Event A","fight_name":"C vs D","selection":"C","bet_type":"Moneyline","american_odds":100,"cash_stake":0,"bonus_stake":10,"status":"win","payout":10})
        stats = self.repo.statistics()
        self.assertEqual(stats["cash_staked"], 10)
        self.assertEqual(stats["profit"], 20)
        self.assertEqual(stats["by_book"][0]["book"], "")

    def test_dashboard_and_statistics_can_scope_to_active_event(self):
        self.repo.create_bet({"event_id":"event-a","event_name":"Event A","fight_name":"A vs B","selection":"A","bet_type":"Moneyline","american_odds":100,"cash_stake":10,"status":"win","payout":20,"book":"DK"})
        self.repo.create_bet({"event_id":"event-b","event_name":"Event B","fight_name":"C vs D","selection":"C","bet_type":"Moneyline","american_odds":100,"cash_stake":99,"status":"pending","book":"FD"})
        dash = self.repo.dashboard("event-a")
        stats = self.repo.statistics("event-a")
        self.assertEqual(dash["total_bets"], 1)
        self.assertEqual(dash["won"], 1)
        self.assertEqual(dash["pending"], 0)
        self.assertEqual(stats["total_bets"], 1)
        self.assertEqual(stats["cash_staked"], 10)
        self.assertEqual(stats["by_book"][0]["book"], "DK")

    def test_create_bet_uses_catalog_event_name_when_import_supplies_id_as_name(self):
        self.repo.upsert_event({"id":"event-a","name":"UFC Fight Night: Paris"})
        bet = self.repo.create_bet({"event_id":"event-a","event_name":"event-a","fight_name":"A vs B","selection":"A","bet_type":"Moneyline","american_odds":100,"cash_stake":10})
        self.assertEqual(bet["event_name"], "UFC Fight Night: Paris")

    def test_parlay_leg_status_stays_pending_until_all_legs_settle(self):
        bet = self.repo.create_bet({"event_id":"event-a","event_name":"Event A","fight_name":"2-Leg Parlay","selection":"Parlay","bet_type":"Parlay","american_odds":220,"cash_stake":10,"legs":[{"fight_name":"A vs B","selection":"A"},{"fight_name":"C vs D","selection":"D"}]})
        updated = self.repo.update_leg_status(bet["id"], 1, "win")
        self.assertEqual(updated["status"], "pending")
        self.assertEqual(updated["legs"][0]["status"], "pending")
        self.assertEqual(updated["legs"][1]["status"], "win")

    def test_parlay_auto_settles_win_when_all_legs_win_or_void(self):
        bet = self.repo.create_bet({"event_id":"event-a","event_name":"Event A","fight_name":"2-Leg Parlay","selection":"Parlay","bet_type":"Parlay","american_odds":220,"cash_stake":10,"legs":[{"fight_name":"A vs B","selection":"A"},{"fight_name":"C vs D","selection":"D"}]})
        self.repo.update_leg_status(bet["id"], 0, "win")
        updated = self.repo.update_leg_status(bet["id"], 1, "void")
        self.assertEqual(updated["status"], "win")
        self.assertEqual(updated["payout"], 32)

    def test_parlay_auto_settles_loss_if_any_leg_loses(self):
        bet = self.repo.create_bet({"event_id":"event-a","event_name":"Event A","fight_name":"2-Leg Parlay","selection":"Parlay","bet_type":"Parlay","american_odds":220,"cash_stake":10,"legs":[{"fight_name":"A vs B","selection":"A"},{"fight_name":"C vs D","selection":"D"}]})
        self.repo.update_leg_status(bet["id"], 0, "win")
        updated = self.repo.update_leg_status(bet["id"], 1, "loss")
        self.assertEqual(updated["status"], "loss")
        self.assertEqual(updated["payout"], 0)


if __name__ == "__main__":
    unittest.main()
