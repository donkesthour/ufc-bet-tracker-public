(function(){
const KEY='ufc_v3_dashboard_layout';
const SECTIONS=[
 {id:'poster',label:'Event poster',sel:'#event-poster',top:true},
 {id:'analytics',label:'Performance',sel:'#analytics',top:true},
 {id:'card',label:'Fight card',sel:'section.event-strip',top:true},
 {id:'workspace',label:'Ticket + ledger area',sel:'#workspace',top:true},
 {id:'ticket',label:'  Log bet ticket',sel:'.entry-panel'},
 {id:'ledger',label:'  Bet ledger',sel:'#ledger'}
];
const main=document.querySelector('main'); if(!main) return;
const el=s=>document.querySelector(s.sel);
let st; try{st=JSON.parse(localStorage.getItem(KEY))}catch(e){}
st=st||{}; st.order=(st.order||[]).filter(id=>SECTIONS.some(s=>s.id===id&&s.top));
SECTIONS.filter(s=>s.top&&!st.order.includes(s.id)).forEach(s=>st.order.push(s.id));
st.hidden=st.hidden||[];
const save=()=>{let cur={};try{cur=JSON.parse(localStorage.getItem(KEY))||{}}catch(e){}cur.order=st.order;cur.hidden=st.hidden;localStorage.setItem(KEY,JSON.stringify(cur))};
function apply(){
  const anchor=document.querySelector('#customize-panel');
  st.order.forEach(id=>{const e=el(SECTIONS.find(s=>s.id===id)); if(e) main.appendChild(e);});
  SECTIONS.forEach(s=>{const e=el(s); if(e) e.classList.toggle('dash-hidden',st.hidden.includes(s.id));});
  const w=el(SECTIONS[3]); if(w){const t=el(SECTIONS[4]),l=el(SECTIONS[5]); const both=(t&&t.classList.contains('dash-hidden'))!==(l&&l.classList.contains('dash-hidden')); w.classList.toggle('dash-single',both);}
  render();
}
const panel=document.getElementById('customize-panel');
function render(){
  panel.innerHTML='<div class="cz-head"><b>Customize dashboard</b><button type="button" class="text-button" id="cz-done">Done</button></div>'+
   SECTIONS.map(s=>{const i=st.order.indexOf(s.id);
    return `<div class="cz-row"><label class="check"><input type="checkbox" data-cz-vis="${s.id}"${st.hidden.includes(s.id)?'':' checked'}> <span>${s.label.trim()}${s.top?'':' (sub-section)'}</span></label>`+
    (s.top?`<span class="cz-move"><button type="button" class="secondary" data-cz-move="${s.id}" data-dir="-1"${i===0?' disabled':''} aria-label="Move up">↑</button><button type="button" class="secondary" data-cz-move="${s.id}" data-dir="1"${i===st.order.length-1?' disabled':''} aria-label="Move down">↓</button></span>`:'')+'</div>';}).join('')+
   (()=>{let c={};try{c=JSON.parse(localStorage.getItem(KEY))||{}}catch(e){}const g=c.grid||20;return `<div class="cz-row"><label class="check"><input type="checkbox" id="cz-snap"${c.snap===false?'':' checked'}> <span>Snap to grid</span></label><select id="cz-grid" aria-label="Grid size">${[10,20,40].map(n=>`<option value="${n}"${n===g?' selected':''}>${n}px</option>`).join('')}</select></div><p class="hint">Drag a frame by its grip, or any edge/corner to resize.</p>`})()+'<button type="button" class="text-button" id="cz-reset">Reset to default</button>';
}
panel.addEventListener('change',e=>{const id=e.target.dataset.czVis; if(!id) return; st.hidden=st.hidden.filter(x=>x!==id); if(!e.target.checked) st.hidden.push(id); save(); apply();});
panel.addEventListener('click',e=>{
  const mv=e.target.closest('[data-cz-move]');
  if(mv){const id=mv.dataset.czMove,i=st.order.indexOf(id),j=i+Number(mv.dataset.dir); if(j>=0&&j<st.order.length){[st.order[i],st.order[j]]=[st.order[j],st.order[i]]; save(); apply();} return;}
  if(e.target.id==='cz-done') panel.hidden=true;
  if(e.target.id==='cz-reset'){st={order:SECTIONS.filter(s=>s.top).map(s=>s.id),hidden:[]}; save(); apply();}
});
document.getElementById('customize-btn').addEventListener('click',()=>{panel.hidden=!panel.hidden; const m=document.querySelector('.settings-menu'); if(m) m.open=false; if(!panel.hidden) panel.scrollIntoView({block:'nearest'});});
document.addEventListener('click',e=>{const m=document.querySelector('.settings-menu'); if(m&&m.open&&!m.contains(e.target)) m.open=false;});
apply();
})();

