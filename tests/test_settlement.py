import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))
from db import TrackerRepository

class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = TrackerRepository(Path(self.tmp.name)/'isolated.db')
        self.repo.initialize()
    def tearDown(self):
        self.tmp.cleanup()
    def bet(self, **kw):
        return self.repo.create_bet(dict(fight_name='A vs B', selection='A', american_odds=150, cash_stake=10, bonus_stake=5, **kw))
    def test_server_calculates_mixed_cash_bonus_win(self):
        b=self.bet()
        result=self.repo.update_bet(b['id'], {'status':'win'})
        self.assertEqual(result['payout'],32.5)
        self.assertEqual(self.repo.get_bet(b['id'])['payout'],32.5)
        self.assertEqual(self.repo.dashboard()['profit'],22.5)
    def test_transitions_clear_stale_payout_and_timestamp(self):
        b=self.bet()
        for status, payout in [('win',32.5),('loss',0),('void',10),('pending',None)]:
            result=self.repo.update_bet(b['id'],{'status':status})
            self.assertEqual(result['payout'],payout)
            self.assertEqual(result['settled_at'] is None,status=='pending')
    def test_edit_winning_stake_recalculates_without_losing_unknown_data(self):
        b=self.repo.create_bet(dict(fight_name='A',american_odds=-200,cash_stake=10,bonus_stake=5),source_json='{"unknown":true}')
        self.repo.update_bet(b['id'],{'status':'win'})
        result=self.repo.update_bet(b['id'],{'cash_stake':20})
        self.assertEqual(result['payout'],32.5)
        self.assertEqual(result['source_json'],'{"unknown":true}')
    def test_ticket_edit_preserves_legs_source_and_identity(self):
        b=self.repo.create_bet(dict(fight_name='A',selection='A',american_odds=150,cash_stake=10,legs=[{'fight_name':'A','selection':'A','american_odds':150}]),source_json='{"future_field":7}')
        result=self.repo.update_bet(b['id'],{'fight_name':'A vs B','selection':'B','bet_type':'Fighter Props','is_live_stream':True})
        self.assertEqual(result['selection'],'B')
        self.assertEqual(result['bet_type'],'Fighter Props')
        self.assertTrue(result['is_live_stream'])
        self.assertEqual(result['legs'],b['legs'])
        self.assertEqual(result['source_json'],b['source_json'])
        self.assertEqual(result['placed_at'],b['placed_at'])
    def test_explicit_book_payout_override(self):
        b=self.bet()
        self.assertEqual(self.repo.update_bet(b['id'],{'status':'win','payout':30})['payout'],30)
        self.assertEqual(self.repo.update_bet(b['id'],{'notes':'verified'})['payout'],30)

if __name__=='__main__': unittest.main()
