import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// ── Luminous Bio-Tech brand palette ─────────────────────────────────────────
const C = {
  bg:'#F4F7F2', surface:'#FFFFFF', surface2:'#EEEEEE',
  ink:'#1a1c1c', ink2:'#414939', muted:'#717a67',
  border:'#dfe4d8', border2:'#c0cab4',
  green:'#7AC943', greenInk:'#2f6b00', greenTint:'#e8f5dc',
  black:'#000', error:'#ba1a1a', success:'#2f6b00', warning:'#9a6a00',
};

// API base: under nginx the console lives at /admin/, so calls must go through
// /admin/api/admin/... ; direct (:3000) access uses /api/admin/...
const API_BASE = location.pathname.startsWith('/admin') ? '/admin/api/admin' : '/api/admin';

async function api(path, opts) {
  const r = await fetch(`${API_BASE}${path}`, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function fmtDur(ms){
  const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60;
  return [h,m,ss].map(x=>String(x).padStart(2,'0')).join(':');
}

const card = { background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:18 };
const btn  = { fontFamily:'Montserrat,sans-serif', fontWeight:600, background:'transparent', color:C.ink, border:`1px solid ${C.black}`, borderRadius:4, padding:'8px 14px', cursor:'pointer', fontSize:13 };
const btnGreen = { ...btn, background:C.green, color:'#06210a', borderColor:C.green };
const btnDanger = { ...btn, color:C.error, borderColor:C.error };
const th = { textAlign:'left', padding:'9px 10px', color:C.ink2, fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, borderBottom:`1px solid ${C.border}` };
const td = { padding:'9px 10px', fontSize:13, borderBottom:`1px solid ${C.border}` };
const input = { fontFamily:'Libre Franklin,sans-serif', background:C.surface, color:C.ink, border:`1px solid ${C.border2}`, borderRadius:4, padding:'8px 10px', fontSize:13 };

function Pill({ mode }) {
  const isW = mode === 'webrtc';
  return <span style={{ fontSize:11, fontWeight:600, padding:'2px 9px', borderRadius:8,
    background:isW?'#dbe7ff':C.greenTint, color:isW?'#0d4a8a':C.greenInk }}>
    {isW?'WebRTC':'Canvas'}</span>;
}

function Bar({pct,color}){
  return <div style={{height:6,background:C.surface2,borderRadius:99,overflow:'hidden'}}>
    <div style={{width:`${pct}%`,height:'100%',background:color,transition:'150ms ease'}}/></div>;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard() {
  const [stats,setStats]=useState(null);
  const [sessions,setSessions]=useState([]);
  const [events,setEvents]=useState([]);
  const refresh=useCallback(async()=>{
    try{
      const [s,sess,ev]=await Promise.all([api('/stats'),api('/sessions'),api('/bdr?limit=20')]);
      setStats(s); setSessions(sess.sessions||[]); setEvents(ev.events||[]);
    }catch(e){/* transient */}
  },[]);
  useEffect(()=>{ refresh(); const t=setInterval(refresh,5000); return ()=>clearInterval(t); },[refresh]);

  if(!stats) return <p style={{color:C.muted}}>Loading…</p>;
  const ramPct=Math.min(100,Math.round((stats.ramUsedMB/stats.ramTotalMB)*100));
  const capPct=Math.round((stats.activeSessions/stats.maxSessions)*100);

  return <div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:14,marginBottom:18}}>
      <div style={card}>
        <h3 style={{fontSize:13,color:C.ink2}}>Capacity</h3>
        <p style={{fontSize:30,margin:'6px 0',fontFamily:'Montserrat,sans-serif',fontWeight:700}}>{stats.activeSessions}<span style={{fontSize:16,color:C.muted}}>/{stats.maxSessions}</span></p>
        <Bar pct={capPct} color={capPct>=70?C.warning:C.green}/>
        {stats.capacityWarn && <p style={{color:C.warning,fontSize:12,marginTop:6}}>⚠ Approaching capacity</p>}
      </div>
      <div style={card}>
        <h3 style={{fontSize:13,color:C.ink2}}>RAM (sessions)</h3>
        <p style={{fontSize:30,margin:'6px 0',fontFamily:'Montserrat,sans-serif',fontWeight:700}}>{stats.ramUsedMB}<span style={{fontSize:15,color:C.muted}}> / {stats.ramTotalMB} MB</span></p>
        <Bar pct={ramPct} color={ramPct>=80?C.error:C.green}/>
      </div>
      <div style={card}><h3 style={{fontSize:13,color:C.ink2}}>Active relays</h3><p style={{fontSize:30,margin:'6px 0',fontFamily:'Montserrat,sans-serif',fontWeight:700}}>{stats.activeRelays}</p></div>
      <div style={card}><h3 style={{fontSize:13,color:C.ink2}}>BDR events today</h3><p style={{fontSize:30,margin:'6px 0',fontFamily:'Montserrat,sans-serif',fontWeight:700}}>{stats.bdrEventsToday}</p>
        <p style={{fontSize:12,color:stats.flaggedUsers?C.error:C.muted}}>{stats.flaggedUsers} flagged user(s)</p></div>
    </div>

    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
      <h2 style={{fontSize:18}}>Active Sessions</h2>
      <button style={btnDanger} onClick={async()=>{ if(confirm('Kill ALL sessions?')){ await api('/sessions/kill-all',{method:'POST'}); refresh(); } }}>Kill All</button>
    </div>
    <SessionTable sessions={sessions} onKill={async(id)=>{ await api(`/sessions/${id}`,{method:'DELETE'}); refresh(); }}/>

    <h2 style={{fontSize:18,margin:'22px 0 8px'}}>Recent BDR Events</h2>
    <EventTable events={events}/>
  </div>;
}

function SessionTable({sessions,onKill}){
  if(!sessions.length) return <p style={{color:C.muted,fontSize:13}}>No active sessions.</p>;
  return <div style={{...card,padding:0,overflow:'hidden'}}>
    <table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>
      <th style={th}>User</th><th style={th}>Domain</th><th style={th}>Duration</th><th style={th}>RAM</th><th style={th}>CPU</th><th style={th}>Mode</th><th style={th}></th>
    </tr></thead><tbody>
      {sessions.map(s=><tr key={s.sessionId}>
        <td style={td}>{s.userId}</td>
        <td style={td}>{s.targetUrl}</td>
        <td style={td}>{fmtDur(s.durationMs)}</td>
        <td style={td}>{s.ramMB!=null?`${s.ramMB} MB`:'—'}</td>
        <td style={td}>{s.cpuPct!=null?`${s.cpuPct}%`:'—'}</td>
        <td style={td}><Pill mode={s.streamMode}/></td>
        <td style={{...td,textAlign:'right'}}><button style={btnDanger} onClick={()=>onKill(s.sessionId)}>Kill</button></td>
      </tr>)}
    </tbody></table></div>;
}

function EventTable({events}){
  if(!events.length) return <p style={{color:C.muted,fontSize:13}}>No events recorded.</p>;
  const colorFor=(t)=>({CLIPBOARD_ATTEMPT:C.warning,SCREENSHOT_ATTEMPT:C.warning,MALICIOUS_EXTENSION:C.error,OAUTH_EXFIL:C.error,KEYSTROKE_HOOK:C.error,DOWNLOAD_ATTEMPT:C.warning}[t]||C.ink2);
  return <div style={{...card,padding:0,overflow:'hidden'}}>
    <table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>
      <th style={th}>Time</th><th style={th}>Type</th><th style={th}>User</th><th style={th}>URL</th>
    </tr></thead><tbody>
      {events.map((e,i)=><tr key={i}>
        <td style={td}>{new Date(e.timestamp).toLocaleTimeString()}</td>
        <td style={{...td,color:colorFor(e.type),fontWeight:600}}>{e.type}</td>
        <td style={td}>{e.userId}</td>
        <td style={{...td,maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.url}</td>
      </tr>)}
    </tbody></table></div>;
}

// ── Logs (persistent session history + exports) ─────────────────────────────
function LogsView(){
  const [data,setData]=useState({logs:[],total:0,totalPages:1});
  const [page,setPage]=useState(1);
  const [q,setQ]=useState('');
  const refresh=useCallback(()=>{
    const qs=new URLSearchParams({page,limit:25,...(q?{q}:{})}).toString();
    api(`/logs?${qs}`).then(setData).catch(()=>{});
  },[page,q]);
  useEffect(()=>{ refresh(); },[refresh]);

  const dl=(fmt)=>{ window.open(`${API_BASE}/logs/export.${fmt}`,'_blank'); };

  return <div>
    <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginBottom:12}}>
      <h2 style={{fontSize:18,marginRight:'auto'}}>Session Logs <span style={{fontSize:13,color:C.muted,fontWeight:400}}>({data.total} record{data.total===1?'':'s'})</span></h2>
      <input style={{...input,width:220}} placeholder="Search user / IP / URL / container…" value={q}
        onChange={e=>{setQ(e.target.value);setPage(1);}}/>
      <button style={btnGreen} onClick={()=>dl('csv')}>Export CSV</button>
      <button style={btnGreen} onClick={()=>dl('xls')}>Export XLS</button>
      <button style={btnGreen} onClick={()=>dl('pdf')}>Export PDF</button>
    </div>
    {!data.logs.length
      ? <p style={{color:C.muted,fontSize:13}}>No session logs yet. Logs appear here when a session ends (and persist permanently).</p>
      : <div style={{...card,padding:0,overflow:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',minWidth:980}}><thead><tr>
          <th style={th}>Date</th><th style={th}>Time</th><th style={th}>Device IP</th><th style={th}>URL Visited</th>
          <th style={th}>Browsed</th><th style={th}>Threats</th><th style={th}>RAM</th><th style={th}>CPU</th>
          <th style={th}>Container</th><th style={th}>User</th>
        </tr></thead><tbody>
          {data.logs.map((r,i)=><tr key={i}>
            <td style={td}>{r.date}</td>
            <td style={td}>{r.time}</td>
            <td style={td}>{r.deviceIp||'—'}</td>
            <td style={{...td,maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.urlVisited}</td>
            <td style={td}>{r.browsedTime}</td>
            <td style={{...td,color:r.threatsCaptured?C.error:C.ink2,fontWeight:r.threatsCaptured?700:400}}>{r.threatsCaptured}</td>
            <td style={td}>{r.ramMB!=null?`${r.ramMB} MB`:'—'}</td>
            <td style={td}>{r.cpuPct!=null?`${r.cpuPct}%`:'—'}</td>
            <td style={{...td,fontSize:12,color:C.ink2}}>{r.containerName}</td>
            <td style={td}>{r.userId}</td>
          </tr>)}
        </tbody></table></div>}
    <div style={{display:'flex',gap:10,alignItems:'center',marginTop:12}}>
      <button style={btn} disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>Prev</button>
      <span style={{fontSize:13,color:C.muted}}>Page {page} / {data.totalPages||1}</span>
      <button style={btn} disabled={page>=(data.totalPages||1)} onClick={()=>setPage(p=>p+1)}>Next</button>
    </div>
  </div>;
}

// ── Whitelist management ────────────────────────────────────────────────────
function WhitelistView(){
  const [wl,setWl]=useState({defaults:[],custom:[]});
  const [domain,setDomain]=useState('');
  const [err,setErr]=useState('');
  const refresh=useCallback(()=>api('/whitelist').then(setWl).catch(()=>{}),[]);
  useEffect(()=>{ refresh(); },[refresh]);

  const add=async()=>{
    setErr('');
    try{ const d=await api('/whitelist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain})});
      setWl(w=>({...w,custom:d.custom||w.custom})); setDomain(''); }
    catch(e){ setErr('Invalid domain (use e.g. example.com)'); }
  };
  const remove=async(d)=>{
    try{ const r=await api('/whitelist',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain:d})});
      setWl(w=>({...w,custom:r.custom||w.custom})); }catch(e){/* ignore */}
  };

  return <div>
    <h2 style={{fontSize:18,marginBottom:6}}>Whitelist</h2>
    <p style={{fontSize:13,color:C.ink2,marginBottom:14}}>Domains added here are <b>served to every user's extension</b> and isolated automatically. Default domains are built in and cannot be removed.</p>

    <div style={{...card,marginBottom:18}}>
      <h3 style={{fontSize:14,marginBottom:10}}>Add a domain</h3>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
        <input style={{...input,width:260}} placeholder="example.com" value={domain}
          onChange={e=>setDomain(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')add();}}/>
        <button style={btnGreen} onClick={add}>Add to whitelist</button>
        {err && <span style={{color:C.error,fontSize:13}}>{err}</span>}
      </div>
    </div>

    <h3 style={{fontSize:14,margin:'0 0 8px'}}>Admin-added domains ({(wl.custom||[]).length})</h3>
    {!(wl.custom||[]).length
      ? <p style={{color:C.muted,fontSize:13,marginBottom:18}}>None yet.</p>
      : <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:18}}>
          {wl.custom.map(d=><span key={d} style={{display:'inline-flex',alignItems:'center',gap:8,background:C.greenTint,color:C.greenInk,borderRadius:8,padding:'5px 8px 5px 11px',fontSize:13}}>
            {d}<button onClick={()=>remove(d)} title="Remove" style={{border:'none',background:'transparent',color:C.error,cursor:'pointer',fontSize:15,lineHeight:1,padding:'0 2px'}}>×</button>
          </span>)}
        </div>}

    <h3 style={{fontSize:14,margin:'0 0 8px',color:C.ink2}}>Built-in defaults ({(wl.defaults||[]).length})</h3>
    <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
      {(wl.defaults||[]).map(d=><span key={d} style={{background:C.surface2,color:C.ink2,borderRadius:8,padding:'4px 10px',fontSize:12}}>{d}</span>)}
    </div>
  </div>;
}

// ── System ──────────────────────────────────────────────────────────────────
function SystemView(){
  const [sys,setSys]=useState(null);
  useEffect(()=>{ const f=()=>api('/system').then(setSys).catch(()=>{}); f(); const t=setInterval(f,5000); return ()=>clearInterval(t); },[]);
  if(!sys) return <p style={{color:C.muted}}>Loading…</p>;
  return <div>
    <h2 style={{fontSize:18,marginBottom:8}}>Containers</h2>
    <div style={{...card,padding:0,overflow:'hidden',marginBottom:18}}>
      <table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>
        <th style={th}>ID</th><th style={th}>Name</th><th style={th}>State</th><th style={th}>Status</th>
      </tr></thead><tbody>
        {(sys.containers||[]).map((c,i)=><tr key={i}>
          <td style={td}>{c.id||'—'}</td><td style={td}>{c.name||c.error}</td>
          <td style={{...td,color:c.state==='running'?C.success:C.muted}}>{c.state||''}</td><td style={td}>{c.status||''}</td>
        </tr>)}
        {!(sys.containers||[]).length && <tr><td style={td} colSpan={4}>No RBI containers running.</td></tr>}
      </tbody></table></div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:14}}>
      <div style={card}><h3 style={{fontSize:14,color:C.ink2}}>Broker</h3>
        <p style={{fontSize:13,marginTop:8}}>v{sys.broker.version||'?'} · uptime {sys.broker.uptime||0}s</p>
        <p style={{fontSize:13}}>active containers: {sys.broker.activeContainers??'—'}</p></div>
      <div style={card}><h3 style={{fontSize:14,color:C.ink2}}>Render gateway</h3>
        <p style={{fontSize:13,marginTop:8}}>sessions: {sys.gateway.activeSessions??'—'}</p>
        <p style={{fontSize:13}}>relays: {sys.gateway.activeRelays??'—'}</p></div>
      <div style={card}><h3 style={{fontSize:14,color:C.ink2}}>Frame-streamer port pool</h3>
        <p style={{fontSize:13,marginTop:8}}>in use: {sys.portPool.inUse} / {sys.portPool.total}</p>
        <p style={{fontSize:13}}>available: {sys.portPool.available}</p></div>
    </div>
  </div>;
}