// --- free move + 8-way resize with grid snap ---
(function(){
const K='ufc_v3_dashboard_layout';
const get=()=>{try{return JSON.parse(localStorage.getItem(K))||{}}catch(e){return{}}};
const put=o=>localStorage.setItem(K,JSON.stringify(o));
const map={poster:'#event-poster',analytics:'#analytics',card:'section.event-strip',ticket:'.entry-panel',ledger:'#ledger'};
const panel=document.getElementById('customize-panel');
const q=id=>document.querySelector(map[id]);
const cfg=()=>{const s=get();return{snap:s.snap!==false,grid:s.grid||20}};
const snap=v=>{const c=cfg();return c.snap?Math.round(v/c.grid)*c.grid:Math.round(v)};
let frames=get().frames||{};
{const s=get();if(s.heights||s.widths||s.wsOrder){delete s.heights;delete s.widths;delete s.wsOrder;put(s);}}
function applyOne(id){const e=q(id);if(!e)return;const f=frames[id]||{};
 e.style.transform=(f.x||f.y)?`translate(${f.x||0}px,${f.y||0}px)`:'';
 e.style.width=f.w?f.w+'px':'';e.style.height=f.h?f.h+'px':'';
 e.style.overflow=(f.w||f.h)?'auto':'';e.style.position=(f.x||f.y)?'relative':'';}
const applyAll=()=>Object.keys(map).forEach(applyOne);
const persist=()=>{const s=get();s.frames=frames;put(s)};
// overlay layer
const layer=document.createElement('div');layer.className='dash-layer';document.body.appendChild(layer);
const grid=document.createElement('div');grid.className='dash-grid';layer.appendChild(grid);
const DIRS=['n','s','e','w','ne','nw','se','sw'],ovs={};
Object.keys(map).forEach(id=>{const o=document.createElement('div');o.className='dash-ov';o.dataset.for=id;
 o.innerHTML='<span class="dash-grip" title="Drag to move">⠿ drag to move</span>'+DIRS.map(d=>`<i class="dash-h dash-h-${d}" data-dir="${d}"></i>`).join('');
 layer.appendChild(o);ovs[id]=o;});
function place(){if(!document.body.classList.contains('dash-editing'))return;
 const c=cfg(),de=document.documentElement;
 grid.style.width=de.scrollWidth+'px';grid.style.height=de.scrollHeight+'px';
 grid.style.backgroundSize=c.grid+'px '+c.grid+'px';grid.style.display=c.snap?'':'none';
 Object.keys(map).forEach(id=>{const e=q(id),o=ovs[id];if(!e||e.classList.contains('dash-hidden')){o.style.display='none';return;}
  const r=e.getBoundingClientRect();o.style.display='';
  o.style.left=(r.left+scrollX)+'px';o.style.top=(r.top+scrollY)+'px';o.style.width=r.width+'px';o.style.height=r.height+'px';});
 requestAnimationFrame(place);}
function begin(ev,id,mode){ev.preventDefault();const e=q(id);if(!e)return;
 const f=frames[id]=Object.assign({x:0,y:0},frames[id]);
 const st={x:f.x||0,y:f.y||0,w:e.offsetWidth,h:e.offsetHeight,px:ev.clientX,py:ev.clientY};
 const target=ev.currentTarget;target.setPointerCapture(ev.pointerId);e.classList.add('dash-dragging');
 const mv=m=>{const dx=m.clientX-st.px,dy=m.clientY-st.py,MIN=160;
  if(mode==='move'){f.x=snap(st.x+dx);f.y=snap(st.y+dy);}
  else{
   if(mode.includes('e')){f.w=Math.max(MIN,snap(st.w+dx));}
   if(mode.includes('s')){f.h=Math.max(MIN,snap(st.h+dy));}
   if(mode.includes('w')){const w=Math.max(MIN,snap(st.w-dx));f.w=w;f.x=st.x+(st.w-w);}
   if(mode.includes('n')){const h=Math.max(MIN,snap(st.h-dy));f.h=h;f.y=st.y+(st.h-h);}
  }
  applyOne(id);};
 const up=()=>{target.removeEventListener('pointermove',mv);target.removeEventListener('pointerup',up);target.removeEventListener('pointercancel',up);e.classList.remove('dash-dragging');persist();};
 target.addEventListener('pointermove',mv);target.addEventListener('pointerup',up);target.addEventListener('pointercancel',up);}
layer.addEventListener('pointerdown',ev=>{const o=ev.target.closest('.dash-ov');if(!o)return;const id=o.dataset.for;
 if(ev.target.classList.contains('dash-grip'))begin(ev,id,'move');
 else if(ev.target.dataset.dir)begin(ev,id,ev.target.dataset.dir);});
applyAll();
const set=on=>{document.body.classList.toggle('dash-editing',on);if(on)place();};
new MutationObserver(()=>set(!panel.hidden)).observe(panel,{attributes:true,attributeFilter:['hidden']});
panel.addEventListener('change',e=>{if(e.target.id==='cz-snap'){const s=get();s.snap=e.target.checked;put(s);}if(e.target.id==='cz-grid'){const s=get();s.grid=Number(e.target.value);put(s);}});
panel.addEventListener('click',e=>{if(e.target.id==='cz-reset'){frames={};const s=get();delete s.frames;put(s);applyAll();}});
})();
