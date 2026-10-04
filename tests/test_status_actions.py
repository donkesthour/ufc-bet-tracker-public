"""Exercise the real browser controls, not JavaScript source formatting.

Requires npm ci and npx playwright install chromium in v3.
Playwright owns an isolated server/database; this never targets live v3.
"""
import subprocess
import unittest
from pathlib import Path


class V3StatusActionTests(unittest.TestCase):
    def run_browser_contract(self, name):
        root = Path(__file__).parents[1]
        result = subprocess.run(
            [str(root / 'node_modules/.bin/playwright'), 'test',
             'browser.spec.js', '--grep', name], cwd=root,
            capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_history_renders_explicit_status_actions_without_prompt(self):
        self.run_browser_contract('status actions persist every transition')

    def test_log_form_has_fast_stake_buttons(self):
        self.run_browser_contract('all four stake denominations add and clear')


if __name__ == '__main__':
    unittest.main()
