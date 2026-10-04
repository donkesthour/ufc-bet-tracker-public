(()=>{
const $=s=>document.querySelector(s); const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=x=>'$'+Number(x||0).toFixed(2); const odds=x=>Number(x)>0?'+'+x:x; const title=s=>String(s||'').slice(0,1).toUpperCase()+String(s||'').slice(1);
let active=null, guide=null, bets=[], selectedMatchup=''; const busy=new Set();
async function api(path,opt={}){const r=await fetch(path,{...opt,cache:'no-store'}); if(!r.ok){let d=await r.text(); try{d=JSON.parse(d).detail}catch{} throw Error(typeof d==='string'?d:'Request failed')} return r.status===204?null:r.json()}
const json=data=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); function msg(t,e=false){$('#message').textContent=t; $('#message').className=e?'error':'ok'}
function betForMatchup(b,m){return b.fight_name===m||(b.legs||[]).some(l=>l.fight_name===m)}
function payoutFor(b){const cash=Number(b.cash_stake)||0, bonus=Number(b.bonus_stake)||0, price=Number(b.american_odds)||0; return price?cash+(cash+bonus)*(price>0?price/100:100/Math.abs(price)):0}
async function setStatus(id,status){if(busy.has(id))return; busy.add(id); renderActive(); try{await api('/api/bets/'+encodeURIComponent(id),{method:'PATCH',...json({status})}); await load(); msg('Result saved · '+title(status));}catch(e){msg('Result not confirmed: '+e.message,true)} finally{busy.delete(id); renderActive();}}
async function setLegStatus(id,i,status){const k=id+':leg:'+i; if(busy.has(k))return; busy.add(k); renderActive(); try{await api('/api/bets/'+encodeURIComponent(id)+'/legs/'+encodeURIComponent(i),{method:'PATCH',...json({status})}); await load(); msg('Leg saved · '+title(status));}catch(e){msg('Leg not confirmed: '+e.message,true)} finally{busy.delete(k); renderActive();}}
function statusButtons(b){return ['pending','win','loss','void'].map(s=>`<button type="button" class="status-btn ${s}" data-status="${s}" data-id="${esc(b.id)}" aria-pressed="${b.status===s}" ${busy.has(b.id)?'disabled':''}>${title(s)}</button>`).join('')}
function realized(b){const c=Number(b.cash_stake)||0; return b.status==='win'?(Number(b.payout)||0)-c:b.status==='loss'?-c:0}
const nm=x=>String(x||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\bvs\.?\b/g,'vs').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
function matchupPL(m){const k=nm(m); let straight=0,parlay=0,settled=0,pending=0; for(const b of bets){const legs=b.legs||[]; let share=0; if(legs.length){const set=new Set(legs.map(l=>nm(l.fight_name))); if(!set.has(k))continue; share=1/set.size; if(b.status==='pending'){pending++;continue} settled++; parlay+=realized(b)*share} else {if(nm(b.fight_name)!==k)continue; if(b.status==='pending'){pending++;continue} settled++; straight+=realized(b)}} return {straight,parlay,total:straight+parlay,settled,pending}}
const sm=v=>(v<0?'-':v>0?'+':'')+money(Math.abs(v));
function renderSummary(){const real=bets.reduce((t,b)=>t+realized(b),0), w=bets.filter(b=>b.status==='win').length, l=bets.filter(b=>b.status==='loss').length, rows=[['Realized P/L',(real<0?'-':'')+money(Math.abs(real))],['Settled W / L',w+' / '+l],['Projected final P/L',money(real+guide.estimated_all_ticket_net)],['Pending bets',guide.pending_bets],['Cash at risk',money(guide.pending_cash_stake)],['Pending optimized net',money(guide.estimated_scored_net)],['Pending all-ticket net',money(guide.estimated_all_ticket_net)],['Pending wins / losses',`${guide.wins} / ${guide.losses}`],['Lottery excluded',guide.lottery_excluded]]; $('#summary').innerHTML=rows.map(([k,v])=>`<div class="stat"><label>${esc(k)}</label><b>${esc(v)}</b></div>`).join('')}
function renderMatchups(){const current=selectedMatchup||guide.matchups[0]?.matchup||''; selectedMatchup=current; $('#matchups').innerHTML=guide.matchups.map(row=>`<button type="button" class="watch-matchup ${row.matchup===current?'chosen':''}" data-matchup="${esc(row.matchup)}"><span class="fight-num">${String(Number(row.fight_index)+1).padStart(2,'0')}</span><span><b>${esc(row.matchup)}</b>${(()=>{const rr=resFor(row.matchup); const bestRes=()=>{const g=gridData(row.matchup); if(!g||!g.pendingCount) return ''; let top=null,tv=-Infinity; for(const o of g.outs){const c=g.cells[o.key], v=c.split?Math.max(c.total,c.totalE):c.total; if(v>tv+0.004){tv=v;top=o}} return top?'Best Result: '+cellLabel(top,g.f)+' ('+sm(tv)+')':''}; const lead=rr?'Result: '+resLabel(rr):bestRes(); const tail=row.pending_bets?row.pending_bets+' bets · '+money(row.pending_cash)+' risk':''; const t=[lead,tail].filter(Boolean).join(' · '); return t?`<small>${esc(t)}</small>`:''})()}<small class=\"matchup-pl ${matchupPL(row.matchup).total<0?'neg':matchupPL(row.matchup).total>0?'pos':''}\">P/L ${sm(matchupPL(row.matchup).total)}</small></span></button>`).join('')||'<p class="empty">No fights on the active event.</p>'; renderActive();}
function ticketHtml(b){return `<article class="watch-ticket"><div><b>${esc(b.selection||b.fight_name)}</b><small>${esc([b.book,b.bet_type,b.market,b.round_label].filter(Boolean).join(' · '))}</small>${(b.legs||[]).length?`<div class="leg-results">${b.legs.map(l=>`<div class="leg-result"><div class="leg-copy"><b class="leg-selection-name">${esc(l.selection)}</b><span class="leg-matchup-name">${esc(l.fight_name)}</span></div><div class="status-actions">${['pending','win','loss','void'].map(s=>`<button type="button" class="status-btn ${s}" data-id="${esc(b.id)}" data-leg-index="${esc(l.leg_index)}" data-leg-status="${s}" aria-pressed="${l.status===s}" ${busy.has(b.id+':leg:'+l.leg_index)?'disabled':''}>${title(s)}</button>`).join('')}</div></div>`).join('')}</div>`:''}</div><div><span class="tag ${b.status}">${title(b.status)}</span><small>${money(b.cash_stake)} @ ${esc(odds(b.american_odds))} · ${money(payoutFor(b))} potential</small><div class="status-actions">${statusButtons(b)}</div></div></article>`}
function syncTicketMatchup(){const sel=document.querySelector('#matchup'); if(!sel||!active)return; const i=(active.fights||[]).findIndex(f=>f.matchup===selectedMatchup); if(i<0||sel.value===String(i))return; sel.value=String(i); sel.dispatchEvent(new Event('change',{bubbles:true}));}
window.addEventListener('ufc-bets-loaded',()=>{try{syncTicketMatchup()}catch(e){}});

/* ---- Outcome matrix: P/L per fighter x method x round, settled-state aware ---- */
let selectedCell=null, gridParlays=localStorage.getItem('ufc_watch_grid_parlays')!=='0';
const gnorm=x=>String(x||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\//g,' ').replace(/(?<!\d)\.|\.(?!\d)/g,' ').replace(/[^a-z0-9+.\- ]/g,' ').replace(/\s+/g,' ').trim();
function fighterTokens(f){const a=gnorm(f.fighter_a).split(' ').filter(t=>t.length>2), b=gnorm(f.fighter_b).split(' ').filter(t=>t.length>2); return {a:a.filter(t=>!b.includes(t)),b:b.filter(t=>!a.includes(t)),fa:gnorm(f.fighter_a),fb:gnorm(f.fighter_b)}}
/* returns true / false / null (null = cannot be modeled from winner+method+round) */
let timeAssumed=false;
const parseClock=s=>{const m=String(s||'').trim().match(/^(\d):([0-5]\d)$/); if(!m) return null; const v=+m[1]*60+ +m[2]; return v<=300?v:null};
/* Elapsed-time grading. o.clock = seconds into the finishing round (null = unknown). When the line falls inside the finishing round and no time is known, assume the finish came at the end of the round and flag timeAssumed. */
function timeCmp(o,maxR,thr,dir){
  let lo,hi; if(o.method==='dec'){lo=hi=maxR*5}else{lo=(o.round-1)*5; hi=o.round*5; if(o.clock!=null) lo=hi=lo+o.clock/60}
  if(lo===hi){ if(Math.abs(lo-thr)<1e-9) return null; return dir==='over'?lo>thr:lo<thr }
  if(thr<=lo) return dir==='over'; if(thr>=hi) return dir==='under';
  timeAssumed=true; return dir==='over' }
function evalLeg(selection,market,f,o,maxR){
  let t=gnorm(selection+' '+market); const ft=fighterTokens(f);
  const tot=t.match(/\b(over|under)\s*(\d+(?:\.\d)?)/);
  if(/second|takedown|knockdown|significant|strike|last 10|first 60|\bpoints? spread\b/.test(t)||/minute/.test(t)&&!tot||/[+-]\d+\.5\b/.test(t)&&!/round/.test(t)) return null;
  const dec=o.method==='dec';
  if(tot&&/\bminutes?\b/.test(t)){
    const tr=timeCmp(o,maxR,parseFloat(tot[2]),tot[1]); if(tr===null) return null;
    const left=t.replace(tot[0],' ').replace(/\b(total )?minutes?\b/g,' ');
    const ko=/\b(t?ko|knockout)\b/.test(left), sub=/\bsubmission\b|\bsub\b/.test(left), de=/\bdecision\b/.test(left);
    if(!(ko||sub||de)) return tr;
    if(!((ko&&o.method==='ko')||(sub&&o.method==='sub')||(de&&dec))){ timeAssumed=false; return false }
    return tr }
  if(tot&&/round/.test(t)) return timeCmp(o,maxR,parseFloat(tot[2])*5,tot[1]);
  if(/go the distance|goes the distance|go distance/.test(t)){const sel=gnorm(selection), mk=gnorm(market); const yes=/\byes\b/.test(sel)||(!/\bno\b/.test(sel)&&/\byes\b/.test(mk)); const no=/\bno\b/.test(sel)||(!/\byes\b/.test(sel)&&/\bno\b/.test(mk)); if(yes===no) return null; return yes?dec:!dec}
  let named=null; for(const [side,full,toks] of [['a',ft.fa,ft.a],['b',ft.fb,ft.b]]){ if(t.includes(full)||toks.some(k=>new RegExp('\\b'+k+'\\b').test(t))){ if(named&&named!==side) named='both'; else if(!named) named=side } }
  let rest=t.replace(new RegExp([ft.fa,ft.fb,...ft.a,...ft.b].filter(Boolean).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g'),' ');
  const ko=/\b(t?ko|knockout)\b/.test(rest), sub=/\bsubmission\b|\bsub\b/.test(rest), de=/\bdecision\b|\bpoints\b/.test(rest);
  const rm=rest.match(/\bround\s*(\d)\b/); const rnd=rm?parseInt(rm[1]):null;
  if(!named&&!ko&&!sub&&!de&&!rnd) return null;
  if(/double chance|method of victory/.test(gnorm(market))&&named&&!ko&&!sub&&!de&&!rnd) return null;
  if(named==='both') return null;
  if(named&&named!==o.side) return false;
  if(ko||sub||de){ const ok=(ko&&o.method==='ko')||(sub&&o.method==='sub')||(de&&dec); if(!ok) return false }
  if(rnd){ if(dec||o.round!==rnd) return false }
  return true;
}
function gridFight(m){return (active?.fights||[]).find(x=>nm(x.matchup)===nm(m))}
function ticketProfit(b){return payoutFor(b)-(Number(b.cash_stake)||0)}
function gridData(m){
  const f=gridFight(m); if(!f) return null; const fights=active.fights||[]; const sched=Number(f.rounds)||(Number(f.championship)||f===fights[fights.length-1]?5:3); const maxR=Math.min(sched,3); const k=nm(m);
  const outs=[]; for(const side of ['a','b']){ for(const method of ['ko','sub']) for(let r=1;r<=maxR;r++) outs.push({side,method,round:r,key:side+'|'+method+'|'+r}); outs.push({side,method:'dec',round:null,key:side+'|dec'}) }
  {const rs=resFor(m); if(rs&&rs.method!=='dec'){const ck=parseClock(rs.clock); for(const o of outs) if(resKey(rs)===o.key) o.clock=ck}}
  const pend=[], unmodeled=[]; let base=0;
  for(const b of bets){ const legs=b.legs||[]; const mine=legs.length?legs.filter(l=>nm(l.fight_name)===k):(nm(b.fight_name)===k?[b]:[]); if(!mine.length) continue;
    if(b.status==='void') continue;
    const isParlay=legs.length>0, share=isParlay?1/new Set(legs.map(l=>nm(l.fight_name))).size:1;
    pend.push({b,mine,isParlay,share}) }
  const cells={}; for(const o of outs) cells[o.key]={o,total:0,totalE:0,delta:0,deltaE:0,split:false,items:[]};
  for(const p of pend){ const asm=[]; const grade=(o,oi)=>{timeAssumed=false; let all=true; for(const l of p.mine){const r=evalLeg(l.selection||'',l.market||'',f,o,sched); if(r===null) return null; if(!r) all=false} if(oi!=null) asm[oi]=timeAssumed; return all};
    const res=outs.map((o,oi)=>grade(o,oi)); const resE=outs.map((o,oi)=>(o.method==='dec'||o.clock!=null)?res[oi]:grade({...o,clock:1}));
    if(res.some(r=>r===null)||resE.some(r=>r===null)){ if(p.b.status==='pending') unmodeled.push(p.b); else base+=realized(p.b)*p.share; continue }
    if(p.isParlay&&!gridParlays) continue;
    outs.forEach((o,i)=>{const hit=res[i]; const pv=h=>h?ticketProfit(p.b)*p.share:-(Number(p.b.cash_stake)||0)*p.share; const v=pv(hit), vE=pv(resE[i]); cells[o.key].delta+=v; cells[o.key].deltaE+=vE; if(hit!==resE[i]) cells[o.key].split=true; cells[o.key].items.push({b:p.b,v,hit,isParlay:p.isParlay,share:p.share,assumed:asm[i],hitE:resE[i],vE,diff:hit!==resE[i]})}) }
  for(const o of outs){const c=cells[o.key]; c.total=base+c.delta; c.totalE=base+c.deltaE; if(Math.abs(c.total-c.totalE)<0.005) c.split=false}
  return {f,maxR,sched,cells,outs,base,unmodeled,pendingCount:pend.length};
}
function cellLabel(o,f){return (o.side==='a'?f.fighter_a:f.fighter_b)+' by '+(o.method==='ko'?'KO/TKO':o.method==='sub'?'Submission':'Decision')+(o.round?' · Round '+o.round:'')}
function gridHtml(m){
  const g=gridData(m); if(!g) return '';
  const vals=g.outs.flatMap(o=>{const c=g.cells[o.key]; return c.split?[c.total,c.totalE]:[c.total]}), max=Math.max(...vals), min=Math.min(...vals);
  const tone=x=>x>0.004?'rgba(52,199,120,.30)':x<-0.004?'rgba(255,99,99,.30)':'transparent';
  const cell=o=>{const c=g.cells[o.key], v=c.total, hits=c.items.filter(i=>i.hit).length; if(c.split) return `<button type="button" class="og-cell split ${c.totalE===max||v===max?'best':''} ${selectedCell===o.key?'sel':''} ${resKey(resFor(m)||{})===o.key?'actual':''}" style="background:linear-gradient(135deg,${tone(c.totalE)} 0 49%,#0000 49% 51%,${tone(v)} 51% 100%)" data-cell="${o.key}" title="${esc(cellLabel(o,g.f))}. Top-left: if it ends early in the round. Bottom-right: if it ends late."><b class="og-e ${c.totalE<-0.004?'neg':c.totalE>0.004?'pos':''}">${sm(c.totalE)}</b><b class="og-l ${v<-0.004?'neg':v>0.004?'pos':''}">${sm(v)}</b>${resKey(resFor(m)||{})===o.key?'<small class="og-act">ACTUAL</small>':''}</button>`; return `<button type="button" class="og-cell ${v>0.004?'pos':v<-0.004?'neg':''} ${v===max&&max!==min?'best':''} ${v===min&&max!==min?'worst':''} ${selectedCell===o.key?'sel':''} ${resKey(resFor(m)||{})===o.key?'actual':''}" data-cell="${o.key}" title="${esc(cellLabel(o,g.f))}"><b>${sm(v)}</b><small>${resKey(resFor(m)||{})===o.key?'ACTUAL · ':''}${hits}/${c.items.length} hit</small></button>`};
  const rounds=Array.from({length:g.maxR},(_,i)=>i+1);
  const row=(side,method,first)=>{const name=side==='a'?g.f.fighter_a:g.f.fighter_b; const o0={side,method:'dec',round:null,key:side+'|dec'};
    return `<tr>${first?`<th rowspan="2" class="og-fighter">${esc(name)}</th>`:''}<th class="og-method">${method==='ko'?'KO/TKO':'Sub'}</th>${rounds.map(r=>'<td>'+cell({side,method,round:r,key:side+'|'+method+'|'+r})+'</td>').join('')}${first?`<td rowspan="2">${cell(o0)}</td>`:''}</tr>`};
  const sel=selectedCell&&g.cells[selectedCell];
  const detail=sel?`<div class="og-detail"><b>${esc(cellLabel(sel.o,g.f))}</b> → matchup P/L <b class="${sel.total<0?'neg':sel.total>0?'pos':''}">${sm(sel.total)}</b><small>Tickets graded against this result ${sel.split?'(early '+sm(sel.deltaE)+' / late '+sm(sel.delta)+')':sm(sel.delta)} + fixed (unmodeled settled tickets) ${sm(g.base)}</small>${sel.items.length?sel.items.sort((a,b)=>(b.diff-a.diff)||(b.v-a.v)).map((i,ix,arr)=>`${i.diff&&ix===0?'<p class="og-sub">Depends on when it ends (early vs late)</p>':''}${!i.diff&&(ix===0||arr[ix-1].diff)&&arr.some(z=>z.diff)?'<p class="og-sub">Same either way</p>':''}<div class="og-line ${i.hit?'pos':'neg'} ${i.diff?'timed':''}"><span>${i.diff?(i.hitE?'✓':'✗')+' early / '+(i.hit?'✓':'✗')+' late':i.hit?'✓':'✗'} ${esc(i.b.selection&&i.b.selection!=='Parlay'?i.b.selection:(i.b.legs||[]).filter(l=>nm(l.fight_name)===nm(m)).map(l=>l.selection).join(' + '))}${i.isParlay?` <em>parlay ${money(i.b.cash_stake)} @ ${esc(odds(i.b.american_odds))}, ${i.share<1?'1/'+Math.round(1/i.share)+' share':'all legs here'}</em>`:` <em>${money(i.b.cash_stake)} @ ${esc(odds(i.b.american_odds))}</em>`}</span><b>${i.diff?`<span class="${i.vE<0?'neg':'pos'}">${sm(i.vE)}</span> / <span class="${i.v<0?'neg':'pos'}">${sm(i.v)}</span>`:sm(i.v)}</b></div>`).join(''):'<small>No modeled pending tickets.</small>'}</div>`:'<p class="hint og-hint">Tap a cell to see which tickets hit or miss.</p>';
  return `<div class="outcome-grid-card"><div class="og-head"><div><p class="eyebrow">OUTCOME MATRIX</p><small>Matchup P/L if that result is final, once everything settles</small></div><label class="check og-toggle"><input type="checkbox" id="og-parlays" ${gridParlays?'checked':''}> Include parlay shares</label></div><table class="outcome-grid"><thead><tr><th colspan="2"></th>${rounds.map(r=>`<th>R${r}</th>`).join('')}<th>Dec</th></tr></thead><tbody>${row('a','ko',true)}${row('a','sub',false)}${row('b','ko',true)}${row('b','sub',false)}</tbody></table>${detail}<p class="hint og-hint">Every ticket on this fight (settled or pending) is re-graded against each result; settled tickets the grid can't model stay at their real result (${sm(g.base)}). ${g.pendingCount} ticket${g.pendingCount===1?'':'s'} touch it${g.unmodeled.length?` · ${g.unmodeled.length} not modeled (time/takedown/specials/spreads)`:''}. ${g.sched>3?`Scheduled for ${g.sched} rounds; R4/R5 finishes not shown. `:''}Parlays: other legs assumed to hit, P/L split evenly across fights.</p></div>`;
}

/* ---- Fight results (ESPN-synced or manual) + disputes. Display/what-if only: nothing here ever writes a bet status. ---- */
let resData={results:[],disputes:[]}, draft={};
const resFor=m=>resData.results.find(r=>nm(r.matchup)===nm(m));
const resLabel=r=>r.winner+' by '+(r.method==='ko'?'KO/TKO':r.method==='sub'?'Submission':'Decision')+(r.round?' · Round '+r.round+(r.clock?' @ '+r.clock:''):'');
const resKey=r=>r.winner_side?r.winner_side+'|'+(r.method==='dec'?'dec':r.method+'|'+r.round):null;
function detectConflicts(){
  const out=[]; for(const r of resData.results){ const f=gridFight(r.matchup); if(!f||!r.winner_side) continue; const fights=active.fights||[]; const sched=Number(f.rounds)||(Number(f.championship)||f===fights[fights.length-1]?5:3); const o={side:r.winner_side,method:r.method,round:r.round,clock:parseClock(r.clock)}; const k=nm(r.matchup); const sig=r.winner_side+r.method+(r.round||'');
    const chk=(id,li,sel,mkt,status,desc)=>{ if(status!=='win'&&status!=='loss') return; timeAssumed=false; const g=evalLeg(sel||'',mkt||'',f,o,sched); if(g===null||timeAssumed) return; const expect=g?'win':'loss'; if(expect!==status) out.push({dkey:`bet:${id}:${li}:${sig}`,fight_key:r.fight_key,detail:{bet_id:id,leg_index:li,selection:desc,recorded_status:status,result_implies:expect,result:resLabel(r),matchup:r.matchup}})};
    for(const b of bets){ const legs=b.legs||[]; if(legs.length){ legs.forEach(l=>{ if(nm(l.fight_name)===k) chk(b.id,l.leg_index,l.selection,l.market,l.status,l.selection+' (parlay leg)') }) } else if(nm(b.fight_name)===k) chk(b.id,-1,b.selection,b.market,b.status,b.selection) } }
  return out }
async function refreshResults(){
  resData=await api('/api/events/'+encodeURIComponent(active.id)+'/results');
  const known=new Set(resData.disputes.map(x=>x.dkey)); const fresh=detectConflicts().filter(c=>!known.has(c.dkey));
  if(fresh.length) resData=await api('/api/events/'+encodeURIComponent(active.id)+'/results/conflicts',{method:'POST',...json({conflicts:fresh})}) }
/* Time-based lines (rounds/minutes) on this fight's bets that fall inside the finishing round -> manual Over/Under picker -> finish-time proxy. */
function fightTimeLines(m,rnd){
  const lo=(rnd-1)*5, hi=rnd*5, k=nm(m), seen=new Map();
  for(const b of bets){ if(b.status==='void') continue; const legs=b.legs||[]; const mine=legs.length?legs.filter(l=>nm(l.fight_name)===k):(nm(b.fight_name)===k?[b]:[]);
    for(const l of mine){ const t=gnorm((l.selection||'')+' '+(l.market||'')); const x=t.match(/\b(over|under)\s*(\d+(?:\.\d)?)/); if(!x||/takedown|knockdown|strike|second/.test(t)) continue;
      let thr=null,label=''; if(/\bminutes?\b/.test(t)){thr=parseFloat(x[2]);label=x[2]+' minutes'} else if(/round/.test(t)){thr=parseFloat(x[2])*5;label=x[2]+' rounds'} if(thr===null) continue;
      seen.set(thr,{thr,label,at:Math.round((thr-lo)*60),forced:thr<=lo?'over':thr>=hi?'under':null}) } }
  const f=gridFight(m), fights=active.fights||[], sched=f?(Number(f.rounds)||(Number(f.championship)||f===fights[fights.length-1]?5:3)):3;
  for(let r=1;r<sched;r++){const thr=r*5-2.5; if(!seen.has(thr)) seen.set(thr,{thr,label:(thr/5)+' rounds',at:Math.round((thr-lo)*60),forced:thr<=lo?'over':thr>=hi?'under':null})}
  return [...seen.values()].filter(ln=>ln.thr<sched*5).sort((a,b)=>a.thr-b.thr) }
function linesToClock(lines,dr){ // seconds into the finishing round; 'x' = contradictory picks
  let L=0,U=300; for(const ln of lines){if(ln.forced) continue; const s=dr.lines&&dr.lines[ln.thr]; if(s==='over') L=Math.max(L,ln.at); else if(s==='under') U=Math.min(U,ln.at)}
  if(L>=U) return 'x'; const c=Math.floor((L+U)/2); return Math.floor(c/60)+':'+String(c%60).padStart(2,'0') }
function lineState(ln,dr){ if(ln.forced) return ln.forced; if(dr.lines&&dr.lines[ln.thr]) return dr.lines[ln.thr]; const c=parseClock(dr.clock); return c==null?null:(c<ln.at?'under':c>ln.at?'over':null) }
const draftReady=dr=>!!(dr.side&&dr.method&&(dr.method==='dec'||dr.round)&&(dr.method==='dec'||!dr.clock||parseClock(dr.clock)!=null));
function resultPanelHtml(m){
  const r=resFor(m), f=gridFight(m); if(!f) return ''; const fights=active.fights||[]; const sched=Number(f.rounds)||(Number(f.championship)||f===fights[fights.length-1]?5:3);
  const dr=draft[nm(m)]||(draft[nm(m)]=r?{side:r.winner_side,method:r.method,round:r.round,clock:r.clock||''}:{side:null,method:null,round:null,clock:''});
  const btn=(attr,val,label,on)=>`<button type="button" class="secondary res-btn" ${attr}="${val}" aria-pressed="${on}">${esc(label)}</button>`;
  const ready=draftReady(dr);
  const tl=dr.method&&dr.method!=='dec'&&dr.round?fightTimeLines(m,dr.round):[];
  const linesRow=tl.length?`<div class="res-row"><span>O/U <em class="hint">(optional)</em></span>${tl.map(ln=>{const s=lineState(ln,dr); const b=(d,l)=>`<button type="button" class="secondary res-btn" data-res-line="${ln.thr}" data-res-dir="${d}" ${ln.forced?'disabled':''} aria-pressed="${s===d}">${l}</button>`; return `<span class="res-ou"><small>${esc(ln.label.replace(' rounds',' rd').replace(' minutes',' min'))}</small>${b('under','Under')}${b('over','Over')}</span>`}).join('')}${dr.clock==='x'?'<small class="hint neg">Picks contradict.</small>':''}</div>`:'';
  const open=resData.disputes.filter(x=>x.status==='open'&&x.kind==='result'&&x.fight_key===r?.fight_key);
  return `<div class="result-card"><div class="og-head"><div><p class="eyebrow">ACTUAL RESULT</p><b>${r?esc(resLabel(r)):'Not declared yet'}</b>${r?`<small> · ${r.source==='espn'?'ESPN':'manual'}${r.clock?' · '+esc(r.clock):''}</small>`:''}</div></div>
  <div class="res-row"><span>Winner</span>${btn('data-res-side','a',f.fighter_a,dr.side==='a')}${btn('data-res-side','b',f.fighter_b,dr.side==='b')}</div>
  <div class="res-row"><span>Method</span>${[['ko','KO/TKO'],['sub','Sub'],['dec','Decision']].map(([v,l])=>btn('data-res-method',v,l,dr.method===v)).join('')}</div>
  <div class="res-row"><span>Round</span>${Array.from({length:sched},(_,i)=>btn('data-res-round',i+1,'R'+(i+1),dr.round===i+1&&dr.method!=='dec').replace('<button ',dr.method==='dec'?'<button disabled ':'<button ')).join('')}${dr.method==='dec'?'<small class="hint">n/a for a decision</small>':''}</div>
  ${linesRow}<div class="res-row res-actions"><button type="button" class="primary" data-res-save ${ready?'':'disabled'}>${r?'Update result':'Save result'}</button>${r?'<button type="button" class="text-button" data-res-clear>Clear result</button>':''}</div>
  <p class="hint og-hint">Results only drive the matrix highlight and conflict checks. They never change a bet's win/loss status.</p>${open.length?'<p class="hint og-hint neg">ESPN disagrees with this result - see Disputes below.</p>':''}</div>`}
function disputesHtml(){
  const open=resData.disputes.filter(x=>x.status==='open'); if(!open.length) return '';
  return `<div class="dispute-card"><p class="eyebrow">DISPUTES (${open.length})</p>${open.map(x=>{const dt=x.detail||{}; if(x.kind==='result'){const c=dt.current||{},p=dt.proposed||{}; const L=v=>`${v.winner} by ${v.method==='ko'?'KO/TKO':v.method==='sub'?'Submission':'Decision'}${v.round?' R'+v.round:''}`; return `<div class="dispute"><b>${esc(dt.fighter_a)} vs. ${esc(dt.fighter_b)}</b><small>Current (${esc(c.source)}): ${esc(L(c))}</small><small>ESPN now says: ${esc(L(p))}</small><div class="res-row"><button type="button" class="secondary" data-dispute="${x.id}" data-resolution="keep">Keep current</button><button type="button" class="primary" data-dispute="${x.id}" data-resolution="accept">Accept ESPN</button></div></div>`}
    return `<div class="dispute"><b>${esc(dt.selection)}</b><small>${esc(dt.matchup)} · recorded <b>${esc(dt.recorded_status)}</b> but the result (${esc(dt.result)}) implies <b>${esc(dt.result_implies)}</b></small><small>Bet status is untouched. Check the sportsbook, or fix the result above if it is wrong.</small><div class="res-row"><button type="button" class="secondary" data-dispute="${x.id}" data-resolution="keep">Bet is right - keep</button><button type="button" class="text-button" data-dispute="${x.id}" data-resolution="dismiss">Dismiss</button></div></div>`}).join('')}</div>`}

function renderActive(){const row=guide?.matchups?.find(r=>r.matchup===selectedMatchup); $('#active-matchup-title').textContent=row?.matchup||'Select a matchup'; {const rr=resFor(selectedMatchup); $('#active-best').textContent=rr?'Result: '+resLabel(rr):(row&&row.pending_bets?(row.best_outcome?.label||'No lean'):'No result yet')} syncTicketMatchup(); const list=bets.filter(b=>betForMatchup(b,selectedMatchup)); const pl=matchupPL(selectedMatchup); const plHtml=row?`<div class=\"matchup-pl-card\"><div class=\"stat\"><label>Matchup P/L</label><b class=\"${pl.total<0?'neg':pl.total>0?'pos':''}\">${sm(pl.total)}</b></div><div class=\"stat\"><label>Straight bets</label><b>${sm(pl.straight)}</b></div><div class=\"stat\"><label>Parlay share (split evenly)</label><b>${sm(pl.parlay)}</b></div><div class=\"stat\"><label>Settled / pending</label><b>${pl.settled} / ${pl.pending}</b></div></div>`:''; $('#active-bets').innerHTML=disputesHtml()+(row?resultPanelHtml(selectedMatchup):'')+(row?gridHtml(selectedMatchup):'')+plHtml+(list.length?list.map(ticketHtml).join(''):'<p class="empty">No tickets tied to this matchup yet.</p>');}
function renderBigTickets(){const tickets=guide.largest_winning_tickets||[]; $('#big-tickets').innerHTML=tickets.length?tickets.map(t=>`<article class="watch-ticket"><div><b>+${money(t.profit).slice(1)} · ${esc(t.selection)}</b><small>${esc(t.fight_name)} · ${money(t.cash_stake)} @ ${esc(odds(t.american_odds))}${t.is_lottery?' · lottery':''}</small></div></article>`).join(''):'<p class="empty">No optimized winning tickets yet.</p>'}
async function loadEventPicker(){const r=await api('/api/events'); const evs=Array.isArray(r)?r:(r.events||[]); const s=$('#watch-event-select'); s.innerHTML=evs.map(e=>`<option value="${esc(e.id)}">${esc(e.event_date||'TBD')} · ${esc(e.name)}</option>`).join(''); s.value=active?.id||''; s.disabled=!evs.length;}
async function load(){const [event,g,list]=await Promise.all([api('/api/events/active'),api('/api/watch-guide'),api('/api/bets')]); active=event; guide=g; bets=list.bets.filter(b=>b.event_id===event.id); $('#event-title').textContent=event.name; $('#event-meta').textContent=`${event.event_date||'Date TBD'} · ${(event.fights||[]).length} fights · ticket-math optimization`; $('#connection').textContent='● Live from SQLite · '+new Date().toLocaleTimeString(); try{await refreshResults()}catch(e){msg('Results unavailable: '+e.message,true)} renderSummary(); renderMatchups(); renderBigTickets(); if(!$('#watch-event-select').options.length) await loadEventPicker(); $('#watch-event-select').value=event.id;}
$('#matchups').onclick=e=>{const b=e.target.closest('[data-matchup]'); if(!b)return; selectedMatchup=b.dataset.matchup; selectedCell=null; renderMatchups();}; $('#active-bets').onchange=e=>{if(e.target.id==='og-parlays'){gridParlays=e.target.checked; localStorage.setItem('ufc_watch_grid_parlays',gridParlays?'1':'0'); renderActive()}}; $('#active-bets').onclick=async e=>{const T=e.target; const dk=draft[nm(selectedMatchup)];
 const x=T.closest('[data-res-side],[data-res-method],[data-res-round],[data-res-line],[data-res-save],[data-res-clear],[data-dispute]'); if(x){
  if(x.dataset.resSide){dk.side=x.dataset.resSide;return renderActive()} if(x.dataset.resMethod){dk.method=x.dataset.resMethod; dk.lines={}; dk.clock=''; if(dk.method==='dec'){dk.round=null} return renderActive()} if(x.dataset.resRound){dk.round=Number(x.dataset.resRound); dk.lines={}; dk.clock=''; return renderActive()} if(x.dataset.resLine){const tl=fightTimeLines(selectedMatchup,dk.round); dk.lines=dk.lines||{}; const t=x.dataset.resLine; if(!Object.keys(dk.lines).length) for(const ln of tl){if(ln.forced) continue; const s=lineState(ln,dk); if(s) dk.lines[ln.thr]=s} dk.lines[t]=dk.lines[t]===x.dataset.resDir?undefined:x.dataset.resDir; if(!dk.lines[t]) delete dk.lines[t]; dk.clock=Object.keys(dk.lines).length?linesToClock(tl,dk):''; return renderActive()}
  const i=(active.fights||[]).findIndex(f=>nm(f.matchup)===nm(selectedMatchup));
  try{ if('resSave' in x.dataset){resData=await api(`/api/events/${encodeURIComponent(active.id)}/results/${i}`,{method:'PUT',...json({winner_side:dk.side,method:dk.method,round:dk.method==='dec'?null:dk.round,clock:dk.method==='dec'?'':(dk.clock||'')})}); delete draft[nm(selectedMatchup)]; await refreshResults(); msg('Result saved (bets untouched).')}
   else if('resClear' in x.dataset){resData=await api(`/api/events/${encodeURIComponent(active.id)}/results/${i}`,{method:'DELETE'}); delete draft[nm(selectedMatchup)]; msg('Result cleared.')}
   else if(x.dataset.dispute){resData=await api(`/api/disputes/${x.dataset.dispute}/resolve`,{method:'POST',...json({resolution:x.dataset.resolution})}); delete draft[nm(selectedMatchup)]; msg('Dispute resolved.')}
   renderMatchups()}catch(err){msg('Not saved: '+err.message,true)} return}
 const c=e.target.closest('[data-cell]'); if(c){selectedCell=selectedCell===c.dataset.cell?null:c.dataset.cell; if(selectedCell){const [s,m,r]=selectedCell.split('|'); const cr=resFor(selectedMatchup); draft[nm(selectedMatchup)]={side:s,method:m,round:m==='dec'?null:Number(r),clock:cr&&resKey(cr)===selectedCell&&m!=='dec'?cr.clock||'':''}} return renderActive()} const l=e.target.closest('[data-leg-status]'); if(l)return setLegStatus(l.dataset.id,l.dataset.legIndex,l.dataset.legStatus); const b=e.target.closest('[data-status]'); if(b)setStatus(b.dataset.id,b.dataset.status)};
$('#active-bets').addEventListener('input',e=>{const t=e.target.closest('.res-time'); if(!t) return; const dk=draft[nm(selectedMatchup)]; if(!dk) return; dk.clock=t.value.trim(); t.classList.toggle('bad',!!dk.clock&&parseClock(dk.clock)==null); const s=$('#active-bets [data-res-save]'); if(s) s.disabled=!draftReady(dk)});
$('#sync-results').onclick=async()=>{const b=$('#sync-results'); b.disabled=true; try{const r=await api('/api/events/'+encodeURIComponent(active.id)+'/results/sync',{method:'POST'}); resData={results:r.results,disputes:r.disputes}; await refreshResults(); draft={}; renderMatchups(); msg(`ESPN results: ${r.created} new, ${r.filled||0} finish times filled, ${r.unchanged} unchanged, ${r.disputed} disputed.`)}catch(e){msg('ESPN sync failed: '+e.message,true)} finally{b.disabled=false}};
$('#refresh').onclick=()=>Promise.all([loadEvents(),load()]).then(()=>msg('Refreshed and recalculated.')).catch(e=>msg('Refresh failed: '+e.message,true));
load().catch(e=>{ $('#connection').textContent='Connection needs attention'; msg('Could not load watch guide: '+e.message,true); });

$('#watch-event-select').onchange=async e=>{const s=e.target; s.disabled=true; try{await api('/api/events/active/'+encodeURIComponent(s.value),{method:'PUT'}); selectedMatchup=''; await loadEvents(); await load(); msg('Active event switched.');}catch(err){msg('Switch failed: '+err.message,true); await load();} finally{s.disabled=false}};

})();