function BdrView(){
  const [data,setData]=useState({events:[],total:0});
  const [page,setPage]=useState(1);
  const [type,setType]=useState('');
  useEffect(()=>{ const qs=new URLSearchParams({page,limit:25,...(type?{type}:{})}).toString();
    api(`/bdr?${qs}`).then(setData).catch(()=>{}); },[page,type]);
  const types=['','CLIPBOARD_ATTEMPT','SCREENSHOT_ATTEMPT','MALICIOUS_EXTENSION','OAUTH_EXFIL','KEYSTROKE_HOOK','DOWNLOAD_ATTEMPT'];
  return <div>
    <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10}}>
      <h2 style={{fontSize:18}}>BDR Event Log</h2>
      <select value={type} onChange={e=>{setType(e.target.value);setPage(1);}} style={{...input}}>
        {types.map(t=><option key={t} value={t}>{t||'All types'}</option>)}
      </select>
    </div>
    <EventTable events={data.events}/>
    <div style={{display:'flex',gap:10,alignItems:'center',marginTop:12}}>
      <button style={btn} disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>Prev</button>
      <span style={{fontSize:13,color:C.muted}}>Page {page} / {data.totalPages||1} · {data.total} events</span>
      <button style={btn} disabled={page>=(data.totalPages||1)} onClick={()=>setPage(p=>p+1)}>Next</button>
    </div>
  </div>;
}

