import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from db import TrackerRepository


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = TrackerRepository(Path(self.tmp.name) / "tracker.db")
        self.repo.initialize()

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_read_update_and_delete_are_committed(self):
        created = self.repo.create_bet({
            "event_id": "ufc-test", "event_name": "UFC Test", "book": "DK",
            "fight_name": "A vs B", "selection": "A ML", "bet_type": "Moneyline",
            "american_odds": -120, "cash_stake": 10, "bonus_stake": 0,
        })
        self.assertIsInstance(created["id"], str)
        self.assertEqual(self.repo.get_bet(created["id"])["selection"], "A ML")
        settled = self.repo.update_bet(created["id"], {"status": "win", "payout": 18.33})
        self.assertEqual(settled["status"], "win")
        self.assertEqual(self.repo.get_bet(created["id"])["payout"], 18.33)
        self.repo.delete_bet(created["id"])
        self.assertIsNone(self.repo.get_bet(created["id"]))

    def test_parlay_legs_are_committed_with_parent(self):
        created = self.repo.create_bet({
            "event_id": "ufc-test", "event_name": "UFC Test", "book": "FD",
            "fight_name": "Parlay", "selection": "2-leg parlay", "bet_type": "Parlay",
            "american_odds": 250, "cash_stake": 5, "bonus_stake": 0,
            "legs": [{"fight_name": "A vs B", "selection": "A", "american_odds": -110},
                     {"fight_name": "C vs D", "selection": "C", "american_odds": 120}],
        })
        loaded = self.repo.get_bet(created["id"])
        self.assertEqual([leg["leg_index"] for leg in loaded["legs"]], [0, 1])
        self.assertEqual(loaded["legs"][1]["selection"], "C")

    def test_event_upsert_and_fight_replace(self):
        self.repo.upsert_event({"id": "event-sync", "name": "UFC Sync", "date": "2026-09-12"})
        self.repo.replace_event_fights("event-sync", [
            {"fighterA": "A", "fighterB": "B", "oddsA": -120, "oddsB": 100, "main": True, "rounds": 5},
            {"fighterA": "C", "fighterB": "D", "oddsA": 110, "oddsB": -130, "main": False, "rounds": 3},
        ])
        event = self.repo.set_active_event("event-sync")
        self.assertEqual(event["name"], "UFC Sync")
        self.assertEqual(len(event["fights"]), 2)
        self.assertEqual(event["fights"][0]["rounds"], 5)
        self.repo.replace_event_fights("event-sync", [
            {"fighterA": "E", "fighterB": "F", "oddsA": -150, "oddsB": 125, "main": True},
        ])
        event = self.repo.active_event()
        self.assertEqual(len(event["fights"]), 1)
        self.assertEqual(event["fights"][0]["matchup"], "E vs. F")

    def test_event_poster_url_persists_across_sync_upserts(self):
        self.repo.upsert_event({"id": "event-poster", "name": "UFC Poster", "date": "2026-09-12"})
        saved = self.repo.update_event_poster("event-poster", "https://ufc.com/images/official.jpg")
        self.assertEqual(saved["poster_url"], "https://ufc.com/images/official.jpg")
        resynced = self.repo.upsert_event({"id": "event-poster", "name": "UFC Poster Updated", "date": "2026-09-13"})
        self.assertEqual(resynced["poster_url"], "https://ufc.com/images/official.jpg")

    def test_profit_timeline_groups_all_events_and_orders_active_settlements(self):
        self.repo.upsert_event({"id": "event-early", "name": "UFC Early", "date": "2026-01-10"})
        self.repo.upsert_event({"id": "event-late", "name": "UFC Late", "date": "2026-02-10"})
        early = self.repo.create_bet({"event_id": "event-early", "event_name": "UFC Early", "book": "DK", "fight_name": "A vs B", "selection": "A", "bet_type": "Moneyline", "american_odds": 100, "cash_stake": 10})
        late_win = self.repo.create_bet({"event_id": "event-late", "event_name": "UFC Late", "book": "DK", "fight_name": "C vs D", "selection": "C", "bet_type": "Moneyline", "american_odds": 100, "cash_stake": 10})
        late_same_matchup = self.repo.create_bet({"event_id": "event-late", "event_name": "UFC Late", "book": "FD", "fight_name": "C vs D", "selection": "D", "bet_type": "Method", "american_odds": 100, "cash_stake": 3})
        late_loss = self.repo.create_bet({"event_id": "event-late", "event_name": "UFC Late", "book": "DK", "fight_name": "E vs F", "selection": "E", "bet_type": "Moneyline", "american_odds": -110, "cash_stake": 5})
        self.repo.update_bet(early["id"], {"status": "loss"})
        self.repo.update_bet(late_win["id"], {"status": "win", "payout": 20})
        self.repo.update_bet(late_same_matchup["id"], {"status": "loss"})
        self.repo.update_bet(late_loss["id"], {"status": "loss"})
        all_events = self.repo.profit_timeline()
        self.assertEqual([point["event_id"] for point in all_events["points"]], ["event-early", "event-late"])
        self.assertEqual([point["profit"] for point in all_events["points"]], [-10.0, 2.0])
        self.assertEqual([point["cumulative_profit"] for point in all_events["points"]], [-10.0, -8.0])
        active = self.repo.profit_timeline("event-late")
        self.assertEqual(len(active["points"]), 2)
        self.assertEqual(active["points"][0]["label"], "C vs D")
        self.assertEqual(active["points"][0]["settled"], 2)
        self.assertEqual(active["points"][0]["profit"], 7.0)
        self.assertEqual(active["points"][-1]["cumulative_profit"], 2.0)

    def test_active_profit_timeline_excludes_parlays(self):
        self.repo.upsert_event({"id": "event-parlay", "name": "UFC Parlay", "date": "2026-02-20"})
        self.repo.replace_event_fights("event-parlay", [
            {"fight_index": 0, "fighter_a": "Akbar Abdullaev", "fighter_b": "Ednilson Santos"},
        ])
        straight = self.repo.create_bet({"event_id": "event-parlay", "event_name": "UFC Parlay", "book": "DK", "fight_name": "Akbar Abdullaev vs. Ednilson Santos", "selection": "Akbar Abdullaev", "bet_type": "Moneyline", "american_odds": 100, "cash_stake": 10})
        parlay = self.repo.create_bet({
            "event_id": "event-parlay", "event_name": "UFC Parlay", "book": "DK",
            "fight_name": "2-leg parlay", "selection": "Parlay", "bet_type": "Parlay",
            "american_odds": 170, "cash_stake": 10,
            "legs": [
                {"fight_name": "Akbar Abdullaev vs. Ednilson Santos", "selection": "Akbar Abdullaev"},
                {"fight_name": "Akbar Abdullaev vs. Ednilson Santos", "selection": "Under 2.5 minutes"},
            ],
        })
        self.repo.update_bet(straight["id"], {"status": "win", "payout": 20})
        self.repo.update_bet(parlay["id"], {"status": "win", "payout": 27})
        points = self.repo.profit_timeline("event-parlay")["points"]
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0]["label"], "Akbar Abdullaev vs. Ednilson Santos")
        self.assertEqual(points[0]["settled"], 1)
        self.assertEqual(points[0]["profit"], 10.0)

    def test_active_profit_timeline_uses_fight_start_times_before_settlement_order(self):
        self.repo.upsert_event({"id": "event-order", "name": "UFC Order", "date": "2026-03-01"})
        self.repo.replace_event_fights("event-order", [
            {"fight_index": 8, "fighter_a": "Main A", "fighter_b": "Main B", "fight_time": "10:30 PM ET", "is_main": True},
            {"fight_index": 2, "fighter_a": "Early A", "fighter_b": "Early B", "fight_time": "7:00 PM ET"},
        ])
        main = self.repo.create_bet({"event_id": "event-order", "event_name": "UFC Order", "book": "DK", "fight_name": "Main A vs. Main B", "selection": "Main A", "bet_type": "Moneyline", "american_odds": 100, "cash_stake": 10})
        early = self.repo.create_bet({"event_id": "event-order", "event_name": "UFC Order", "book": "DK", "fight_name": "Early A vs. Early B", "selection": "Early A", "bet_type": "Moneyline", "american_odds": 100, "cash_stake": 10})
        self.repo.update_bet(main["id"], {"status": "loss"})
        self.repo.update_bet(early["id"], {"status": "win", "payout": 20})
        points = self.repo.profit_timeline("event-order")["points"]
        self.assertEqual([point["label"] for point in points], ["Early A vs. Early B", "Main A vs. Main B"])
        self.assertEqual([point["cumulative_profit"] for point in points], [10.0, 0.0])


    def test_active_profit_timeline_reports_parlay_attribution_series(self):
        self.repo.upsert_event({"id": "event-mixed", "name": "UFC Mixed", "date": "2026-10-03"})
        self.repo.replace_event_fights("event-mixed", [
            {"fight_index": 0, "fighter_a": "Opener A", "fighter_b": "Opener B"},
            {"fight_index": 1, "fighter_a": "Middle A", "fighter_b": "Middle B"},
            {"fight_index": 2, "fighter_a": "Closer A", "fighter_b": "Closer B"},
        ])
        straight = self.repo.create_bet({"event_id": "event-mixed", "event_name": "UFC Mixed", "book": "DK", "fight_name": "Middle A vs. Middle B", "selection": "Middle A", "bet_type": "Moneyline", "american_odds": 100, "cash_stake": 10})
        parlay = self.repo.create_bet({
            "event_id": "event-mixed", "event_name": "UFC Mixed", "book": "DK",
            "fight_name": "3 Pick Parlay", "selection": "Parlay", "bet_type": "Parlay",
            "american_odds": 170, "cash_stake": 10,
            "legs": [
                {"fight_name": "Opener A vs. Opener B", "selection": "Opener A"},
                {"fight_name": "Middle A vs. Middle B", "selection": "Middle A"},
                {"fight_name": "Closer A vs. Closer B", "selection": "Closer B"},
            ],
        })
        self.repo.update_bet(straight["id"], {"status": "win", "payout": 20})
        self.repo.update_bet(parlay["id"], {"status": "win", "payout": 27})
        timeline = self.repo.profit_timeline("event-mixed")
        # Straight-bet series unchanged: parlays never enter points.
        self.assertEqual(len(timeline["points"]), 1)
        self.assertEqual(timeline["points"][0]["profit"], 10.0)
        # Parlay-attributed series: parlay net split evenly across leg matchups, card order.
        self.assertEqual([point["label"] for point in timeline["parlay_points"]], ["Opener A vs. Opener B", "Middle A vs. Middle B", "Closer A vs. Closer B"])
        self.assertTrue(all(point["profit"] == 5.67 and point["attributed"] for point in timeline["parlay_points"]))
        # Shared axis with carry-forward cumulative for both lines.
        series = timeline["series"]
        self.assertEqual(series["labels"], ["Opener A vs. Opener B", "Middle A vs. Middle B", "Closer A vs. Closer B"])
        self.assertEqual(series["straight_cumulative"], [0.0, 10.0, 10.0])
        self.assertEqual(series["parlay_cumulative"], [5.67, 21.34, 27.01])


if __name__ == "__main__":
    unittest.main()
