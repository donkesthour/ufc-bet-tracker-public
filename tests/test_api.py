"""HTTP behavior on a separate process and temporary SQLite database."""
import json, os, socket, subprocess, sys, tempfile, time, unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        with socket.socket() as s:
            s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
        cls.base=f'http://127.0.0.1:{port}'
        cls.env={**os.environ,'UFC_V3_UPDATE_DISABLE':'1','UFC_V3_DB':str(Path(cls.tmp.name)/'test.db')}
        cls.command=[sys.executable,'-m','uvicorn','app:app','--host','127.0.0.1','--port',str(port)]
        cls.start()
    @classmethod
    def start(cls):
        cls.proc=subprocess.Popen(cls.command,cwd=Path(__file__).parents[1],env=cls.env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                with urlopen(cls.base+'/healthz',timeout=1): return
            except OSError: time.sleep(.05)
        raise RuntimeError('isolated API did not start')
    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate();cls.proc.wait(timeout=10);cls.tmp.cleanup()
    def request(self,path,body=None,method='GET'):
        try:
            response=urlopen(Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'},method=method))
        except HTTPError as e: response=e
        with response:
            raw=response.read()
            return response.status,json.loads(raw) if raw else None
    def valid(self,**kw):
        data={'fight_name':'A vs B','selection':'A','american_odds':150,'cash_stake':10}
        data.update(kw)
        return data
    def test_rejects_zero_odds_and_empty_stake(self):
        for patch in ({'american_odds':0},{'cash_stake':0},{'cash_stake':float('inf')}):
            status,_=self.request('/api/bets',{**self.valid(),**patch},'POST')
            self.assertIn(status,(400,422))
    def test_rejects_null_patch_fields(self):
        _,bet=self.request('/api/bets',self.valid(),'POST')
        for patch in ({'cash_stake':None},{'status':None},{'american_odds':0}):
            status,_=self.request('/api/bets/'+bet['id'],patch,'PATCH')
            self.assertIn(status,(400,422))
        self.request('/api/bets/'+bet['id'],method='DELETE')
    def test_profit_timeline_returns_realized_points(self):
        _,loss=self.request('/api/bets',self.valid(cash_stake=12),'POST')
        _,win=self.request('/api/bets',self.valid(selection='B',cash_stake=10),'POST')
        self.request('/api/bets/'+loss['id'],{'status':'loss'},'PATCH')
        self.request('/api/bets/'+win['id'],{'status':'win'},'PATCH')
        status,timeline=self.request('/api/profit-timeline')
        self.assertEqual(status,200)
        self.assertEqual(timeline['scope'],'all')
        self.assertEqual(len(timeline['points']),1)
        self.assertEqual(timeline['points'][0]['profit'],3.0)
    def test_settlement_persistence_after_process_restart(self):
        _,bet=self.request('/api/bets',self.valid(bonus_stake=5),'POST')
        path='/api/bets/'+bet['id']
        self.assertEqual(self.request(path,{'status':'win'},'PATCH')[1]['payout'],32.5)
        type(self).proc.terminate();type(self).proc.wait(timeout=10);type(self).start()
        self.assertEqual(self.request(path)[1]['payout'],32.5)
        self.assertIsNone(self.request(path,{'status':'pending','payout':None},'PATCH')[1]['payout'])
        self.assertIsNone(self.request(path)[1]['settled_at'])
        self.assertEqual(self.request(path,method='DELETE')[0],204)
        self.assertEqual(self.request(path)[0],404)
