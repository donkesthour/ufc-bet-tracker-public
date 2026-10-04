const {test, expect} = require('@playwright/test');
// Deliberately fixed: mutation tests must never run on a live instance.
const base = 'http://127.0.0.1:18212';
test('all-event P/L labels use readable event names and dates', async ({page,request})=>{
  const created=await request.post(base+'/api/bets',{data:{event_id:'test-card',event_name:'Browser verification card',fight_name:'Chart contract',selection:'Alpha',american_odds:150,cash_stake:10}});
  const bet=await created.json();
  try {
    await request.patch(base+'/api/bets/'+bet.id,{data:{status:'win'}});
    await page.goto(base);
    await page.getByRole('button',{name:'All events'}).click();
    await expect(page.locator('[data-chart-x-label]').first()).toContainText('Browser verification card');
    await expect(page.locator('[data-chart-x-label]').first()).toContainText('Sep 12, 2026');
    await page.locator('#profit-chart .point-group').first().hover();
    await expect(page.locator('#profit-chart .point-group').first()).toHaveClass(/is-highlighted/);
    await expect(page.locator('.chart-tooltip')).toBeVisible();
    await expect(page.locator('.chart-tooltip')).toContainText('Event: Browser verification card');
    await expect(page.locator('.chart-tooltip')).toContainText('P/L: $15.00');
  } finally { await request.delete(base+'/api/bets/'+bet.id); }
});
test('active P/L groups settled bets by matchup and labels the bullet', async ({page,request})=>{
  const make=data=>request.post(base+'/api/bets',{data:{event_id:'test-card',event_name:'Browser verification card',fight_name:'Chart matchup',selection:'Alpha',american_odds:100,cash_stake:10,...data}});
  const first=await (await make({book:'DK'})).json(), second=await (await make({book:'FD',selection:'Bravo',cash_stake:5})).json();
  try {
    await request.patch(base+'/api/bets/'+first.id,{data:{status:'win'}});
    await request.patch(base+'/api/bets/'+second.id,{data:{status:'loss'}});
    await page.goto(base);
    await expect(page.locator('#profit-chart .point-group')).toHaveCount(1);
    await expect(page.locator('[data-chart-x-label]').first()).toContainText('Chart matchup');
    await page.locator('#profit-chart .point-group').focus();
    await expect(page.locator('.chart-tooltip')).toBeVisible();
    await expect(page.locator('.chart-tooltip')).toContainText('Matchup: Chart matchup');
    await expect(page.locator('.chart-tooltip')).toContainText('P/L: $5.00');
  } finally { await request.delete(base+'/api/bets/'+first.id); await request.delete(base+'/api/bets/'+second.id); }
});
test('status actions persist every transition without prompts', async ({page,request})=>{
  const created=await request.post(base+'/api/bets',{data:{event_id:'test-card',fight_name:'Status contract',selection:'Alpha',american_odds:150,cash_stake:10,bonus_stake:5}});
  expect(created.status()).toBe(201);
  const bet=await created.json();
  const dialogs=[];
  page.on('dialog', async d=>{dialogs.push(d.message());await d.dismiss();});
  try {
    await page.goto(base);
    const row=page.locator('#bets tr').filter({hasText:'Status contract'});
    for(const name of ['Pending','Win','Loss','Void']) await expect(row.getByRole('button',{name,exact:true})).toBeVisible();
    for(const [status,payout] of [['Win',32.5],['Loss',0],['Void',10],['Pending',null],['Win',32.5]]) {
      await row.getByRole('button',{name:status,exact:true}).click();
      await expect(row.getByRole('button',{name:status,exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(row.getByRole('button',{name:status,exact:true})).toBeEnabled();
      const saved=await (await request.get(base+'/api/bets/'+bet.id)).json();
      expect(saved.status).toBe(status.toLowerCase());expect(saved.payout).toBe(payout);
      if(status==='Pending') expect(saved.settled_at).toBeNull();
      await page.reload();
      await expect(row.locator('.tag')).toHaveText(status);
    }
    await row.locator('summary').click();
    await row.getByLabel('Actual bookmaker return ($)').fill('31.25');
    await row.getByRole('button',{name:'Save payout',exact:true}).click();
    await expect(row).toContainText('$31.25 return');
    expect((await (await request.get(base+'/api/bets/'+bet.id)).json()).payout).toBe(31.25);
    expect(dialogs).toEqual([]);
  } finally {
    expect((await request.delete(base+'/api/bets/'+bet.id)).status()).toBe(204);
    expect((await request.get(base+'/api/bets/'+bet.id)).status()).toBe(404);
  }
});
test('all four stake denominations add and clear',async({page})=>{
  await page.goto(base);
  await expect(page.locator('#selection')).toBeEnabled();
  for(const [label,value] of [['+$1','1'],['+$2.50','3.5'],['+$5','8.5'],['+$10','18.5']]) {
    await page.getByRole('button',{name:label,exact:true}).click();
    await expect(page.locator('#cash_stake')).toHaveValue(value);
  }
  await page.getByRole('button',{name:'Clear',exact:true}).click();
  await expect(page.locator('#cash_stake')).toHaveValue('0');
});

test('active event poster uses official marketing material URL', async ({page, request}) => {
  await page.goto(base);
  const poster=page.locator('#event-poster');
  await expect(poster).toBeVisible();
  await expect(poster).toContainText('Browser verification card');
  await expect(poster).toContainText('Fighter Alpha');
  await expect(poster).toContainText('Fighter Bravo');
  await expect(poster).toContainText('Official marketing material');
  await expect(poster).toContainText('No official poster set yet.');
  await expect(poster.locator('.poster-card')).toHaveCount(2);
  const official='https://ufc.com/images/browser-official-poster.jpg';
  await page.locator('#poster-url').fill(official);
  await page.getByRole('button',{name:'Save poster',exact:true}).click();
  await expect(page.locator('#message')).toContainText('Official poster saved.');
  await expect(poster.locator('img.poster-image')).toHaveAttribute('src',official);
  expect((await (await request.get(base+'/api/events/active')).json()).poster_url).toBe(official);
});

test('keep pick for next bet preserves wager after save',async({page,request})=>{
  await page.goto(base);
  await page.locator('#fight-card button').first().click();
  await page.locator('#cash_stake').fill('12.5');
  await page.locator('#american_odds').fill('150');
  await expect(page.locator('#keep-pick')).toBeChecked();
  await page.getByRole('button',{name:'Save bet',exact:true}).click();
  await expect(page.locator('#message')).toContainText(/committed|saved/i);
  await expect(page.locator('#cash_stake')).toHaveValue('12.5');
  await expect(page.locator('#american_odds')).toHaveValue('150');
  const data=await (await request.get(base+'/api/bets')).json();
  const saved=data.bets.find(b=>b.cash_stake===12.5 && b.american_odds===150);
  if(saved) await request.delete(base+'/api/bets/'+saved.id);
});

test('ledger duplicate loads a copy into the save form without editing original',async({page,request})=>{
  const created=await request.post(base+'/api/bets',{data:{event_id:'test-card',event_name:'Browser verification card',fight_name:'Fighter Alpha vs. Fighter Bravo',selection:'Fighter Alpha',bet_type:'Moneyline',american_odds:120,cash_stake:4,book:'DK',notes:'duplicate source'}});
  expect(created.status()).toBe(201);
  const source=await created.json();
  let copy;
  try {
    await page.goto(base);
    const row=page.locator('#bets tr').filter({hasText:'duplicate source'});
    await row.getByRole('button',{name:'Duplicate',exact:true}).click();
    await expect(page.locator('#message')).toContainText('Duplicated into ticket');
    await expect(page.locator('#cancel-edit')).toBeHidden();
    await expect(page.getByRole('button',{name:'Save bet',exact:true})).toBeVisible();
    await expect(page.locator('#fight_name')).toHaveValue('Fighter Alpha vs. Fighter Bravo');
    await expect(page.locator('#cash_stake')).toHaveValue('4');
    await page.locator('#cash_stake').fill('6');
    await page.getByRole('button',{name:'Save bet',exact:true}).click();
    await expect(page.locator('#message')).toContainText('committed');
    const data=await (await request.get(base+'/api/bets')).json();
    const matches=data.bets.filter(b=>b.notes==='duplicate source').sort((a,b)=>a.cash_stake-b.cash_stake);
    expect(matches).toHaveLength(2);
    expect(matches[0].id).toBe(source.id);
    expect(matches[0].cash_stake).toBe(4);
    expect(matches[1].cash_stake).toBe(6);
    copy=matches[1];
  } finally {
    if(copy) await request.delete(base+'/api/bets/'+copy.id);
    await request.delete(base+'/api/bets/'+source.id);
  }
});
test('parlay legs notes and custom book survive save and reload',async({page,request})=>{
  await page.goto(base);
  await page.locator('#fight-card button').first().click();
  await expect(page.locator('#keep-pick')).toBeChecked();
  await page.getByRole('button',{name:'Other',exact:true}).first().click();
  await page.locator('#other-book').fill('Custom Book');
  await page.getByRole('button',{name:'Parlay',exact:true}).click();
  const sportsbookGroup = page.getByRole('group',{name:'Sportsbook', exact:true});
  await expect(sportsbookGroup).toBeVisible();
  await expect(page.getByRole('button',{name:'+ Add to Parlay',exact:true})).toBeVisible();
  await expect(page.locator('#parlay-panel').getByRole('button',{name:'+ Add to Parlay',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'+ Add to Parlay',exact:true}).click();
  await expect(page.locator('#fight_name')).toHaveValue('Fighter Alpha vs. Fighter Bravo');
  await expect(page.locator('#matchup')).toHaveValue('0');
  await expect(page.locator('#selection')).toHaveValue('');
  await page.getByRole('button',{name:'+ Add custom leg',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save Parlay',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Save bet',exact:true})).toBeHidden();
  await page.getByLabel('Leg fight',{exact:true}).nth(1).fill('Outside card');
  await page.getByLabel('Leg selection',{exact:true}).nth(1).fill('Custom leg');
  await page.getByText('Notes & flags',{exact:true}).click();
  await page.locator('#notes').fill('Browser parlay contract');
  await page.getByLabel('Live stream',{exact:true}).check();
  await page.locator('#american_odds').fill('250');
  await page.getByRole('button',{name:'+$10',exact:true}).click();
  await page.getByRole('button',{name:'Save Parlay',exact:true}).click();
  await expect(page.locator('#message')).toContainText('committed');
  await expect(page.locator('#fight_name')).toHaveValue('Fighter Alpha vs. Fighter Bravo');
  await expect(page.locator('#matchup')).toHaveValue('0');
  await expect(page.locator('#cash_stake')).toHaveValue('10');
  await expect(page.locator('#american_odds')).toHaveValue('250');
  const data=await (await request.get(base+'/api/bets')).json();
  const bet=data.bets.find(b=>b.notes==='Browser parlay contract');
  try {
    expect(bet.book).toBe('Custom Book');expect(bet.is_live_stream).toBeTruthy();
    expect(bet.fight_name).toBe('2-leg parlay');expect(bet.selection).toBe('Parlay');
    expect(bet.legs).toHaveLength(2);expect(bet.legs[0].fight_name).toBe('Fighter Alpha vs. Fighter Bravo');expect(bet.legs[1].selection).toBe('Custom leg');expect(bet.legs[1].american_odds).toBeNull();
    await page.reload();
    const row=page.locator('#bets tr').filter({hasText:'Custom Book'});
    await row.locator('summary').click();
    await expect(row).toContainText('Outside card');
    await expect(row).toContainText('Browser parlay contract');
    await row.locator('.leg-result').nth(0).getByRole('button',{name:'Win',exact:true}).click();
    await expect(row.locator('details')).toHaveAttribute('open','');
    await row.locator('.leg-result').nth(1).getByRole('button',{name:'Win',exact:true}).click();
    await expect(row.locator('details')).toHaveAttribute('open','');
    const settled=await (await request.get(base+'/api/bets/'+bet.id)).json();
    expect(settled.status).toBe('win');expect(settled.payout).toBe(35);
  } finally {if(bet) await request.delete(base+'/api/bets/'+bet.id);}
});

test('ledger can hide parlays while reviewing matchup stats', async ({page, request}) => {
  test.setTimeout(30000);
  const single=await (await request.post(base+'/api/bets',{data:{event_id:'test-card',event_name:'Browser verification card',fight_name:'Fighter Alpha vs. Fighter Bravo',selection:'Fighter Alpha',american_odds:100,cash_stake:10,book:'DK'}})).json();
  const parlay=await (await request.post(base+'/api/bets',{data:{event_id:'test-card',event_name:'Browser verification card',fight_name:'2-leg parlay',selection:'Parlay',american_odds:200,cash_stake:5,book:'FD',legs:[{fight_name:'Fighter Alpha vs. Fighter Bravo',selection:'Fighter Alpha'},{fight_name:'Outside card',selection:'Custom leg'}]}})).json();
  try {
    await page.goto(base);
    await page.locator('#ledger-matchup').selectOption('Fighter Alpha vs. Fighter Bravo');
    await expect(page.locator('#ledger-summary')).toContainText(/Bets shown\s*2/);
    await expect(page.locator('#ledger-summary')).toContainText('Singles + parlays');
    await expect(page.locator('#bets tr').filter({hasText:'2-leg parlay'})).toHaveCount(1);
    await page.locator('#hide-parlays').check({force:true});
    await expect(page.locator('#ledger-summary')).toContainText(/Bets shown\s*1/);
    await expect(page.locator('#ledger-summary')).toContainText('Singles only');
    await expect(page.locator('#bets tr').filter({hasText:'2-leg parlay'})).toHaveCount(0);
    await expect(page.locator('#bets tr').filter({hasText:'Fighter Alpha'})).toHaveCount(1);
  } finally {
    await request.delete(base+'/api/bets/'+single.id);
    await request.delete(base+'/api/bets/'+parlay.id);
  }
});

test('ledger toggle pushes settled bets below pending bets', async ({page, request}) => {
  const settled=await (await request.post(base+'/api/bets',{data:{event_id:'test-card',event_name:'Browser verification card',fight_name:'Sort settled contract',selection:'Settled Alpha',american_odds:100,cash_stake:10,book:'DK'}})).json();
  const pending=await (await request.post(base+'/api/bets',{data:{event_id:'test-card',event_name:'Browser verification card',fight_name:'Sort pending contract',selection:'Pending Bravo',american_odds:100,cash_stake:10,book:'DK'}})).json();
  try {
    await request.patch(base+'/api/bets/'+settled.id,{data:{status:'win'}});
    await page.goto(base);
    await page.locator('#search').fill('Sort ');
    await expect(page.locator('#bets tr')).toHaveCount(2);
    await page.getByLabel('Settled at bottom').check();
    await expect(page.locator('#bets tr').first()).toContainText('Pending Bravo');
    await expect(page.locator('#bets tr').last()).toContainText('Settled Alpha');
  } finally {
    await request.delete(base+'/api/bets/'+settled.id);
    await request.delete(base+'/api/bets/'+pending.id);
  }
});

test('fighter-specific 60-second special builds leg selection', async ({page, request}) => {
  await page.goto(base);
  await page.locator('#matchup').selectOption('0');
  await expect(page.locator('#fight_name')).toHaveValue('Fighter Alpha vs. Fighter Bravo');
  await page.getByRole('group',{name:'Bet type'}).getByRole('button',{name:'Other',exact:true}).click();
  await page.getByRole('button',{name:'Fighter to win in under 60 seconds',exact:true}).click();
  await expect(page.locator('[data-builder="specialFighter"]')).toBeVisible();
  await page.locator('[data-builder="specialFighter"]').selectOption('Fighter Bravo');
  await expect(page.locator('#selection')).toHaveValue('Fighter Bravo to Win inside the First 60 Seconds of the Fight');
  await expect(page.locator('#market')).toHaveValue('Fighter to win in under 60 seconds');
  await page.locator('#american_odds').fill('720');
  await page.getByRole('button',{name:'+$2.50',exact:true}).click();
  await page.getByRole('button',{name:'Save bet',exact:true}).click();
  await expect(page.locator('#message')).toContainText(/committed|saved/i);
  const data=await (await request.get(base+'/api/bets')).json();
  const bet=data.bets.find(b=>b.selection==='Fighter Bravo to Win inside the First 60 Seconds of the Fight');
  try {
    expect(bet).toBeTruthy();
    expect(bet.market).toBe('Fighter to win in under 60 seconds');
    expect(bet.fight_name).toBe('Fighter Alpha vs. Fighter Bravo');
  } finally { if(bet) await request.delete(base+'/api/bets/'+bet.id); }
});

test('fast entry, direct controls and settled readback', async ({page, request}) => {
  await page.goto(base);
  await expect(page.locator('#fight-card button').first()).toBeVisible();
  await page.getByRole('button', {name:'FD',exact:true}).click();
  await page.locator('#fight-card button').first().click();
  await page.getByRole('button',{name:'+$2.50',exact:true}).click();
  await page.getByRole('button',{name:'+$1',exact:true}).click();
  await expect(page.locator('#cash_stake')).toHaveValue('3.5');
  await page.locator('#cash_stake').fill('10');
  await page.locator('#bonus_stake').fill('5');
  await page.locator('#american_odds').fill('150');
  await expect(page.locator('#calc')).toContainText('$32.50');
  await page.getByRole('button',{name:'Save bet',exact:true}).click();
  await expect(page.locator('#message')).toContainText('Saved');
  const row=page.locator('#bets tr').first();
  await row.getByRole('button',{name:'Win',exact:true}).click();
  await expect(row).toContainText('$32.50');
  await row.getByRole('button',{name:'Pending',exact:true}).click();
  await expect(row.locator('.tag')).toHaveText('Pending');
  let bets=await (await request.get(base+'/api/bets')).json();
  expect(bets.bets[0].payout).toBeNull();
  await page.reload();
  await expect(page.locator('#bets tr').first()).toContainText('FD');
  await request.delete(base+'/api/bets/'+bets.bets[0].id);
});
test('odds sign, Fighter Props and duplicate warning retain a cancelled ticket', async ({page,request}) => {
  await page.goto(base);
  await page.locator('#fight-card button').first().click();
  await page.getByRole('button',{name:'Negative odds',exact:true}).click();
  await expect(page.locator('#american_odds')).toHaveValue('-150');
  await page.getByRole('button',{name:'Positive odds',exact:true}).click();
  await page.getByRole('button',{name:'Fighter Props',exact:true}).click();
  await page.getByRole('button',{name:'+$5',exact:true}).click();
  await page.getByRole('button',{name:'Save bet',exact:true}).click();
  await expect(page.locator('#message')).toContainText('Saved');
  await page.getByRole('button',{name:'+$5',exact:true}).click();
  let warning='';
  page.once('dialog', async dialog => { warning=dialog.message(); await dialog.dismiss(); });
  await page.getByRole('button',{name:'Save bet',exact:true}).click();
  await expect(page.locator('#message')).toContainText('Duplicate cancelled');
  expect(warning).toContain('Possible duplicate');
  await expect(page.locator('#cash_stake')).toHaveValue('5');
  const data=await (await request.get(base+'/api/bets')).json();
  expect(data.bets).toHaveLength(1);
  await request.delete(base+'/api/bets/'+data.bets[0].id);
});
test('failed event reconciliation locks entry until a successful refresh',async({page})=>{
  await page.goto(base);
  await expect(page.locator('#selection')).toBeEnabled();
  await page.route('**/api/events/active/*', route=>route.fulfill({status:503,body:'offline'}));
  await page.route('**/api/events', route=>route.fulfill({status:503,body:'offline'}));
  await page.locator('#active-event').dispatchEvent('change');
  await expect(page.locator('#message')).toContainText('Could not confirm');
  await expect(page.locator('#selection')).toBeDisabled();
  await page.unrouteAll();
  await page.getByRole('button',{name:'↻ Refresh',exact:true}).click();
  await expect(page.locator('#selection')).toBeEnabled();
});
test('failed save preserves the ticket and in-flight entry is locked',async({page})=>{
  await page.goto(base);
  await page.locator('#fight-card button').first().click();
  await page.getByRole('button',{name:'+$5',exact:true}).click();
  let release;
  const held=new Promise(resolve=>release=resolve);
  await page.route('**/api/bets',async route=>{
    if(route.request().method() !== 'POST') return route.continue();
    await held; await route.fulfill({status:503,body:'test unavailable'});
  });
  await page.getByRole('button',{name:'Save bet',exact:true}).click();
  await expect(page.locator('#selection')).toBeDisabled();
  await expect(page.locator('#refresh')).toBeDisabled();
  release();
  await expect(page.locator('#message')).toContainText('Save not confirmed');
  await expect(page.locator('#cash_stake')).toHaveValue('5');
  await expect(page.locator('#selection')).toHaveValue('Fighter Alpha');
  await expect(page.locator('#selection')).toBeEnabled();
});
test('desktop ticket exposes save without a long scroll',async({page})=>{
  await page.setViewportSize({width:1512,height:1000});
  await page.goto(base);
  await expect(page.locator('#save')).toBeEnabled();
  const box=await page.locator('#save').boundingBox();
  expect(box.y+box.height).toBeLessThanOrEqual(1000);
});
test('custom matchup does not select first fight; whole rounds; mobile fits',async({page})=>{
  await page.goto(base);
  await expect(page.locator('#fight-card button').first()).toBeVisible();
  await page.locator('#matchup').selectOption('0');
  await page.locator('#fight_name').fill('Custom fight');
  await page.locator('#selection').fill('My pick');
  await page.locator('#american_odds').fill('200');
  await page.locator('#matchup').selectOption('');
  await expect(page.locator('#fight_name')).toHaveValue('Custom fight');
  for(const type of ['Fight to Start Round','Fighter Parlay','Round Prop']) {
    await page.getByRole('button',{name:type,exact:true}).click();
    expect(await page.locator('#round').innerText()).not.toContain('.5');
  }
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
