export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Henry dashboard</title>
<style>
:root{color-scheme:dark;--bg:#101318;--panel:#181d25;--line:#2c3442;--text:#e9edf5;--muted:#9ba7b8;--accent:#8b9cff;--good:#55d69b;--warn:#ffca75;--bad:#ff6b6b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#202a45 0,#101318 36rem);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}h1{margin:0;font-size:30px}h2{margin:0 0 12px;font-size:16px}.sub{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.panel{background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:0 12px 36px #0003}.wide{grid-column:span 8}.side{grid-column:span 4}.full{grid-column:1/-1}.stat{display:inline-flex;flex-direction:column;margin-right:28px}.stat b{font-size:22px;color:var(--accent)}.stat span{color:var(--muted);font-size:12px}.scroll{max-height:360px;overflow:auto}.row{border-top:1px solid var(--line);padding:10px 0}.row:first-child{border-top:0}.tag{color:var(--accent);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.muted{color:var(--muted)}button{border:1px solid var(--line);background:#242c3a;color:var(--text);padding:8px 12px;border-radius:8px;cursor:pointer}button:hover{border-color:var(--accent)}input,textarea,select{width:100%;background:#0f131a;border:1px solid var(--line);border-radius:8px;color:var(--text);padding:9px;margin:5px 0 8px}textarea{min-height:80px;resize:vertical}.approval{border-left:3px solid var(--warn);padding-left:10px}.ok{color:var(--good)}pre{white-space:pre-wrap;word-break:break-word;color:#c8d2e4;margin:0}.memory-node{font-size:12px;color:var(--muted)}.controls{display:flex;gap:12px;align-items:center}.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}.seg button{border:0;border-radius:0;background:transparent;padding:8px 14px;color:var(--muted)}.seg button.active{background:var(--accent);color:#10131f;font-weight:600}.seg button:hover{border-color:transparent;color:var(--text)}.seg button.active:hover{color:#10131f}
.hero{display:flex;flex-wrap:wrap;align-items:center;gap:22px;margin-bottom:20px;font-variant-numeric:tabular-nums}.hero-item{display:flex;flex-direction:column;gap:2px}.hero-item span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}.hero-item b{font-size:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pulse-wrap{display:flex;align-items:center;gap:9px}#heartbeat-canvas{width:34px;height:34px;display:block;transition:opacity .4s ease}#heartbeat-canvas.stale{opacity:.35}
.rambar-track{position:relative;height:10px;width:230px;border-radius:6px;background:#0f131a;border:1px solid var(--line);overflow:hidden}.rambar-fill{height:100%;width:0%;background:var(--good);transition:width .5s ease,background-color .5s ease}
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--line);color:var(--muted);width:fit-content}.badge.normal{color:var(--good);border-color:var(--good)}.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.critical{color:var(--bad);border-color:var(--bad)}
#sparkline{display:block;background:#0f131a;border:1px solid var(--line);border-radius:8px}
.holo-panel{position:relative;background:#080d14}.holo-panel h2{color:#9fe9ff;letter-spacing:.06em}#holo-canvas{width:100%;height:460px;display:block;border-radius:10px;background:#03060b;border:1px solid #163646;cursor:grab;touch-action:none}#holo-canvas.dragging{cursor:grabbing}
#holo-hud{position:absolute;top:52px;right:26px;width:216px;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#8fdff2;text-shadow:0 0 6px rgba(77,217,255,.55);animation:holoflicker 4.5s infinite}
#holo-hud .holo-hud-bar{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-bottom:8px}#holo-hud button{pointer-events:auto;border:1px solid #1f4f63;background:#07161ecc;color:#9fe9ff;padding:2px 8px;border-radius:6px;font-size:11px;line-height:1.4}#holo-hud button:hover{border-color:#4dd9ff}.holo-note{opacity:.75}
.holo-readout{border:1px solid #16394a;border-radius:8px;padding:8px 10px;background:#04101899;display:flex;flex-direction:column;gap:2px;min-height:34px}.holo-readout.active{border-color:#2f7d97;box-shadow:0 0 18px rgba(77,217,255,.16)}.holo-readout.locked{border-color:#4dd9ff}.holo-readout b{color:#d6f6ff;font-size:12px}.holo-readout i{font-style:normal;color:#e6fbff}.holo-dim{opacity:.6}
.holo-panel .observatory-link{position:absolute;top:20px;right:26px;color:#9fe9ff;border-color:#1f4f63}
@keyframes holoflicker{0%,92%,100%{opacity:1}93%{opacity:.72}94%{opacity:1}96%{opacity:.85}97%{opacity:1}}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}.panel-head h2{margin:0 0 12px}.observatory-link{color:var(--accent);text-decoration:none;font-size:12px;font-weight:600;letter-spacing:.03em;border:1px solid var(--line);border-radius:999px;padding:5px 12px;white-space:nowrap}.observatory-link:hover{border-color:var(--accent);background:#242c3a}
.stat.bad b{color:var(--bad)}.relogin-btn{background:rgba(255,202,117,.14);border:1px solid var(--warn);color:var(--warn);padding:7px 13px;border-radius:8px;font-weight:600;font-size:12px;cursor:pointer;white-space:nowrap}.relogin-btn:hover{background:rgba(255,202,117,.24)}.relogin-btn:disabled{opacity:.6;cursor:default}#auth-alert-wrap{display:none}
@media(max-width:900px){.wide,.side{grid-column:1/-1}}
</style></head><body><main><header><div><h1>🌙 Henry</h1><div class="sub">Luna-orchestrated terminal agent · Dad's control room</div></div><div class="controls"><div class="seg" title="Primary provider"><button id="prov-codex" onclick="setProvider('codex')">Codex</button><button id="prov-claude" onclick="setProvider('claude')">Claude</button></div><button onclick="refresh()">Refresh</button></div></header>
<section class="panel hero" id="hero">
<div class="pulse-wrap"><canvas id="heartbeat-canvas" width="34" height="34"></canvas><div class="hero-item"><span>Heartbeat</span><b id="hero-status">connecting…</b></div></div>
<div class="hero-item"><span>Uptime</span><b id="hero-uptime">—</b></div>
<div class="hero-item"><span>Provider</span><b id="hero-provider">—</b></div>
<div class="hero-item"><span>Last activity</span><b id="hero-last-activity">—</b></div>
<div class="hero-item"><span>Pending approvals</span><b id="hero-pending">—</b></div>
<div class="hero-item" id="auth-alert-wrap"><span>&nbsp;</span><button class="relogin-btn" id="relogin-btn" onclick="relogin()"></button></div>
<div class="hero-item"><span>Agent-stack RAM · 5.0 GB budget</span><div class="rambar-track"><div class="rambar-fill" id="ram-bar-fill"></div></div><b id="ram-bar-label" style="font-size:11px;color:var(--muted);margin-top:2px">—</b></div>
<div class="hero-item"><span>Memory pressure</span><span class="badge" id="mem-pressure-badge">—</span></div>
<div class="hero-item"><span>RSS · last 60 samples</span><canvas id="sparkline" width="220" height="40"></canvas></div>
</section>
<section class="grid"><div class="panel full" id="status">Loading status…</div>
<div class="panel full"><h2>Memory health</h2><div id="memory-health-body" class="muted">Loading…</div></div>
<div class="panel wide"><h2>Ask Henry</h2><textarea id="prompt" placeholder="What should Henry investigate?"></textarea><button onclick="ask()">Run</button><pre id="answer" style="margin-top:12px"></pre></div>
<div class="panel side"><h2>Dispatch a specialist</h2><select id="role"><option>architect</option><option>runtime</option><option>memory</option><option>dashboard</option><option>gmail</option><option>pr-review</option><option>job-application</option><option>qa</option></select><input id="task" placeholder="Task for the specialist"><button onclick="dispatch()">Dispatch</button><pre id="dispatchResult" style="margin-top:12px"></pre></div>
<div class="panel wide"><h2>Activity</h2><div id="activity" class="scroll"></div></div>
<div class="panel side"><h2>Approval queue</h2><div id="approvals" class="scroll"></div></div>
<div class="panel full"><h2>Job applications</h2><div id="jobstats" style="margin-bottom:10px"></div><div id="jobs" class="scroll"></div></div>
<div class="panel full holo-panel"><h2>Memory &middot; holographic</h2><canvas id="holo-canvas"></canvas><div id="holo-hud"></div><a class="observatory-link" href="/memory" target="_blank" rel="noopener">Open Memory Observatory &rarr;</a></div>
<div class="panel side"><h2>Knowledge base</h2><div id="knowledge"></div></div>
<div class="panel side"><h2>Cover letters</h2><div id="covers" class="scroll"></div></div></section></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function get(path){const r=await fetch(path);return r.json()} async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});return r.json()}
const RAM_BUDGET_BYTES=5*1024*1024*1024;
const rssHistory=[];
const ACTIVITY_LIMIT=80;
function fmtBytes(n){if(n==null||!isFinite(n))return '—';const gb=n/1024/1024/1024;if(gb>=1)return gb.toFixed(2)+' GB';return (n/1024/1024).toFixed(0)+' MB'}
function fmtDuration(sec){if(sec==null||!isFinite(sec))return '—';sec=Math.max(0,Math.round(sec));const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;if(h>0)return h+'h '+m+'m';if(m>0)return m+'m '+s+'s';return s+'s'}
function fmtWhen(iso){if(!iso)return '—';try{const d=new Date(iso);const diff=(Date.now()-d.getTime())/1000;if(diff<5)return 'just now';if(diff<60)return Math.floor(diff)+'s ago';if(diff<3600)return Math.floor(diff/60)+'m ago';return d.toLocaleTimeString()}catch{return '—'}}
function fmtPct(n){return n==null||!isFinite(n)?'—':Math.round(n*100)+'%'}
function fmtMs(n){return n==null||!isFinite(n)?'—':Math.round(n)+'ms'}
function activityRow(x){return '<div class="row"><div class="tag">'+esc(x.kind)+'</div><div>'+esc(x.message)+'</div><div class="muted">'+esc(x.timestamp)+'</div></div>'}
function renderActivityList(list){document.querySelector('#activity').innerHTML=(list||[]).map(activityRow).join('')||'<div class="muted">No activity yet.</div>'}
async function loadActivity(){try{const a=await get('/api/activity?limit='+ACTIVITY_LIMIT);renderActivityList(a)}catch{}}
function prependActivity(evt){const el=document.querySelector('#activity');if(el.querySelector('.muted')&&el.children.length===1)el.innerHTML='';el.insertAdjacentHTML('afterbegin',activityRow(evt));while(el.children.length>ACTIVITY_LIMIT)el.removeChild(el.lastElementChild)}
function drawSparkline(){const c=document.querySelector('#sparkline');if(!c||!c.getContext)return;const ctx=c.getContext('2d');const w=c.width,h=c.height;ctx.clearRect(0,0,w,h);if(rssHistory.length<2)return;const max=Math.max(RAM_BUDGET_BYTES,...rssHistory);const min=0;ctx.beginPath();rssHistory.forEach((v,i)=>{const x=(i/(rssHistory.length-1))*(w-4)+2;const y=h-2-((v-min)/(max-min||1))*(h-4);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.strokeStyle='#8b9cff';ctx.lineWidth=1.5;ctx.stroke();const last=rssHistory[rssHistory.length-1];const lastX=w-2,lastY=h-2-((last-min)/(max-min||1))*(h-4);ctx.fillStyle='#8b9cff';ctx.beginPath();ctx.arc(lastX,lastY,2,0,Math.PI*2);ctx.fill()}
const ecg={targetBpm:52,currentBpm:52,phase:0,lastTs:null,stale:false,running:0,queued:0,working:false};
function ecgLerp(a,b,t){return a+(b-a)*t}
function ecgColor(bpm){const t=Math.max(0,Math.min(1,(bpm-52)/(120-52)));const r=Math.round(ecgLerp(56,255,t));const g=Math.round(ecgLerp(214,178,t));const b=Math.round(ecgLerp(255,74,t));return 'rgb('+r+','+g+','+b+')'}
function ecgAmplitude(phase){const lub=Math.exp(-Math.pow((phase-0.08)/0.045,2));const dub=0.55*Math.exp(-Math.pow((phase-0.22)/0.05,2));return Math.max(lub,dub)}
function drawEcg(){const c=document.querySelector('#heartbeat-canvas');if(!c||!c.getContext)return;const ctx=c.getContext('2d');const w=c.width,h=c.height;ctx.clearRect(0,0,w,h);
const amp=ecg.stale?0:ecgAmplitude(ecg.phase);const color=ecg.stale?'#5a6478':ecgColor(ecg.currentBpm);const cx=w/2,cy=h/2,baseR=5,r=baseR+amp*4.5;
ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=ecg.stale?0:6+amp*10;ctx.fill();ctx.shadowBlur=0}
function ecgTick(ts){if(document.hidden){ecg.lastTs=null;requestAnimationFrame(ecgTick);return}
if(ecg.lastTs==null)ecg.lastTs=ts;const dt=ts-ecg.lastTs;ecg.lastTs=ts;const alpha=Math.min(1,dt/1500);
ecg.currentBpm=ecgLerp(ecg.currentBpm,ecg.targetBpm,alpha);
if(!ecg.stale){ecg.phase+=(ecg.currentBpm/60)*(dt/1000);if(ecg.phase>=1)ecg.phase-=Math.floor(ecg.phase)}
drawEcg();requestAnimationFrame(ecgTick)}
function updateAgentState(data){const a=data.agentState||{};const working=a.state==='working';
ecg.targetBpm=working?120:52;ecg.running=a.running||0;ecg.queued=a.queued||0;ecg.working=working;
if(!ecg.stale){let caption=working?('WORKING · '+ecg.running+' task'+(ecg.running===1?'':'s')):'live';if(ecg.queued>0)caption+=' · +'+ecg.queued+' queued';document.querySelector('#hero-status').textContent=caption}}
requestAnimationFrame(ecgTick);
function renderResources(data){const total=data.totalRssBytes;const pct=Math.min(100,(total/RAM_BUDGET_BYTES)*100);const fill=document.querySelector('#ram-bar-fill');fill.style.width=pct+'%';fill.style.background=pct<60?'var(--good)':pct<85?'var(--warn)':'var(--bad)';document.querySelector('#ram-bar-label').textContent=fmtBytes(total)+' / 5.00 GB';
const mp=data.memoryPressure;const badge=document.querySelector('#mem-pressure-badge');badge.className='badge'+(mp?' '+mp.level:'');badge.textContent=mp?mp.level.toUpperCase()+' · '+mp.freePercent+'% free':'—';
updateAgentState(data);
const hb=data.heartbeat||{};document.querySelector('#hero-uptime').textContent=fmtDuration(hb.uptimeSec);document.querySelector('#hero-last-activity').textContent=fmtWhen(hb.lastActivityAt);document.querySelector('#hero-pending').textContent=hb.pendingApprovals??'—';
rssHistory.push(total);while(rssHistory.length>60)rssHistory.shift();drawSparkline();
renderAuthAlert(data.authAlert||null)}
let authAlertProvider=null,authAlertKey=null;
function renderAuthAlert(alert){const wrap=document.querySelector('#auth-alert-wrap');const btn=document.querySelector('#relogin-btn');if(!wrap||!btn)return;
if(!alert){wrap.style.display='none';authAlertProvider=null;authAlertKey=null;return}
authAlertProvider=alert.provider;wrap.style.display='flex';
const key=alert.provider+'|'+alert.at;
if(key!==authAlertKey){authAlertKey=key;btn.disabled=false;btn.textContent='⚠ '+esc(alert.provider)+' logged out — Re-login'}}
async function relogin(){if(!authAlertProvider)return;const btn=document.querySelector('#relogin-btn');btn.disabled=true;btn.textContent='opening Terminal…';
try{const r=await post('/api/relogin',{provider:authAlertProvider});btn.textContent=r.error?('failed — '+r.error):'opened — waiting for login…';btn.disabled=!!r.error}
catch{btn.textContent='failed — retry';btn.disabled=false}}
let staleTimer=null;
function armStaleWatch(){if(staleTimer)clearTimeout(staleTimer);document.querySelector('#heartbeat-canvas').classList.remove('stale');ecg.stale=false;staleTimer=setTimeout(()=>{document.querySelector('#heartbeat-canvas').classList.add('stale');ecg.stale=true;document.querySelector('#hero-status').textContent='stale'},6000)}
let es=null,fallbackTimer=null;
function startFallbackPolling(){if(fallbackTimer)return;document.querySelector('#hero-status').textContent='polling (SSE unavailable)';fallbackTimer=setInterval(loadActivity,5000)}
function startEvents(){try{es=new EventSource('/api/events')}catch{startFallbackPolling();return}
es.addEventListener('hello',()=>{document.querySelector('#hero-status').textContent='live'});
es.addEventListener('activity',e=>{try{prependActivity(JSON.parse(e.data))}catch{}armStaleWatch()});
es.addEventListener('resources',e=>{try{renderResources(JSON.parse(e.data))}catch{}armStaleWatch()});
es.onerror=()=>{if(es){es.close();es=null}startFallbackPolling()}}
function panelError(id,msg){const el=document.querySelector('#'+id);if(el)el.innerHTML='<div class="muted">'+esc(msg)+'</div>'}
function refreshStatus(){get('/api/status').then(s=>{document.querySelector('#prov-codex').classList.toggle('active',s.provider==='codex');document.querySelector('#prov-claude').classList.toggle('active',s.provider==='claude');document.querySelector('#hero-provider').textContent=esc(s.provider);document.querySelector('#status').innerHTML='<span class="stat"><b>'+esc(s.name)+'</b><span>agent</span></span><span class="stat"><b>'+esc(s.provider)+'</b><span>primary provider</span></span><span class="stat"><b>'+esc(s.approvals)+'</b><span>pending approvals</span></span><span class="stat"><b>'+esc(s.jobs?.readyForReview??0)+'</b><span>jobs to review</span></span><span class="stat"><b>'+esc(s.memory?.memories??0)+'</b><span>memories</span></span><span class="stat"><b class="ok">online</b><span>'+esc(s.dashboard)+'</span></span>'}).catch(()=>panelError('status','status unavailable — retrying…'))}
function refreshApprovals(){get('/api/approvals').then(p=>{document.querySelector('#approvals').innerHTML=(p||[]).map(x=>'<div class="row approval"><div><b>'+esc(x.title)+'</b></div><div class="muted">'+esc(x.status)+' · '+esc(x.recipient||'')+'</div><pre>'+esc(x.body)+'</pre>'+(x.status==='pending'?'<button onclick="approve(\\''+x.id+'\\')">Approve</button>':'' )+(x.status==='approved'?'<button onclick="execute(\\''+x.id+'\\')">Send / post</button>':'')+'</div>').join('')||'<div class="muted">Nothing waiting.</div>'}).catch(()=>panelError('approvals','approvals unavailable'))}
function refreshJobs(){get('/api/jobs').then(j=>{const sm=j.summary||{};document.querySelector('#jobstats').innerHTML='<span class="stat"><b>'+esc(sm.total??0)+'</b><span>total</span></span><span class="stat"><b>'+esc(sm.discovered??0)+'</b><span>discovered</span></span><span class="stat"><b>'+esc(sm.drafted??0)+'</b><span>drafted</span></span><span class="stat"><b>'+esc(sm.readyForReview??0)+'</b><span>ready for review</span></span><span class="stat"><b>'+esc(sm.filled??0)+'</b><span>filled</span></span><span class="stat"><b>'+esc(sm.submitted??0)+'</b><span>submitted</span></span>';document.querySelector('#jobs').innerHTML=(j.applications||[]).map(x=>'<div class="row"><div><b>'+esc(x.posting?.title)+'</b> · '+esc(x.posting?.company)+'</div><div class="muted">'+esc(x.status)+(x.approvalId?' · approval '+esc(x.approvalId):'')+(x.resumePdfPath?' · resume PDF ready':'')+'</div><div class="muted">'+esc(x.posting?.url)+'</div></div>').join('')||'<div class="muted">No job applications yet. Run: henry jobs prepare &lt;url&gt;</div>'}).catch(()=>{panelError('jobstats','—');panelError('jobs','jobs unavailable')})}
function refreshKnowledge(){get('/api/knowledge').then(k=>{const body=k.error?'<div class="muted">'+esc(k.error)+'</div>':k.loading?'<div class="muted">Loading knowledge base…</div>':(k.stats?'<span class="stat"><b>'+esc(k.stats.count??0)+'</b><span>entries</span></span>'+Object.entries(k.stats.domains||k.stats.tiers||{}).map(([name,n])=>'<span class="stat"><b>'+esc(n)+'</b><span>'+esc(name)+'</span></span>').join(''):'<div class="muted">No knowledge base yet.</div>');
const d=k.distillation;const pct=d&&d.totalModules?Math.round((d.distilled/d.totalModules)*100):null;
const distillHtml=d&&d.totalModules!=null?'<div class="muted" style="margin-top:8px">Distillation: '+esc(d.distilled)+' / '+esc(d.totalModules)+' modules'+(pct!=null?' ('+pct+'%)':'')+'</div>':'';
document.querySelector('#knowledge').innerHTML=body+distillHtml}).catch(()=>panelError('knowledge','knowledge unavailable'))}
function refreshEngramMetrics(){get('/api/engram/metrics').then(m=>{const el=document.querySelector('#memory-health-body');if(!el)return;
if(!m||m.available===false){el.innerHTML='<div class="muted">Recall metrics unavailable'+(m&&m.reason?': '+esc(m.reason):' — src/metrics not wired up yet.')+'</div>';return}
const badCoverage=m.recallCoverage!=null&&m.recallCoverage<0.6;const badP95=m.p95LatencyMs!=null&&m.p95LatencyMs>2000;
const fresh=m.indexFreshness||{};
el.innerHTML=[
['recall coverage',fmtPct(m.recallCoverage),badCoverage],
['zero-result rate',fmtPct(m.zeroResultRate),false],
['p50 latency',fmtMs(m.p50LatencyMs),false],
['p95 latency',fmtMs(m.p95LatencyMs),badP95],
['personal index',fmtWhen(fresh.personal),false],
['knowledge index',fmtWhen(fresh.knowledge),false],
['recall attempts',m.totalAttempts??'—',false],
].map(([label,value,bad])=>'<span class="stat'+(bad?' bad':'')+'"><b>'+value+'</b><span>'+esc(label)+'</span></span>').join('')}).catch(()=>panelError('memory-health-body','memory metrics unavailable'))}
function refreshCovers(){get('/api/covers').then(c=>{document.querySelector('#covers').innerHTML=(c||[]).map(x=>'<div class="row"><div><b>'+esc(x.name)+'</b></div><div class="muted">'+esc(Math.round((x.size||0)/1024))+' KB · '+esc(new Date(x.mtime).toLocaleString())+'</div></div>').join('')||'<div class="muted">No cover letters yet.</div>'}).catch(()=>panelError('covers','cover letters unavailable'))}
function refresh(){refreshStatus();refreshApprovals();refreshJobs();refreshKnowledge();refreshCovers();refreshEngramMetrics()}
async function ask(){const p=document.querySelector('#prompt').value;document.querySelector('#answer').textContent='Henry is thinking…';const r=await post('/api/ask',{prompt:p});document.querySelector('#answer').textContent=r.response||r.error||JSON.stringify(r,null,2);refresh()}
async function dispatch(){const role=document.querySelector('#role').value;const task=document.querySelector('#task').value;document.querySelector('#dispatchResult').textContent='Luna is dispatching…';const r=await post('/api/dispatch',{role,task});document.querySelector('#dispatchResult').textContent=r.response||r.error||JSON.stringify(r,null,2);refresh()}
async function approve(id){await post('/api/approvals/'+encodeURIComponent(id)+'/approve');refresh()} async function execute(id){const r=await post('/api/approvals/'+encodeURIComponent(id)+'/execute');alert(r.result||r.error||'Done');refresh()} async function setProvider(name){const r=await post('/api/settings/provider',{provider:name});if(r.error)alert(r.error);refresh()}

refresh();loadActivity();startEvents();armStaleWatch();setInterval(refresh,5000);
</script>
<script src="/holo.js" defer></script>
</body></html>`;
