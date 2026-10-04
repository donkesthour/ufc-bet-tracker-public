const {defineConfig} = require('@playwright/test');
module.exports = defineConfig({
  testDir:'./tests', workers:1, timeout:15000,
  use:{trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:(require('fs').existsSync(require('path').resolve(__dirname,'../venv/bin/python'))?require('path').resolve(__dirname,'../venv/bin/python'):(process.env.PYTHON||'python3'))+' tests/serve_browser.py',url:'http://127.0.0.1:18212/healthz',reuseExistingServer:false,timeout:15000}
});
