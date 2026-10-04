/* UFC v3 — server-authoritative state, small explicit controls. */
const __absent = {};
const $ = s => document.querySelector(s) || (__absent[s] ??= document.createElement('input')); // missing elements (e.g. on the watch page) become inert stand-ins
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = x => '$' + Number(x || 0).toFixed(2);
const odds = x => Number(x) > 0 ? '+' + x : x;
const statuses = ['pending','win','loss','void'];
const title = s => s[0].toUpperCase() + s.slice(1);
const form = $('#bet-form');
let active = null, bets = [], filter = '', bookFilter = '', matchupFilter = '', hideParlays = false, pushSettledBottom = false, loadVersion = 0, saving = false, editingBetId = null;
let allEvents = [];
let queuedWrites = 0, statsScope = 'active', latestTimeline = null;
const busyBets = new Set();
const fighterSpecials = new Set(['Fighter to win in under 60 seconds']);
const themeKey = 'ufc_v3_color_theme';
function applyTheme(value) {
  const theme = value || 'octagon';
  const activeTheme = theme === 'octagon' ? '' : theme;
  document.documentElement.dataset.theme = activeTheme;
  document.body.dataset.theme = activeTheme;
  const picker = $('#theme-select');
  if (picker) picker.value = theme;
}
function setupThemePicker() {
  const picker = $('#theme-select');
  if (!picker) return;
  applyTheme(localStorage.getItem(themeKey) || 'octagon');
  picker.onchange = () => {
    applyTheme(picker.value);
    localStorage.setItem(themeKey, picker.value);
  };
}
setupThemePicker();
async function api(path, options = {}) {
  const response = await fetch(path, {...options, cache:'no-store'});
  if (!response.ok) {
    let detail = await response.text();
    try { detail = JSON.parse(detail).detail; } catch (_) { /* non-JSON proxy error */ }
    throw new Error(typeof detail === 'string' ? detail : 'Invalid input. Check your fields.');
  }
  return response.status === 204 ? null : response.json();
}
const json = data => ({headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
function message(text, error = false) {
  $('#message').textContent = text;
  $('#message').className = error ? 'error' : 'ok';
}
function selected(group, attribute, value) {
  document.querySelectorAll(`${group} button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attribute] === value)));
}
function setType(value) {
  $('#bet_type').value = value;
  selected('#type-controls','type',value);
  fillRounds();
  updateTicketFields();
  syncParlaySaveUI();
  if (value === 'Parlay' || value === 'Fighter Parlay') $('#parlay-panel').open = true;
}
function selectedFight() {
  const value = $('#matchup').value;
  if (value === '') return null;
  return active?.fights?.[Number(value)] || null;
}
function selectedFightIndex() {
  const value = $('#matchup').value;
  return value === '' ? null : Number(value);
}
function truthyFlag(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}
function hasFiveRoundMarker(fight) {
  const text = [fight?.weight, fight?.title, fight?.label, fight?.name, fight?.notes, fight?.note, fight?.description, fight?.division, fight?.type, fight?.competitionType].filter(Boolean).join(' ');
  return /(?:championship|champion|title\s*[- ]?fight|interim\s+title|5\s*[- ]?round)/i.test(text);
}
function isLegacyMainEvent(fight, fightIndex, fights) {
  if (!fight || !Array.isArray(fights) || !truthyFlag(fight.is_main ?? fight.main)) return false;
  const mainIndexes = fights.map((candidate, index) => truthyFlag(candidate?.is_main ?? candidate?.main) ? index : -1).filter(index => index >= 0);
  if (!mainIndexes.length) return false;
  const hasScheduledTimes = mainIndexes.some(index => fights[index].fight_time || fights[index].time);
  const inferredIndex = hasScheduledTimes ? mainIndexes[mainIndexes.length - 1] : mainIndexes[0];
  return fightIndex === inferredIndex;
}
function maxRoundsFor(fight, fightIndex = selectedFightIndex(), fights = active?.fights || []) {
  const explicitRounds = Number(fight?.rounds);
  if (explicitRounds >= 5 || truthyFlag(fight?.championship) || hasFiveRoundMarker(fight)) return 5;
  if (explicitRounds > 0) return explicitRounds;
  return isLegacyMainEvent(fight, fightIndex, fights) ? 5 : 3;
}
function fighterValues(fight, includeAny = false, anyLabel = 'Any / Fight Ends By') {
  const values = includeAny ? [{value:'', label:anyLabel}] : [];
  if (fight?.fighter_a) values.push({value:fight.fighter_a, label:fight.fighter_a});
  if (fight?.fighter_b) values.push({value:fight.fighter_b, label:fight.fighter_b});
  return values;
}
function fighterOptions(fight, includeAny = false, anyLabel = 'Any / Fight Ends By') {
  return fighterValues(fight, includeAny, anyLabel).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
}
function choiceButtons(key, values, selectedValue = null) {
  return `<div class="choice-buttons" data-choice-group="${esc(key)}">${values.map((item, index) => {
    const value = typeof item === 'string' ? item : item.value;
    const label = typeof item === 'string' ? item : item.label;
    const selected = selectedValue === null ? index === 0 : value === selectedValue;
    return `<button type="button" data-builder="${esc(key)}" data-builder-value="${esc(value)}" aria-pressed="${selected}">${esc(label)}</button>`;
  }).join('')}</div>`;
}
function roundOptions(max, start = 1) {
  return Array.from({length: Math.max(0, max - start + 1)}, (_, i) => start + i).map(r => `<option value="${r}">Round ${r}</option>`).join('');
}
function ouLineValues(unit, max) {
  const cap = unit === 'Minutes' ? max * 5 - 0.5 : max - 0.5;
  const label = unit === 'Minutes' ? 'minutes' : 'rounds';
  const values = [];
  for (let line = 0.5; line <= cap + 0.001; line += 1) {
    const value = line.toFixed(1);
    values.push({value, label: `${value} ${label}`});
  }
  return values;
}
function ouLineButtons(unit, max, selectedValue = null) {
  return choiceButtons('line', ouLineValues(unit, max), selectedValue);
}
function fighterParlayRoundOptions(max) {
  const single = Array.from({length:max}, (_, i) => `<option value="Round ${i+1}">Round ${i+1}</option>`);
  const ranges = ['1-2','2-3'];
  if (max >= 5) ranges.push('3-4','4-5','1-2-3','2-3-4','3-4-5');
  return single.concat(ranges.map(r => `<option value="Rounds ${r}">Rounds ${r}</option>`)).join('');
}
function setSelection(value, market = '', round = '') {
  $('#selection').value = value;
  $('#market').value = market;
  $('#round').value = round;
  updateSelectionBuilderPressed();
  preview();
}
function updateSelectionBuilderPressed() {
  const current = $('#selection').value.trim();
  document.querySelectorAll('#selection-builder [data-selection]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.selection === current)));
}
function renderSelectionBuilder() {
  const container = $('#selection-builder');
  if (!container) return;
  const type = $('#bet_type').value;
  const fight = selectedFight();
  const fightIndex = selectedFightIndex();
  const max = maxRoundsFor(fight, fightIndex);
  const needsFight = !fight && type !== 'Other';
  if (needsFight) {
    container.innerHTML = '<p class="builder-note">Select a matchup first, then choose the bet details.</p>';
    $('#selection').placeholder = 'Select a matchup first';
    return;
  }
  const methods = ['KO','Submission','Decision','KO or Submission','KO or Decision','Submission or Decision'];
  const spreads = ['-0.5','+0.5','-1.5','+1.5','-2.5','+2.5','-3.5','+3.5','-4.5','+4.5','-5.5','+5.5'];
  const specials = ['Custom Special Bet','Finish Only Moneyline (If Decision No Action)','Finish in last 10 seconds of any round','Fight does go the distance','Fight to end in a draw','Either fighter to win by split decision','Fight to end by split decision','Fighter to win in under 60 seconds'];
  if (type === 'Moneyline') {
    container.innerHTML = `<div class="workflow-step"><label>Moneyline pick</label><div class="fighter-pick-buttons">${['a','b'].map(side => {
      const fighter = fight['fighter_' + side] || '';
      const price = fight['odds_' + side];
      return `<button type="button" data-ml-side="${side}" data-selection="${esc(fighter)}"><strong>${esc(fighter)}</strong><span>${price ? esc(odds(price)) : 'Enter odds manually'}</span></button>`;
    }).join('')}</div></div>`;
  } else if (type === 'Method of Victory') {
    container.innerHTML = `<div class="workflow-step"><label>Fighter</label>${choiceButtons('fighter', fighterValues(fight,true))}<label>Method</label>${choiceButtons('method', methods)}</div>`;
  } else if (type === 'Round Prop' || type === 'Round Betting') {
    container.innerHTML = `<div class="workflow-step"><label>Fighter</label>${choiceButtons('fighter', fighterValues(fight,true,'Any / Fight Ends In'))}<label>Round</label>${choiceButtons('round', Array.from({length:max},(_,i)=>String(i+1)))}</div>`;
  } else if (type === 'Over/Under') {
    container.innerHTML = `<div class="workflow-step"><label>Direction</label>${choiceButtons('direction',['Over','Under'])}<label>Unit</label>${choiceButtons('unit',['Rounds','Minutes'])}<label>Line</label>${ouLineButtons('Rounds',max)}</div>`;
  } else if (type === 'Point Spread') {
    container.innerHTML = `<div class="workflow-step"><label>Fighter</label>${choiceButtons('fighter', fighterValues(fight,false))}<label>Spread</label>${choiceButtons('spread', spreads, '-1.5')}</div>`;
  } else if (type === 'Fight to Start Round') {
    container.innerHTML = `<div class="workflow-step"><label>Start round</label>${choiceButtons('round', Array.from({length:Math.max(0,max-1)},(_,i)=>String(i+2)))}</div>`;
  } else if (type === 'Fighter Props') {
    container.innerHTML = `<div class="workflow-step"><label>Fighter</label>${choiceButtons('fighter', fighterValues(fight,false))}<label>Stat</label>${choiceButtons('stat',['Takedowns','Significant Strikes'])}<label>Direction</label>${choiceButtons('direction',['Over','Under'])}<label>Line</label><input data-builder="line" type="number" step="0.5" value="1.5"></div>`;
  } else if (type === 'Fighter Parlay') {
    container.innerHTML = `<div class="workflow-step"><label>Fighter</label>${choiceButtons('fighter', fighterValues(fight,true))}<label>Method</label>${choiceButtons('method', methods)}<label>Round/range</label>${choiceButtons('round', Array.from({length:max},(_,i)=>`Round ${i+1}`).concat(max >= 5 ? ['Rounds 1-2','Rounds 2-3','Rounds 3-4','Rounds 4-5','Rounds 1-2-3','Rounds 2-3-4','Rounds 3-4-5'] : ['Rounds 1-2','Rounds 2-3']))}</div>`;
  } else if (type === 'Go the Distance') {
    container.innerHTML = `<div class="workflow-step"><label>Goes distance?</label>${choiceButtons('answer',['Yes','No'])}</div>`;
  } else if (type === 'Other') {
    container.innerHTML = `<div class="workflow-step"><label>Special market</label>${choiceButtons('special', specials)}<div id="other-extra" class="builder-grid"></div></div>`;
  } else {
    container.innerHTML = '<p class="builder-note">Enter the custom selection below.</p>';
  }
  updateBuiltSelection();
}
function updateBuiltSelection() {
  const type = $('#bet_type').value, fight = selectedFight();
  const get = key => {
    const pressed = $(`#selection-builder [data-builder="${key}"][aria-pressed="true"]`);
    if (pressed) return pressed.dataset.builderValue || '';
    return $(`#selection-builder [data-builder="${key}"]`)?.value || '';
  };
  if (!$('#selection-builder')) return;
  if (type === 'Moneyline') { updateSelectionBuilderPressed(); return; }
  let value = '', market = '', round = '';
  if (type === 'Method of Victory') { const f=get('fighter'), m=get('method'); value = f ? `${f} by ${m}` : `Fight will end by ${m}`; market = m; }
  else if (type === 'Round Prop' || type === 'Round Betting') { const f=get('fighter'), r=get('round'); value = f ? `${f} in Round ${r}` : `Fight will end in Round ${r}`; round = `Round ${r}`; }
  else if (type === 'Over/Under') { const d=get('direction'), l=get('line'), u=get('unit') === 'Minutes' ? 'minutes' : 'rounds'; value = `${d} ${l} ${u}`; market = d; }
  else if (type === 'Point Spread') { value = `${get('fighter')} ${get('spread')}`; market = get('spread'); }
  else if (type === 'Fight to Start Round') { value = `Fight to start Round ${get('round')}`; round = `Round ${get('round')}`; }
  else if (type === 'Fighter Props') { value = `${get('fighter')} ${get('direction')} ${Number(get('line') || 0.5)} ${get('stat')}`; market = `${get('direction')} ${get('stat')}`; }
  else if (type === 'Fighter Parlay') { const f=get('fighter'), m=get('method'), r=get('round'); value = f ? `${f} by ${m} in ${r}` : `Fight will end by ${m} in ${r}`; market = m; round = r; }
  else if (type === 'Go the Distance') { value = `Fight does go the distance: ${get('answer')}`; market = get('answer'); }
  else if (type === 'Other') {
    const special = get('special'); const extra = $('#other-extra');
    if (extra) {
      const priorFighter = get('finishFighter');
      const priorSpecialFighter = get('specialFighter');
      const priorCustom = get('custom');
      const needed = special === 'Finish Only Moneyline (If Decision No Action)' && fight
        ? `<label>Fighter<select data-builder="finishFighter">${fighterOptions(fight,false)}</select></label>`
        : (fighterSpecials.has(special) && fight
          ? `<label>Fighter<select data-builder="specialFighter">${fighterOptions(fight,false)}</select></label>`
          : (special === 'Custom Special Bet' ? '<label>Custom selection<input data-builder="custom" placeholder="Type special market"></label>' : ''));
      if (extra.dataset.special !== special || !extra.innerHTML) {
        extra.innerHTML = needed;
        extra.dataset.special = special;
        const finishSelect = $('#selection-builder [data-builder="finishFighter"]');
        const specialFighterSelect = $('#selection-builder [data-builder="specialFighter"]');
        const customInput = $('#selection-builder [data-builder="custom"]');
        if (priorFighter && finishSelect) finishSelect.value = priorFighter;
        if (priorSpecialFighter && specialFighterSelect) specialFighterSelect.value = priorSpecialFighter;
        if (priorCustom && customInput) customInput.value = priorCustom;
      }
    }
    if (special === 'Custom Special Bet') value = get('custom');
    else if (special === 'Finish Only Moneyline (If Decision No Action)') value = `${get('finishFighter') || fight?.fighter_a || ''} - Finish Only Moneyline (If Decision No Action)`;
    else if (special === 'Fighter to win in under 60 seconds') value = `${get('specialFighter') || fight?.fighter_a || ''} to Win inside the First 60 Seconds of the Fight`;
    else value = special;
    market = special;
  }
  if (value || type !== 'Other') setSelection(value, market, round);
}
function updateTicketFields() {
  const type = $('#bet_type').value;
  $('#selection-row').hidden = type === 'Moneyline';
  $('#selection').readOnly = type !== 'Other' && type !== 'Parlay';
  $('#selection').placeholder = type === 'Other' ? 'Custom prop or special market' : (type === 'Parlay' ? 'Parlay title or selection summary' : 'Selection is built from the controls above');
  renderSelectionBuilder();
}
function applyMoneylineSide(side) {
  const index = selectedFightIndex();
  if (index == null) return;
  selectSide(index, side);
  updateSelectionBuilderPressed();
}
function fillRounds() {
  const fight = selectedFight();
  const max = maxRoundsFor(fight);
  $('#round').value = '';
}
function payoutFor(bet) {
  const cash = Number(bet.cash_stake) || 0, bonus = Number(bet.bonus_stake) || 0, price = Number(bet.american_odds);
  if (!price) return 0;
  return Math.round((cash + (cash + bonus) * (price > 0 ? price/100 : 100/Math.abs(price)) + Number.EPSILON) * 100)/100;
}
function currentStakes() {
  const stake = Number($('#cash_stake').value) || 0;
  return $('#bonus-bet')?.checked ? {cash_stake:0, bonus_stake:stake} : {cash_stake:stake, bonus_stake:0};
}
function preview() {
  const bet = {...currentStakes(), american_odds:$('#american_odds').value};
  if (!Number(bet.american_odds) || Number(bet.cash_stake) + Number(bet.bonus_stake) <= 0) {
    $('#calc').textContent = 'Enter odds and a stake to preview payout.';
    return;
  }
  const payout = payoutFor(bet);
  $('#calc').innerHTML = `<div><span>Potential return</span><strong>${money(payout)}</strong></div><div><span>Potential profit</span><b>${money(payout - Number(bet.cash_stake))}</b></div><small>Cash at risk ${money(bet.cash_stake)} · bonus principal is not returned</small>`;
}
function selectSide(index, side) {
  const fight = active.fights[index];
  $('#matchup').value = index;
  $('#fight_name').value = fight.matchup;
  $('#selection').value = fight['fighter_' + side];
  $('#american_odds').value = fight['odds_' + side] || '';
  $('#market').value = ''; $('#round').value = '';
  setType('Moneyline'); preview();
  document.querySelectorAll('.fight-card article').forEach((row,i) => row.classList.toggle('chosen',i === index));
  if (innerWidth < 1000) form.scrollIntoView({behavior:'smooth',block:'start'});
  $('#cash_stake').focus({preventScroll:true});
}
function populateActive(event) {
  active = event;
  renderEventPoster(event);
  $('#event_id').value = event?.id || '';
  $('#event_name').value = event?.name || '';
  const fights = event?.fights || [];
  $('#event-meta').textContent = event ? `${event.event_date || 'Date TBD'} · ${fights.length} fights${event.prelims_start ? ' · Prelims ' + event.prelims_start : ''}${event.main_start ? ' · Main ' + event.main_start : ''}` : 'No active event. Custom bets are available.';
  $('#matchup').innerHTML = '<option value="">Custom matchup…</option>' + fights.map((f,i) => `<option value="${i}">${esc(f.matchup)}</option>`).join('');
  $('#fight-card').innerHTML = fights.map((f,i) => `<article class="${f.is_main ? 'main-card-fight' : 'prelim-fight'}"><div class="fight-meta"><span>${String(i+1).padStart(2,'0')} / ${f.is_main ? 'MAIN CARD' : 'PRELIMS'}</span><span>${esc(f.weight || '')} · ${maxRoundsFor(f,i,fights)} R</span></div><div class="fighter-sides">${['a','b'].map(side => `<button type="button" data-fight="${i}" data-side="${side}"><strong>${esc(f['fighter_' + side])}</strong><span>${f['odds_' + side] ? esc(odds(f['odds_' + side])) : 'No odds'}</span></button>`).join('<span class="versus">VS</span>')}</div>${f.odds_updated_at ? `<small class="muted">Odds as of ${esc(f.odds_updated_at)}</small>` : ''}</article>`).join('') || '<p class="empty">No card for this event. Enter a custom matchup in your ticket.</p>';
  renderSelectionBuilder();
  renderBets();
}
function formatPosterDate(value) {
  if (!value) return 'Date TBD';
  return new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${value}T12:00:00Z`));
}
function renderPosterSelector(events, activeId) {
  const sel = $('#poster-event-select');
  if (sel) {
    sel.innerHTML = events.map(e => `<option value="${esc(e.id)}">${esc(e.event_date || 'TBD')} · ${esc(e.name)}</option>`).join('');
    sel.value = activeId || '';
    sel.disabled = !events.length;
  }
  const host = $('#poster-upcoming');
  if (!host) return;
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date());
  const upcoming = events
    .filter(e => e.event_date && e.event_date >= today)
    .sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''))
    .slice(0, 2);
  host.innerHTML = upcoming.length
    ? upcoming.map(e => `<button type="button" data-event-id="${esc(e.id)}"><span class="poster-upcoming-date">${esc(e.event_date)}</span><span class="poster-upcoming-name">${esc(e.name)}</span></button>`).join('')
    : '<p class="muted poster-upcoming-empty">No upcoming events.</p>';
}
function renderEventPoster(event) {
  const host = $('#poster-content');
  if (!host) return;
  const fights = event?.fights || [];
  if (!event) {
    host.innerHTML = '<div class="poster-empty">No active event selected. Pick an event to generate its banner.</div>';
    return;
  }
  const main = fights.at(-1) || {};
  const prelims = fights.filter(f=>!truthyFlag(f.is_main ?? f.main)).length;
  const rounds = main.matchup ? maxRoundsFor(main, fights.indexOf(main), fights) : null;
  const eventName = event.name || 'Active UFC event';
  const posterTone = Math.abs([...eventName].reduce((sum,char)=>sum+char.charCodeAt(0),0)) % 4;
  const posterUrl = (event.poster_url || '').trim() || (/contender series/i.test(eventName) ? 'static/dwcs-poster.jpg' : '');
  host.dataset.posterTone = String(posterTone);
  host.innerHTML = `<figure class="poster-image-wrap">${posterUrl ? `<img class="poster-image" alt="Official marketing poster for ${esc(eventName)}" src="${esc(posterUrl)}">` : '<div class="poster-missing">No official poster set yet.</div>'}</figure><div class="poster-copy"><h2>${esc(eventName)}</h2><div class="poster-main"><span>${esc(main.fighter_a || 'Fighter A')}</span><b>VS</b><span>${esc(main.fighter_b || 'Fighter B')}</span></div><p class="muted poster-meta">${esc(formatPosterDate(event.event_date))}${event.prelims_start ? ' · Prelims '+esc(event.prelims_start) : ''}${event.main_start ? ' · Main '+esc(event.main_start) : ''}${main.weight ? ' · '+esc(main.weight) : ''}${rounds ? ' · '+rounds+' rounds' : ''}${event.venue ? ' · '+esc(event.venue) : ''}</p></div>`;
}
$('#fight-card').onclick = e => { const b = e.target.closest('[data-fight]'); if (b && !saving) selectSide(Number(b.dataset.fight), b.dataset.side); };
$('#matchup').onchange = e => {
  if (e.target.value === '') return; // Number('') is zero, not a custom fight.
  const f = active?.fights[Number(e.target.value)];
  if (!f) return;
  $('#fight_name').value = f.matchup;
  if ($('#bet_type').value === 'Moneyline') {
    if (!$('#selection').value) $('#selection').value = f.fighter_a;
    if (!$('#american_odds').value) $('#american_odds').value = f.odds_a || '';
  }
  renderSelectionBuilder();
  preview();
};
async function loadEvents() {
  const data = await api('api/events');
  allEvents = data.events;
  $('#active-event').innerHTML = data.events.map(e => `<option value="${esc(e.id)}">${esc(e.event_date || 'TBD')} · ${esc(e.name)}</option>`).join('');
  populateActive(data.active_event);
  if (active) $('#active-event').value = active.id;
  $('#active-event').disabled = !data.events.length;
  renderPosterSelector(allEvents, active?.id);
  $('#entry-fields').disabled = false;
  await load();
}
async function syncCards(scope = 'active') {
  const activeOnly = scope === 'active';
  const button = activeOnly ? $('#sync-active') : $('#sync-all');
  if (!button || saving) return;
  if (!activeOnly && !confirm('Sync all events and fight cards from the bundled data/ufc-db.js? This refreshes every card catalog, not your bets.')) return;
  const old = button.textContent;
  button.disabled = true; $('#sync-active').disabled = true; $('#sync-all').disabled = true;
  message(activeOnly ? 'Syncing this fight card…' : 'Syncing all fight cards…');
  try {
    const path = activeOnly ? 'api/events/' + encodeURIComponent(active?.id || $('#active-event').value) + '/sync' : 'api/events/sync';
    const result = await api(path, {method:'POST'});
    await loadEvents();
    if (activeOnly) {
      const refreshed = await api('api/events/active');
      populateActive(refreshed);
    }
    message(`Synced ${result.synced_events} event${result.synced_events === 1 ? '' : 's'} · ${result.synced_fights} fights.`);
  } catch(error) {
    message('Sync failed: ' + error.message, true);
  } finally {
    button.textContent = old;
    $('#sync-active').disabled = false; $('#sync-all').disabled = false;
  }
}
$('#sync-active').onclick = () => syncCards('active');
$('#sync-all').onclick = () => syncCards('all');
$('#sync-upcoming').onclick = async () => {
  const btn = $('#sync-upcoming');
  if (!btn || btn.disabled || saving) return;
  btn.disabled = true;
  message('Checking ESPN for upcoming cards…');
  try {
    const r = await api('api/events/discover', {method:'POST'});
    await loadEvents();
    message(r.added_count ? `Added ${r.added_count} new event${r.added_count === 1 ? '' : 's'}: ${r.added.map(e => `${e.name} (${e.date}, ${e.fights} fights)`).join(', ')}` : 'No new upcoming events found on ESPN.');
  } catch (error) {
    message('ESPN discovery failed: ' + error.message, true);
  } finally {
    btn.disabled = false;
  }
};
$('#refresh-odds').onclick = async () => {
  if (!active?.id) return;
  const btn = $('#refresh-odds'); btn.disabled = true;
  try {
    const r = await api('api/events/' + encodeURIComponent(active.id) + '/odds', {method:'POST'});
    message(`Odds refreshed for ${r.updated} fight${r.updated === 1 ? '' : 's'}` + (r.missing.length ? ` · no line for: ${r.missing.join('; ')}` : ''), false);
    await loadEvents();
  } catch (error) { message('Odds refresh failed: ' + error.message, true); }
  finally { btn.disabled = false; }
};

async function setActiveEventId(id) {
  const pickers = [$('#active-event'), $('#poster-event-select')].filter(Boolean);
  const previous = active?.id;
  let reconciled = false;
  pickers.forEach(p => p.disabled = true);
  $('#entry-fields').disabled = true; $('#refresh').disabled = true;
  try {
    await api('api/events/active/' + encodeURIComponent(id), {method:'PUT'});
    const event = await api('api/events/active');
    populateActive(event);
    pickers.forEach(p => p.value = event.id);
    renderPosterSelector(allEvents, event.id);
    await load();
    // An event change clears matchup-bound fields, not cash, book or notes.
    $('#fight_name').value = ''; $('#selection').value = ''; $('#american_odds').value = ''; preview();
    reconciled = true;
    message('Active event saved. Choose a matchup for this card.');
  } catch (error) {
    pickers.forEach(p => p.value = previous || ''); message('Could not confirm event change: ' + error.message + '. Refresh before logging.', true);
    try { await loadEvents(); reconciled = true; } catch (_) { /* Keep entry locked until reconciliation. */ }
  } finally { pickers.forEach(p => p.disabled = !reconciled); $('#entry-fields').disabled = !reconciled; $('#refresh').disabled = false; }
}
$('#active-event').onchange = e => setActiveEventId(e.target.value);
$('#poster-event-select').onchange = e => setActiveEventId(e.target.value);
$('#poster-upcoming').onclick = e => {
  const b = e.target.closest('button[data-event-id]');
  if (b && !b.disabled) setActiveEventId(b.dataset.eventId);
};
function isParlayTicket() { return ['Parlay','Fighter Parlay'].includes($('#bet_type').value); }
function syncParlaySaveUI() {
  const legs = [...$('#legs').children];
  const hasLegs = isParlayTicket() && legs.length > 0;
  const completeLegs = legs.length >= 2 && legs.every(leg => leg.querySelector('.leg-fight').value.trim() && leg.querySelector('.leg-selection').value.trim());
  $('#save-parlay').hidden = !hasLegs;
  $('#save-parlay').disabled = hasLegs && !completeLegs;
  $('#save').hidden = hasLegs;
}
function clearStagedPickAfterLeg() {
  const keepPick = $('#keep-pick').checked;
  ['#selection','#american_odds','#market','#round'].forEach(selector=>$(selector).value='');
  if (!keepPick) {
    $('#fight_name').value = '';
    $('#matchup').value = '';
  }
  renderSelectionBuilder(); preview();
}
function addLeg(data = {}) {
  const leg = document.createElement('div'); leg.className = 'leg';
  leg.innerHTML = `<input class="leg-fight" aria-label="Leg fight" placeholder="Fight" value="${esc(data.fight_name)}"><input class="leg-selection" aria-label="Leg selection" placeholder="Selection" value="${esc(data.selection)}"><input class="leg-odds" aria-label="Leg odds optional" type="number" placeholder="Leg odds optional" value="${esc(data.american_odds)}"><button type="button" class="secondary" aria-label="Remove leg">×</button>`;
  leg.querySelector('button').onclick = () => { leg.remove(); syncParlaySaveUI(); };
  leg.querySelectorAll('input').forEach(input => input.oninput = syncParlaySaveUI);
  $('#legs').append(leg); $('#parlay-panel').open = true;
  if (!isParlayTicket()) setType('Parlay'); else syncParlaySaveUI();
}
$('#add-leg').onclick = () => addLeg();
$('#add-pick-leg').onclick = () => {
  const fight = selectedFight();
  const current = {fight_name:$('#fight_name').value.trim(),selection:$('#selection').value.trim() || fight?.fighter_a || '',american_odds:$('#american_odds').value};
  if (!current.fight_name || !current.selection) { message('Choose a matchup and selection before adding the current pick.', true); return; }
  addLeg(current); clearStagedPickAfterLeg();
};
function payload() {
  const data = Object.fromEntries(new FormData(form));
  const result = {};
  ['event_id','event_name','book','fight_name','selection','bet_type','market','round_label','notes'].forEach(k => result[k] = (data[k] || '').trim());
  if (result.book === 'Other') result.book = $('#other-book').value.trim() || 'Other';
  result.american_odds = Number(data.american_odds);
  Object.assign(result, currentStakes());
  result.is_live_stream = data.is_live_stream === 'on';
  result.legs = [...$('#legs').children].map(e => ({fight_name:e.querySelector('.leg-fight').value.trim(),selection:e.querySelector('.leg-selection').value.trim(),american_odds:e.querySelector('.leg-odds').value === '' ? null : Number(e.querySelector('.leg-odds').value)})).filter(x => x.fight_name || x.selection);
  return result;
}
$('#book-controls').onclick = e => {
  const b=e.target.closest('[data-book]'); if (!b) return;
  $('#book').value=b.dataset.book; selected('#book-controls','book',b.dataset.book);
  $('#other-book-label').hidden=b.dataset.book !== 'Other';
};
const types = ['Moneyline','Method of Victory','Parlay','Fighter Parlay','Fight to Start Round','Fighter Props','Round Prop','Round Betting','Go the Distance','Over/Under','Point Spread','Other'];
$('#type-controls').innerHTML = types.map(t => `<button type="button" data-type="${t}" aria-pressed="${t === 'Moneyline'}">${t}</button>`).join('');
$('#type-controls').onclick = e => { const b=e.target.closest('[data-type]'); if(b) setType(b.dataset.type); };
$('#selection-builder').onclick = e => {
  const ml=e.target.closest('[data-ml-side]');
  if(ml) { applyMoneylineSide(ml.dataset.mlSide); return; }
  const choice=e.target.closest('button[data-builder]');
  if(!choice) return;
  document.querySelectorAll(`#selection-builder [data-builder="${choice.dataset.builder}"]`).forEach(b => b.setAttribute('aria-pressed','false'));
  choice.setAttribute('aria-pressed','true');
  if (choice.dataset.builder === 'unit') {
    const fight = selectedFight();
    const lineGroup = $('#selection-builder [data-choice-group="line"]');
    if (lineGroup) lineGroup.outerHTML = ouLineButtons(choice.dataset.builderValue, maxRoundsFor(fight, selectedFightIndex()));
  }
  updateBuiltSelection();
};
$('#selection-builder').onchange = e => {
  updateBuiltSelection();
};
$('#selection-builder').oninput = e => { if(e.target.matches('[data-builder]')) updateBuiltSelection(); };
[1,2.5,5,10].forEach(amount => {
  const b=document.createElement('button'); b.type='button'; b.textContent='+$' + (amount === 2.5 ? '2.50' : amount);
  b.onclick=()=>{ $('#cash_stake').value=Math.round(((Number($('#cash_stake').value)||0)+amount)*100)/100; preview(); };
  $('#stake-chips').append(b);
});
$('#clear-stake').onclick=()=>{ $('#cash_stake').value=0; preview(); };
['#american_odds','#cash_stake'].forEach(s => $(s).oninput=preview);
$('#bonus-bet').onchange=preview;
$('#selection').oninput = updateSelectionBuilderPressed;
[['#positive-odds',1],['#negative-odds',-1]].forEach(([selector,sign]) => $(selector).onclick=()=>{ if($('#american_odds').value) $('#american_odds').value=Math.abs(Number($('#american_odds').value))*sign; preview(); });
function duplicateKey(b) {
  const normalize = x => String(x ?? '').trim().toLowerCase().replace(/\s+/g,' ');
  const fields=['event_id','fight_name','selection','bet_type','book','market','round_label'].map(k=>normalize(b[k]));
  fields.push(...['cash_stake','bonus_stake','american_odds'].map(k=>Number(b[k])));
  fields.push((b.legs || []).map(l=>[normalize(l.fight_name),normalize(l.selection),Number(l.american_odds)].join('|')).sort());
  return JSON.stringify(fields);
}
function resetEditMode() {
  editingBetId = null;
  $('#save').textContent = 'Save bet';
  $('#cancel-edit').hidden = true;
  $('#message').className = '';
}
function resetTicketAfterQueue() {
  const savedParlay = isParlayTicket() && $('#legs').children.length > 0;
  const keepPick = $('#keep-pick').checked;
  resetEditMode();
  if (savedParlay) $('#legs').innerHTML = '';
  if (!keepPick) {
    ['#fight_name','#selection','#american_odds','#market','#notes'].forEach(s=>$(s).value='');
    $('#matchup').value=''; $('#round').value='';
  } else if (savedParlay) {
    ['#selection','#market','#notes'].forEach(s=>$(s).value='');
    $('#round').value='';
  }
  if (!keepPick) {
    $('#cash_stake').value=0; $('#bonus_stake').value=0; $('#bonus-bet').checked=false;
  }
  renderSelectionBuilder(); syncParlaySaveUI(); preview();
}
function loadBetIntoTicket(id, {duplicate = false} = {}) {
  const bet = bets.find(x => x.id === id);
  if (!bet) { message('Could not find that bet in the current ledger view.', true); return; }
  editingBetId = duplicate ? null : id;
  const eventPicker = $('#active-event');
  if (bet.event_id && eventPicker.value !== bet.event_id) message('Loaded a bet from another event. Save will update the bet, not change active event.');
  $('#event_id').value = bet.event_id || active?.id || '';
  $('#event_name').value = bet.event_name || active?.name || '';
  $('#fight_name').value = bet.fight_name || '';
  const matchIndex = (active?.fights || []).findIndex(f => f.matchup === bet.fight_name);
  $('#matchup').value = matchIndex >= 0 ? String(matchIndex) : '';
  const book = ['DK','FD'].includes(bet.book) ? bet.book : (bet.book ? 'Other' : 'DK');
  $('#book').value = book; selected('#book-controls','book',book);
  $('#other-book-label').hidden = book !== 'Other'; $('#other-book').value = book === 'Other' ? bet.book : '';
  setType(bet.bet_type || 'Moneyline');
  $('#selection').value = bet.selection || '';
  $('#market').value = bet.market || '';
  $('#round').value = bet.round_label || '';
  $('#american_odds').value = bet.american_odds || '';
  const bonus = Number(bet.bonus_stake) > 0 && Number(bet.cash_stake) === 0;
  $('#bonus-bet').checked = bonus;
  $('#cash_stake').value = bonus ? Number(bet.bonus_stake || 0) : Number(bet.cash_stake || 0);
  $('#notes').value = bet.notes || '';
  const live = form.querySelector('[name="is_live_stream"]'); if (live) live.checked = !!bet.is_live_stream;
  $('#legs').innerHTML = '';
  (bet.legs || []).forEach(leg => addLeg({fight_name:leg.fight_name, selection:leg.selection, american_odds:leg.american_odds}));
  updateSelectionBuilderPressed(); preview();
  $('#save').textContent = duplicate ? 'Save bet' : 'Update bet';
  $('#cancel-edit').hidden = duplicate;
  message((duplicate ? 'Duplicated into ticket · ' : 'Editing loaded · ') + (bet.selection || bet.fight_name));
  form.scrollIntoView({behavior:'smooth', block:'start'});
  $('#american_odds').focus({preventScroll:true});
}
$('#cancel-edit').onclick = () => {
  resetTicketAfterQueue();
  message('Edit cancelled. Ticket cleared.');
};
async function commitQueuedBet(bet, editId) {
  queuedWrites += 1;
  $('#connection').textContent = `● ${queuedWrites} SQLite write${queuedWrites === 1 ? '' : 's'} pending…`;
  try {
    if (!editId) {
      const recent=await api('api/bets');
      if(recent.bets.some(existing=>duplicateKey(existing) === duplicateKey(bet)) && !confirm('Possible duplicate bet found. Save another copy anyway?')) {
        message('Queued save cancelled as a duplicate.'); return;
      }
    }
    const saved = editId
      ? await api('api/bets/' + encodeURIComponent(editId), {method:'PATCH', ...json(bet)})
      : await api('api/bets', {method:'POST', ...json(bet)});
    await api('api/bets/' + encodeURIComponent(saved.id));
    message((editId ? 'Update committed · ' : 'Bet committed · ') + saved.selection);
    await load();
  } catch(error) {
    message((editId ? 'Update' : 'Save') + ' not confirmed: ' + error.message + '. Refresh before retrying to avoid duplicates.', true);
  } finally {
    queuedWrites = Math.max(0, queuedWrites - 1);
    if (!queuedWrites) $('#connection').textContent='● SQLite connected · ' + (active?.name || 'all events');
  }
}
function queueTicketSave(bet) {
  if (!bet.american_odds || bet.cash_stake + bet.bonus_stake <= 0) { message('Enter nonzero American odds and a cash or bonus stake.',true); return; }
  const editId = editingBetId;
  if (editId) bet.status = bets.find(x => x.id === editId)?.status || 'pending';
  commitQueuedBet(bet, editId);
  message((editId ? 'Update queued · ' : 'Save queued · ') + (bet.selection || bet.fight_name));
  resetTicketAfterQueue();
  $('#cash_stake').focus({preventScroll:true});
}
function saveParlay() {
  const bet = payload();
  if (!isParlayTicket() || bet.legs.length < 2 || bet.legs.some(leg => !leg.fight_name || !leg.selection)) {
    message('Add at least two parlay legs with fight and selection before saving.', true); return;
  }
  bet.fight_name = `${bet.legs.length}-leg parlay`;
  bet.selection = 'Parlay';
  bet.market = ''; bet.round_label = '';
  queueTicketSave(bet);
}
$('#save-parlay').onclick = saveParlay;
form.onsubmit = e => {
  e.preventDefault();
  queueTicketSave(payload());
};
async function setStatus(id,status,override) {
  if(busyBets.has(id)) return;
  busyBets.add(id); renderBets();
  try {
    await api('api/bets/' + encodeURIComponent(id),{method:'PATCH',...json({status,...(override === undefined ? {} : {payout:override})})});
    const confirmed=await api('api/bets/' + encodeURIComponent(id));
    bets=bets.map(b=>b.id === id ? confirmed : b); message('Result saved · ' + title(confirmed.status));
    await load();
  } catch(error) { message('Result not confirmed: ' + error.message + '. Refresh to reconcile.',true); }
  finally { busyBets.delete(id); renderBets(); }
}
async function setLegStatus(id,index,status) {
  const key = id + ':leg:' + index;
  if(busyBets.has(key)) return;
  busyBets.add(key); renderBets();
  try {
    await api('api/bets/' + encodeURIComponent(id) + '/legs/' + encodeURIComponent(index),{method:'PATCH',...json({status})});
    const confirmed=await api('api/bets/' + encodeURIComponent(id));
    bets=bets.map(b=>b.id === id ? confirmed : b); message('Leg saved · ' + title(status));
  } catch(error) { message('Leg result not confirmed: ' + error.message + '. Refresh to reconcile.',true); }
  finally { busyBets.delete(key); renderBets(); }
}
function statusButtons(b) {
  return statuses.map(status=>`<button type="button" class="status-btn ${status}" aria-pressed="${b.status === status}" data-id="${esc(b.id)}" data-status="${status}"${busyBets.has(b.id) ? ' disabled' : ''}>${title(status)}</button>`).join('');
}
function legStatusButtons(b,l) {
  const key = b.id + ':leg:' + l.leg_index;
  return statuses.map(status=>`<button type="button" class="status-btn ${status}" aria-pressed="${l.status === status}" data-id="${esc(b.id)}" data-leg-index="${esc(l.leg_index)}" data-leg-status="${status}"${busyBets.has(key) ? ' disabled' : ''}>${title(status)}</button>`).join('');
}
function matchupName(b) {
  return String(b.fight_name || '').trim();
}
function betMatchesMatchup(b, matchup) {
  if (!matchup) return true;
  return matchupName(b) === matchup || (b.legs || []).some(l => String(l.fight_name || '').trim() === matchup);
}
function bookBucket(book) {
  const value = String(book || '').trim();
  return ['FD','DK'].includes(value) ? value : 'Other';
}
function bookButtons(b) {
  const current = bookBucket(b.book);
  const next = current === 'FD' ? 'DK' : current === 'DK' ? 'Other' : 'FD';
  return `<button type="button" class="book-label book-cycle book-${current.toLowerCase()}" data-id="${esc(b.id)}" data-book-set="${next}" aria-label="Sportsbook ${esc(b.book || 'Other')}. Click to change to ${next}" title="Click to change to ${next}"${busyBets.has(b.id + ':book') ? ' disabled' : ''}>${esc(b.book || 'Other')}</button>`;
}
function realizedPnl(b) {
  if (b.status === 'win') return (Number(b.payout) || 0) - (Number(b.cash_stake) || 0);
  if (b.status === 'loss') return -(Number(b.cash_stake) || 0);
  return 0;
}
function actualMatchups() {
  return (active?.fights || []).map(f => f.matchup).filter(Boolean);
}
function updateMatchupFilterOptions() {
  const picker = $('#ledger-matchup');
  const old = matchupFilter;
  const names = actualMatchups();
  picker.innerHTML = '<option value="">All matchups</option>' + names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
  matchupFilter = names.includes(old) ? old : '';
  picker.value = matchupFilter;
}
async function removeBet(id) {
  if(busyBets.has(id) || !confirm('Permanently delete this server-saved bet?')) return;
  busyBets.add(id); renderBets();
  try {
    await api('api/bets/' + encodeURIComponent(id),{method:'DELETE'});
    const response=await fetch('api/bets/' + encodeURIComponent(id),{cache:'no-store'});
    if(response.status !== 404) throw Error('Deletion could not be verified');
    bets=bets.filter(b=>b.id !== id); await load(); message('Bet deleted.');
  } catch(error) { message('Delete not confirmed: ' + error.message,true); }
  finally { busyBets.delete(id); renderBets(); }
}
async function setBook(id,book) {
  const key = id + ':book';
  if(busyBets.has(key)) return;
  const old = bets.find(b=>b.id === id)?.book;
  if (bookBucket(old) === book && (book !== 'Other' || old === 'Other')) return;
  busyBets.add(key); renderBets();
  try {
    await api('api/bets/' + encodeURIComponent(id),{method:'PATCH',...json({book})});
    const confirmed=await api('api/bets/' + encodeURIComponent(id));
    bets=bets.map(b=>b.id === id ? confirmed : b); message('Sportsbook saved · ' + (confirmed.book || 'Other'));
    renderBets();
  } catch(error) { message('Sportsbook not confirmed: ' + error.message + '. Refresh to reconcile.',true); }
  finally { busyBets.delete(key); renderBets(); }
}
function renderBets() {
  const expanded = new Set([...document.querySelectorAll('#bets details[open]')].map(details => details.dataset.betDetails));
  const query=$('#search').value.toLowerCase();
  const list=bets.filter(b=>(!filter || b.status === filter) && (!bookFilter || bookBucket(b.book) === bookFilter) && (!hideParlays || !(b.legs || []).length) && (!$('#event-only').checked || b.event_id === active?.id) && betMatchesMatchup(b, matchupFilter) && [b.fight_name,b.selection,b.book,b.notes,b.event_name,...(b.legs || []).flatMap(l => [l.fight_name,l.selection])].join(' ').toLowerCase().includes(query));
  if (pushSettledBottom) list.sort((a,b)=>Number(a.status !== 'pending') - Number(b.status !== 'pending'));
  const net = list.reduce((sum,b) => sum + realizedPnl(b), 0);
  const pendingExposure = list.filter(b=>b.status === 'pending').reduce((sum,b)=>sum + (Number(b.cash_stake) || 0), 0);
  const settled = list.filter(b=>['win','loss'].includes(b.status)).length;
  $('#ledger-summary').innerHTML=[['Sportsbook',bookFilter || 'All books'],['Matchup',matchupFilter || 'All matchups'],['Ticket type',hideParlays ? 'Singles only' : 'Singles + parlays'],['Bets shown',list.length],['Net profit / loss',money(net)],['Pending cash at risk',money(pendingExposure)],['Settled',settled]].map(([k,v])=>`<div class="stat"><label>${esc(k)}</label><b>${esc(v)}</b></div>`).join('');
  $('#bet-count').textContent=' / ' + list.length;
  $('#bets').innerHTML=list.length ? list.map(b=>`<tr><td><b>${esc(b.selection || b.fight_name)}</b><div class="pick muted">${esc(b.fight_name)}</div><small class="muted">${esc([b.event_name,b.bet_type,b.market,b.round_label].filter(Boolean).join(' · '))}</small>${b.legs.length ? `<details data-bet-details="${esc(b.id)}"${expanded.has(b.id) || busyBets.has(b.id + ':expanded') ? ' open' : ''}><summary>Details${b.legs.length ? ' · '+b.legs.length+' legs' : ''}</summary><p>${esc(b.notes || 'No notes')}${b.is_live_stream ? ' · Live stream' : ''}</p>${b.legs.length ? `<div class="leg-results">${b.legs.map(l=>`<div class="leg-result"><div class="leg-copy"><b class="leg-selection-name">${esc(l.selection || 'Leg ' + (Number(l.leg_index)+1))}</b><span class="leg-matchup-name">${esc(l.fight_name)}${l.american_odds == null ? '' : ' · ' + esc(odds(l.american_odds))}</span></div><span class="tag ${l.status}">${title(l.status)}</span><div class="status-actions">${legStatusButtons(b,l)}</div></div>`).join('')}</div>` : ''}<small>${esc(b.placed_at)}</small>${b.status === 'win' ? `<div class="actual-payout"><label>Actual bookmaker return ($)<input type="number" min="0" step="0.01" value="${b.payout ?? ''}" data-payout="${esc(b.id)}"></label><button type="button" class="secondary" data-correct="${esc(b.id)}"${busyBets.has(b.id) ? ' disabled' : ''}>Save payout</button></div>` : ''}</details>` : ''}</td><td>${bookButtons(b)}</td><td>${money(b.cash_stake)}${b.bonus_stake ? `<small class="muted block">${money(b.bonus_stake)} bonus</small>` : ''}</td><td class="numeric">${esc(odds(b.american_odds))}</td><td><span class="tag ${b.status}">${title(b.status)}</span>${b.payout != null ? `<small class="block">${money(b.payout)} return</small>` : `<small class="muted block">${money(payoutFor(b))} potential</small>`}</td><td><div class="status-actions">${statusButtons(b)}</div><button type="button" class="text-button" data-edit="${esc(b.id)}"${busyBets.has(b.id) ? ' disabled' : ''}>Edit</button><button type="button" class="text-button" data-duplicate="${esc(b.id)}"${busyBets.has(b.id) ? ' disabled' : ''}>Duplicate</button><button type="button" class="text-button delete" data-delete="${esc(b.id)}"${busyBets.has(b.id) ? ' disabled' : ''}>Delete</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">No bets match the current filters.</td></tr>';
}
$('#bets').onclick=e=>{
  const b=e.target.closest('button'); if(!b) return;
  if(b.dataset.bookSet) setBook(b.dataset.id,b.dataset.bookSet);
  if(b.dataset.status) setStatus(b.dataset.id,b.dataset.status);
  if(b.dataset.legStatus) setLegStatus(b.dataset.id,Number(b.dataset.legIndex),b.dataset.legStatus);
  if(b.dataset.edit) loadBetIntoTicket(b.dataset.edit);
  if(b.dataset.duplicate) loadBetIntoTicket(b.dataset.duplicate, {duplicate:true});
  if(b.dataset.delete) removeBet(b.dataset.delete);
  if(b.dataset.correct) {
    const input=[...document.querySelectorAll('[data-payout]')].find(i=>i.dataset.payout === b.dataset.correct);
    if(input.value === '' || !input.checkValidity()) { input.reportValidity(); return; }
    setStatus(b.dataset.correct,'win',Number(input.value));
  }
};
function eventTimelineName(point) {
  const raw=String(point.label || point.event_id || 'Event');
  if (!raw.startsWith('event_')) return raw;
  const dwcs=raw.match(/^event_dana_white_s_contender_series_season_(\d+)_week_(\d+)$/);
  if (dwcs) return `Dana White's Contender Series: Season ${dwcs[1]}, Week ${dwcs[2]}`;
  let name=raw.slice(6).replaceAll('_',' ').replace(/\b\w/g,letter=>letter.toUpperCase());
  name=name.replace(/^Ufc Fight Night /,'UFC Fight Night: ').replace(/^Ufc (\d+) /,'UFC $1: ').replace(/\sVs\s/g,' vs. ').replace(/^Ufc\b/,'UFC');
  return name;
}
function eventTimelineDate(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${date}T12:00:00Z`));
}
function wrapEventAxisLabel(name, maxLength=18) {
  const lines=[]; let line='';
  for (const word of name.split(' ')) {
    if (line && `${line} ${word}`.length > maxLength) { lines.push(line); line=word; }
    else line=line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
function shortTimelineLabel(point, scope) {
  return scope === 'active' ? (point.label || `Matchup ${point.index}`) : eventTimelineName(point);
}
document.addEventListener('click', event => {
  const toggle = event.target.closest && event.target.closest('#parlay-line-toggle');
  if (!toggle) return;
  const on = localStorage.getItem('ufc_v3_parlay_line') !== 'off';
  localStorage.setItem('ufc_v3_parlay_line', on ? 'off' : 'on');
  if (latestTimeline) renderProfitChart(latestTimeline);
});
function renderProfitChart(timeline) {
  const host = $('#profit-chart');
  latestTimeline = timeline;
  const points = timeline?.points || [];
  const scope = timeline?.scope || statsScope;
  const series = scope === 'active' ? timeline?.series : null;
  const parlayPoints = scope === 'active' ? (timeline?.parlay_points || []) : [];
  const parlayVisible = !!(series && series.labels && series.labels.length && localStorage.getItem('ufc_v3_parlay_line') !== 'off');
  const title = scope === 'active' ? 'Live P/L by matchup' : 'P/L across events';
  $('#profit-chart-title').textContent = title;
  $('#profit-chart-note').textContent = scope === 'active'
    ? `${points.length} settled straight-bet matchup${points.length === 1 ? '' : 's'} · dashed line adds parlays split evenly across leg matchups · cumulative realized P/L`
    : (points.length ? `${points.length} settled events · cumulative realized P/L` : 'Settled bets only');
  const toggle = $('#parlay-line-toggle');
  if (toggle) { toggle.hidden = !(scope === 'active' && series && series.labels && series.labels.length); toggle.setAttribute('aria-pressed', String(parlayVisible)); }
  const useSeries = !!(series && series.labels && series.labels.length);
  const axisPoints = useSeries ? series.labels.map(label => ({ label })) : points;
  if (!axisPoints.length) {
    host.innerHTML = '<div class="empty">No settled bets yet.<br>Settle a bet to start the P/L timeline.</div>';
    host.setAttribute('aria-label', title + ': no settled bets yet');
    return;
  }
  const width=Math.max(300, Math.round(host.clientWidth || 760)), height=238, pad={top:18,right:18,bottom:52,left:54};
  const straightVals = useSeries ? series.straight_cumulative.map(Number) : points.map(p=>Number(p.cumulative_profit)||0);
  const parlayVals = useSeries ? series.parlay_cumulative.map(Number) : [];
  const plotted = parlayVisible ? straightVals.concat(parlayVals) : straightVals;
  const min=Math.min(0,...plotted), max=Math.max(0,...plotted);
  const span=max-min || 1, innerW=width-pad.left-pad.right, innerH=height-pad.top-pad.bottom;
  const n=axisPoints.length;
  const x=i=>pad.left+(n===1?innerW/2:(i/(n-1))*innerW);
  const y=v=>pad.top+((max-v)/span)*innerH;
  const baseline=y(0);
  const coords=straightVals.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area=n>1?`${x(0).toFixed(1)},${baseline.toFixed(1)} ${coords} ${x(n-1).toFixed(1)},${baseline.toFixed(1)}`:'';
  const parlayCoords=parlayVals.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const grid=[min,(min+max)/2,max].filter((v,i,a)=>i===0 || Math.abs(v-a[i-1])>.005).map(v=>`<line class="grid" x1="${pad.left}" x2="${width-pad.right}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${pad.left-8}" y="${y(v)+3}" text-anchor="end">${esc(money(v))}</text>`).join('');
  const compactLabels=width < 480;
  const labelIdx=n===1 ? [0] : (compactLabels ? [0,n-1] : [...new Set([0,Math.floor((n-1)/2),n-1])]);
  const xlabels=labelIdx.map(i=>{ const point=axisPoints[i], name=shortTimelineLabel(point,scope), date=scope === 'all' ? eventTimelineDate(point.event_date) : ''; const axisLines=compactLabels ? [...wrapEventAxisLabel(name),...(date ? [date] : [])] : [name,date].filter(Boolean); const anchor=i===0?'start':i===n-1?'end':'middle'; const labelY=height-14-(axisLines.length-1)*13; const tspans=axisLines.map((line,index)=>`<tspan x="${x(i)}" dy="${index ? 13 : 0}">${esc(line)}</tspan>`).join(''); return `<text class="axis-label axis-event-label" data-chart-x-label="true" x="${x(i)}" y="${labelY}" text-anchor="${anchor}">${tspans}</text>`; }).join('');
  const straightByLabel=new Map(points.map(p=>[p.label,p]));
  const parlayByLabel=new Map(parlayPoints.map(p=>[p.label,p]));
  const pointGroups=axisPoints.map((axisPoint,i)=>{
    const name=shortTimelineLabel(axisPoint,scope), subject=scope==='all'?`Event: ${name}${axisPoint.event_date?` (${eventTimelineDate(axisPoint.event_date)})`:''}`:`Matchup: ${name}`;
    let groups='';
    const straightPoint=straightByLabel.get(axisPoint.label);
    if (straightPoint) {
      const detail=`${subject}\nStraight bets P/L: ${money(straightPoint.profit)}\nCumulative straight P/L: ${money(straightPoint.cumulative_profit)}`;
      const aria=`${subject}. Straight-bet profit/loss ${money(straightPoint.profit)}. Cumulative ${money(straightPoint.cumulative_profit)}.`;
      groups+=`<g class="point-group" data-chart-point="true" data-tooltip="${esc(detail)}" tabindex="0" role="button" aria-label="${esc(aria)}"><circle class="point-hit" cx="${x(i)}" cy="${y(straightVals[i])}" r="14"/><circle class="point ${Number(straightPoint.profit)<0?'negative':''}" cx="${x(i)}" cy="${y(straightVals[i])}" r="4"><title>${esc(aria)}</title></circle></g>`;
    }
    if (parlayVisible) {
      const parlayPoint=parlayByLabel.get(axisPoint.label);
      if (parlayPoint) {
        const detail=`${subject}\nParlay share (net split evenly across legs): ${money(parlayPoint.profit)}\nStraight + parlay share: ${money(Number(straightByLabel.get(axisPoint.label)?.profit||0)+Number(parlayPoint.profit))}`;
        const aria=`${subject}. Parlay-attributed profit/loss ${money(parlayPoint.profit)}.`;
        groups+=`<g class="point-group" data-chart-point="true" data-tooltip="${esc(detail)}" tabindex="0" role="button" aria-label="${esc(aria)}"><circle class="point-hit" cx="${x(i)}" cy="${y(parlayVals[i])}" r="14"/><circle class="point point-parlay" cx="${x(i)}" cy="${y(parlayVals[i])}" r="4"><title>${esc(aria)}</title></circle></g>`;
      }
    }
    return groups;
  }).join('');
  const lastStraight=straightVals.length?straightVals[straightVals.length-1]:0;
  const lastParlay=parlayVisible&&parlayVals.length?parlayVals[parlayVals.length-1]:null;
  host.setAttribute('aria-label', `${title}; cumulative realized profit ${money(lastStraight)}${lastParlay===null?'':` (straight) and ${money(lastParlay)} (straight + split parlays)`} across ${n} card slots`);
  host.innerHTML=`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${grid}<line class="zero" x1="${pad.left}" x2="${width-pad.right}" y1="${baseline}" y2="${baseline}"/>${area?`<polygon class="area" points="${area}"/>`:''}<polyline class="line" points="${coords}"/>${parlayVisible&&parlayVals.length?`<polyline class="line line-parlay" points="${parlayCoords}"/>`:''}${pointGroups}${xlabels}</svg><div class="chart-tooltip" role="status" hidden></div>`;
  const tooltip=host.querySelector('.chart-tooltip');
  const hideTooltip=()=>{ tooltip.hidden=true; host.querySelectorAll('.point-group.is-highlighted').forEach(point=>point.classList.remove('is-highlighted')); };
  const showTooltip=(group,event)=>{ if(!group) return; host.querySelectorAll('.point-group.is-highlighted').forEach(point=>point.classList.remove('is-highlighted')); group.classList.add('is-highlighted'); tooltip.textContent=group.dataset.tooltip; tooltip.hidden=false; const hostBox=host.getBoundingClientRect(), pointBox=group.getBoundingClientRect(); const rawX=event?.clientX ? event.clientX-hostBox.left : pointBox.left-hostBox.left+pointBox.width/2; const rawY=event?.clientY ? event.clientY-hostBox.left : pointBox.top-hostBox.top; const xPos=Math.max(118,Math.min(host.clientWidth-118,rawX)); tooltip.style.left=`${xPos}px`; tooltip.style.top=`${Math.max(78,rawY)}px`; };
  host.onmouseleave=hideTooltip;
  host.querySelectorAll('[data-chart-point]').forEach(group=>{
    group.addEventListener('mouseover',event=>showTooltip(group,event));
    group.addEventListener('mousemove',event=>showTooltip(group,event));
    group.addEventListener('focus',()=>showTooltip(group));
    group.addEventListener('blur',hideTooltip);
    group.addEventListener('keydown',event=>{ if(event.key==='Escape') { hideTooltip(); group.blur(); } });
  });
}
function renderAnalytics(scopeStats, timeline) {
  const isActive = statsScope === 'active';
  $('#analytics-title').textContent = isActive ? 'Active event stats' : 'All-event stats';
  $('#analytics-subtitle').textContent = isActive ? 'Live progress as bets settle.' : 'Your complete settled and pending history.';
  selected('#stats-scope-controls','statsScope',statsScope);
  $('#statistics').innerHTML=[['Cash staked',money(scopeStats.cash_staked)],['Bonus staked',money(scopeStats.bonus_staked)],['ROI · all cash incl. pending',scopeStats.roi == null ? '—' : (scopeStats.roi*100).toFixed(1)+'%'],['Win rate · settled',scopeStats.win_rate == null ? '—' : (scopeStats.win_rate*100).toFixed(1)+'%']].map(([k,v])=>`<div class="stat"><label>${k}</label><b>${esc(v)}</b></div>`).join('');
  $('#book-stats').innerHTML=scopeStats.by_book.map(b=>`<span><b>${esc(b.book || 'Other')}</b> ${b.count} bets · ${money(b.cash_staked)} cash</span>`).join('') || '<span class="muted">No bets in this scope yet.</span>';
  renderProfitChart(timeline);
}
async function load() {
  const version=++loadVersion;
  const activeScope = active?.id ? '?event_id=' + encodeURIComponent(active.id) : '';
  const analyticsQuery = statsScope === 'active' ? activeScope : '';
  const [list,scopeDash,scopeBets,scopeStats,timeline]=await Promise.all([
    api('api/bets' + ($('#event-only').checked ? activeScope : '')), api('api/dashboard' + analyticsQuery), api('api/bets' + analyticsQuery),
    api('api/statistics' + analyticsQuery), api('api/profit-timeline' + analyticsQuery)
  ]);
  if(version !== loadVersion) return;
  bets=list.bets;
  updateMatchupFilterOptions();
  const exposure=scopeBets.bets.filter(b=>b.status === 'pending').reduce((sum,b)=>sum+b.cash_stake,0);
  const scopeLabel=statsScope === 'active' ? 'Active' : 'All-event';
  $('#stats').innerHTML=[[scopeLabel+' bets',scopeDash.total_bets],['Pending',`<button type="button" class="stat-link" data-pending-jump="true" title="Show pending bets from all events in the ledger">${scopeDash.pending} · view</button>`],['Cash at risk',money(exposure)],['Win / loss',scopeDash.won+' / '+scopeDash.lost],[scopeLabel+' realized P/L',money(scopeDash.profit)]].map(([k,v])=>`<div class="stat"><label>${k}</label><b>${v}</b></div>`).join('');
  renderAnalytics(scopeStats,timeline);
  window.dispatchEvent(new Event('ufc-bets-loaded'));
  $('#connection').textContent='● SQLite connected · ' + (active?.name || 'all events'); renderBets();
}
$('#status-controls').innerHTML=['',...statuses].map(s=>`<button type="button" data-filter="${s}" aria-pressed="${!s}">${s ? title(s) : 'All'}</button>`).join('');
$('#status-controls').onclick=e=>{ const b=e.target.closest('[data-filter]'); if(b) {filter=b.dataset.filter; selected('#status-controls','filter',filter);renderBets();} };
$('#book-filter-controls').onclick=e=>{ const b=e.target.closest('[data-book-filter]'); if(b) {bookFilter=b.dataset.bookFilter; selected('#book-filter-controls','bookFilter',bookFilter);renderBets();} };
$('#stats-scope-controls').onclick=e=>{ const b=e.target.closest('[data-stats-scope]'); if(!b || b.dataset.statsScope === statsScope) return; statsScope=b.dataset.statsScope; load().catch(error=>message('Statistics refresh failed: '+error.message,true)); };
$('#event-only').checked = true;
$('#event-only').onchange=()=>{ load().catch(error=>message('Ledger refresh failed: '+error.message,true)); };
$('#stats').onclick=e=>{ if(!e.target.closest('[data-pending-jump]')) return; $('#event-only').checked=false; filter='pending'; selected('#status-controls','filter',filter); load().then(()=>{ $('#ledger').scrollIntoView({behavior:'smooth',block:'start'}); }).catch(error=>message('Ledger refresh failed: '+error.message,true)); }; $('#hide-parlays').onchange=e=>{ hideParlays=e.target.checked; renderBets(); }; $('#settled-bottom').onchange=e=>{ pushSettledBottom=e.target.checked; renderBets(); }; $('#search').oninput=renderBets; $('#ledger-matchup').onchange=e=>{ matchupFilter=e.target.value; renderBets(); };
$('#refresh').onclick=async()=>{ $('#refresh').disabled=true; try {await Promise.all([loadEvents(),load()]);message('Refreshed from SQLite.');} catch(error) {message('Refresh failed: '+error.message,true);} finally {$('#refresh').disabled=false;} };
function setupSectionMinimizers() {
  document.querySelectorAll('main > .card, main > .workspace > .card').forEach((card, index) => {
    const heading = card.querySelector(':scope > .section-heading');
    if (!heading || heading.querySelector('[data-minimize-section]')) return;
    const label = heading.querySelector('h2')?.textContent?.trim() || `Section ${index + 1}`;
    const key = `ufc_v3_section_minimized_${card.id || card.className.split(/\s+/)[1] || index}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'section-minimize secondary';
    button.dataset.minimizeSection = key;
    button.setAttribute('aria-label', `Minimize ${label}`);
    const setCollapsed = collapsed => {
      card.classList.toggle('is-collapsed', collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.textContent = collapsed ? 'Expand' : 'Minimize';
      button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Minimize'} ${label}`);
      localStorage.setItem(key, collapsed ? '1' : '0');
    };
    const wasCollapsed = localStorage.getItem(key) === '1';
    button.onclick = () => setCollapsed(!card.classList.contains('is-collapsed'));
    heading.append(button);
    setCollapsed(wasCollapsed);
  });
}
setupSectionMinimizers();
fillRounds();
let chartResizeTimer;
window.addEventListener('resize',()=>{ clearTimeout(chartResizeTimer); chartResizeTimer=setTimeout(()=>{ if(latestTimeline) renderProfitChart(latestTimeline); },120); });
loadEvents().catch(error=>{ $('#connection').textContent='Connection needs attention';message('Could not load: '+error.message+'. Use Refresh to retry.',true); });

// In-app updater: header button appears when origin/main is ahead.
(function(){
  const btn=document.getElementById('update-btn');
  if(!btn) return;
  fetch('api/update/check').then(r=>r.ok?r.json():null).then(info=>{
    if(info&&info.has_updates&&(info.repo?info.behind>0:true)){
      btn.hidden=false;
      btn.textContent='\u2191 Update ('+info.behind+')';
    }
  }).catch(()=>{});
  btn.addEventListener('click',async()=>{
    btn.disabled=true; btn.textContent='Updating\u2026';
    try{
      const res=await fetch('api/update',{method:'POST'});
      const body=await res.json().catch(()=>({}));
      if(!res.ok){ throw new Error(body.detail||('HTTP '+res.status)); }
      btn.textContent='Restarting\u2026';
      await fetch('api/restart',{method:'POST'});
      const deadline=Date.now()+20000;
      while(Date.now()<deadline){
        await new Promise(r=>setTimeout(r,1000));
        try{
          const h=await fetch('healthz',{cache:'no-store'});
          if(h.ok){ location.reload(); return; }
        }catch(err){ /* keep waiting */ }
      }
      message('Updated, but the service did not come back within 20s. Start it again with ./launch.sh or your service unit.',true);
      btn.hidden=true;
    }catch(err){
      message('Update failed: '+err.message,true);
      btn.disabled=false; btn.textContent='\u2191 Update';
    }
  });
})();
