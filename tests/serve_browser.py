"""Start only the isolated browser-test instance; never open the live database."""
import os
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).parents[1]))
from db import TrackerRepository
import tempfile
# A fresh DB for each run; teardown removes only this generated directory.
sandbox = tempfile.TemporaryDirectory(prefix='browser-', dir=Path(__file__).parent)
path=Path(sandbox.name)/'test.db'
repo=TrackerRepository(path)
repo.initialize()
repo.upsert_event({'id':'test-card','name':'Browser verification card','event_date':'2026-09-12'})
repo.replace_event_fights('test-card',[{'fighter_a':'Fighter Alpha','fighter_b':'Fighter Bravo','odds_a':150,'odds_b':-180,'rounds':3,'is_main':True}])
repo.set_active_event('test-card')
os.environ['UFC_V3_DB']=str(path)
os.environ['UFC_V3_UPDATE_DISABLE']='1'
import uvicorn
uvicorn.run('app:app',host='127.0.0.1',port=18212)