function SessionsOnly(){
  const [sessions,setSessions]=useState([]);
  const refresh=useCallback(()=>api('/sessions').then(d=>setSessions(d.sessions||[])).catch(()=>{}),[]);
  useEffect(()=>{ refresh(); const t=setInterval(refresh,5000); return ()=>clearInterval(t); },[refresh]);
  return <div><h2 style={{fontSize:18,marginBottom:8}}>All Sessions</h2>
    <SessionTable sessions={sessions} onKill={async(id)=>{ await api(`/sessions/${id}`,{method:'DELETE'}); refresh(); }}/></div>;
}

// ── App shell ────────────────────────────────────────────────────────────────
function App(){
  const [view,setView]=useState('dashboard');
  const tabs=[['dashboard','Dashboard'],['sessions','Sessions'],['logs','Logs'],['whitelist','Whitelist'],['bdr','BDR Events'],['system','System']];
  return <div style={{maxWidth:1180,margin:'0 auto',padding:'28px 22px'}}>
    <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
      <h1 style={{fontSize:28}}>Precision <span style={{color:C.greenInk}}>RBI</span></h1>
      <span style={{fontSize:12,color:C.ink2}}>Operations Console</span>
    </header>
    <nav style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:22,borderBottom:`1px solid ${C.border}`}}>
      {tabs.map(([k,label])=><button key={k} onClick={()=>setView(k)} style={{
        fontFamily:'Montserrat,sans-serif',fontWeight:600,
        background:'transparent',border:'none',borderBottom:view===k?`2px solid ${C.green}`:'2px solid transparent',
        color:view===k?C.greenInk:C.muted,padding:'8px 12px',cursor:'pointer',fontSize:14}}>{label}</button>)}
    </nav>
    {view==='dashboard' && <Dashboard/>}
    {view==='sessions' && <SessionsOnly/>}
    {view==='logs' && <LogsView/>}
    {view==='whitelist' && <WhitelistView/>}
    {view==='bdr' && <BdrView/>}
    {view==='system' && <SystemView/>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
