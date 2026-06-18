import React, { useState, useEffect, useCallback, useMemo } from "react";
import { MO, P, DC, FL, PIE_COLORS, fmt, fK, sm, getRollingWindow, getWinVal } from "./data.js";
import { useForecastState } from "./useForecastState.js";
import { compute, currentMonthIdx, BASE_YEAR, runwayMonths, baselineBalance } from "./compute.js";
import ForecastEditor from "./ForecastEditor.jsx";
import { Card, Lbl, Bdg, NumIn, Pie, XRow, Toast, SaveBar } from "./components.jsx";
import { useAuth } from "./AuthContext.jsx";
import LoginPage from "./LoginPage.jsx";
import Reconcile from "./Reconcile.jsx";
import ActualsTab from "./ActualsTab.jsx";
import ClientsTab from "./ClientsTab.jsx";
import RunwayChart from "./RunwayChart.jsx";

export default function App() {
  const { user, profile, loading: authLoading, isAdmin, isViewer, signOut } = useAuth();
  const [tab, setTab] = useState("dashboard");
  const [scForm, setScForm] = useState(null); // forecast scenario add form
  const [showRecon, setShowRecon] = useState(false);
  const [arc, setArc] = useState(false); // payroll: show archived
  const [expandedLines, setExpandedLines] = useState({}); // forecast revenue stream expand state
  const [fcEdit, setFcEdit] = useState(false); // forecast tab: edit-values mode (full-horizon editor)
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" && window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // All forecast-data state (load, draft buffer, dirty, persist, ⌘S, beforeunload)
  // lives in useForecastState; compute() consumes the single `d` it returns.
  const { d, saved, saving, toast, dirty, dirtyCount, save, discard, persist, showToast } = useForecastState({ isAdmin, isViewer });

  const win = useMemo(() => getRollingWindow(), []);

  // Phase E2a: hooks below MUST stay above the early returns. Hook order
  // violation (R-310 "Rendered more hooks than during the previous render")
  // happens if any useEffect/useState/useMemo is placed after a conditional
  // early return — the bug that took the live app down on first push.
  // Sara's intern surface (PaymentsTab) was removed Jun 2026 — she tracks
  // invoices in Zoho Books now. Anyone without admin or viewer role gets the
  // deprecated-account screen below; the tab list is uniform otherwise.
  const isIntern = !isAdmin && !isViewer;
  const tabs = isAdmin ? ["dashboard", "forecast", "clients", "payroll", "actuals"] : ["dashboard", "forecast", "clients", "payroll"];
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0]); }, [tab]);

  // dirtyCount comes from useForecastState (drives the "N unsaved changes" pill).

  if (authLoading) return (<div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",color:P.tm,fontFamily:"'DM Sans', sans-serif",background:P.bg }}>Loading...</div>);
  if (!user) return <LoginPage />;
  if (!d) return (<div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",color:P.tm,fontFamily:"'DM Sans', sans-serif",background:P.bg }}>Loading data...</div>);
  if (isIntern) return (
    <div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",flexDirection:"column",gap:14,background:P.bg,color:P.tx,fontFamily:"'DM Sans', sans-serif",padding:20,textAlign:"center" }}>
      <div style={{ fontSize:16,fontWeight:600 }}>This account is no longer active.</div>
      <div style={{ fontSize:13,color:P.tm,maxWidth:360 }}>Invoice tracking has moved to Zoho Books. Contact Paul if you need access.</div>
      <button onClick={signOut} style={{ background:P.c2,color:P.tm,border:`1px solid ${P.bd}`,borderRadius:5,padding:"8px 18px",fontFamily:"'DM Sans', sans-serif",fontSize:11,cursor:"pointer",marginTop:6 }}>Sign Out</button>
    </div>
  );

  const c = compute(d);
  const today = new Date();
  const N = c.bl.length;
  // Horizon idx of the current month, anchored at Jan 2026 and clamped to the
  // horizon. Date-driven so it survives the year rollover (was getMonth(), which
  // silently reset to 0 every January and broke the runway from Jan 2027 on).
  const cm = Math.min(Math.max(0, currentMonthIdx(today)), N - 1);
  // Month label that stays correct past December (e.g. "Jan'27").
  const moLabel = (i) => (i < 12 ? MO[i] : `${MO[i % 12]}'${String(BASE_YEAR + Math.floor(i / 12)).slice(-2)}`);

  // Decimal runway from the current month (math lives in compute.js so the
  // Forecast editor's impact panel stays identical).
  const countGreen = (bal) => runwayMonths(bal, cm, d.openBal);

  // Baseline runway (no scenarios) over the full horizon.
  const blBase = baselineBalance(c, d.openBal);
  const mgBase = countGreen(blBase);
  // Forward-looking deficit: first bal<=0 from cm onward (matches RunwayChart).
  const fdFwd = (() => { for (let i = cm; i < blBase.length; i++) if (blBase[i] <= 0) return i; return -1; })();
  const fdFwdLabel = fdFwd >= 0 ? (fdFwd >= 12 ? `${MO[fdFwd % 12]}'${String(2026 + Math.floor(fdFwd / 12)).slice(-2)}` : MO[fdFwd]) : null;

  // With-scenarios runway (c.bl already includes scenarios)
  const mg = countGreen(c.bl);
  const fd = c.bl.findIndex(b => b <= 0);
  const hasActiveScenarios = (d.scenarios||[]).some(s=>s.on);

  // E2b: outstanding = sum of unpaid paymentSchedule entries already past due.
  // Drives the "If Late Collected" runway card.
  const outstanding = d.cl.reduce((s, x) => {
    const sched = x.serviceContract?.paymentSchedule || [];
    return s + sched
      .filter(p => !p.paid && new Date(p.dueDate) < today)
      .reduce((a, p) => a + (p.amount || 0), 0);
  }, 0);
  const blCollected = blBase.map((b,i) => i >= cm ? b + outstanding : b);
  const mgCollected = countGreen(blCollected);

  const tRv = sm(c.rv);
  const pieD = [
    { label: "Zoho Annual", value: sm(c.rvDerived.za), color: PIE_COLORS.za },
    { label: "Zoho Monthly", value: sm(c.rvDerived.zm), color: PIE_COLORS.zm },
    { label: "Infinity Mirror", value: sm(c.rvDerived.im), color: PIE_COLORS.im },
    { label: "Marketing", value: sm(d.rv.mk || []), color: PIE_COLORS.mk },
    { label: "One-Time", value: sm(c.otMerged), color: PIE_COLORS.ot },
  ];
  const devs = c.at.filter(t => t.dp === "Development");
  // E2b: aCl = count of clients with active service contract that are in forecast.
  const aCl = d.cl.filter(x =>
    x.serviceContract &&
    x.serviceContract.status === "active" &&
    x.serviceContract.inForecast !== false
  ).length;

  const th = { padding:"5px 6px",textAlign:"right",color:P.td,fontSize:10,borderBottom:`1px solid ${P.bd}`,fontFamily:"'DM Sans', sans-serif",fontWeight:500,textTransform:"uppercase",letterSpacing:"0.05em" };
  const thCm = (slot) => ({ ...th, background:slot.isCurrent?P.bB:"transparent",color:slot.isCurrent?P.b:P.td,fontWeight:slot.isCurrent?700:500 });
  const tdCm = (slot) => slot.isCurrent?P.bB:"transparent";

  const winVals = (arr) => win.map(s => getWinVal(arr, s, 0));

  // Location display: known codes get a flag + full name; free-form ones show as
  // typed. Ordering keeps US/PH/IN first, then the rest alphabetically.
  const LOC_NAME = { US: "United States", PH: "Philippines", IN: "India" };
  const locLabel = (loc) => `${FL[loc] || "📍"} ${LOC_NAME[loc] || loc}`;
  const locOrder = (locs) => { const pref = ["US", "PH", "IN"]; return [...locs].sort((a, b) => ((pref.indexOf(a) + 1 || 99) - (pref.indexOf(b) + 1 || 99)) || a.localeCompare(b)); };

  // Payroll editing helpers (free-form location + extensible department).
  const updTm = (id, patch) => save({ ...d, tm: d.tm.map(t => t.id === id ? { ...t, ...patch } : t) });
  const addMember = (ct) => save({ ...d, tm: [...d.tm, { id: "p" + Date.now(), nm: "New Hire", rl: "", dp: "Development", ct, co: 0, on: true }] });
  const addLocation = () => { const n = prompt("New location name (e.g. Canada, UK, Mexico):"); if (n && n.trim()) addMember(n.trim()); };
  const allLocs = locOrder([...new Set(d.tm.map(t => t.ct || "Other"))]);
  const allDepts = [...new Set([...Object.keys(DC), ...d.tm.map(t => t.dp).filter(Boolean)])];

  return (
    <div style={{ background:P.bg,minHeight:"100vh",color:P.tx,fontFamily:"'DM Sans', sans-serif",fontSize:13 }}>
      {/* Nav bar with logo — mix-blend-mode:lighten makes black bg invisible */}
      <div style={{ display:"flex",flexWrap:"wrap",alignItems:"center",borderBottom:`1px solid ${P.bd}`,background:P.c1,position:"sticky",top:0,zIndex:10 }}>
        <div style={{ padding:"10px 20px",display:"flex",alignItems:"center",gap:10 }}>
          <img src="/mirror-logo.png" alt="Mirror Advisors" style={{ height:28 }} />
          <span style={{ fontWeight:700,fontSize:14,color:P.g,opacity:.7 }}>Forecast</span>
        </div>
        {tabs.map(t=>(<button key={t} onClick={()=>setTab(t)} style={{ padding:"14px 10px",cursor:"pointer",border:"none",fontFamily:"'DM Sans', sans-serif",fontSize:10,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase",background:tab===t?P.bg:"transparent",color:tab===t?P.tx:P.tm,borderBottom:tab===t?`2px solid ${P.g}`:"2px solid transparent" }}>{t}</button>))}
        <div style={{ marginLeft:"auto",display:"flex",alignItems:"center",gap:10,paddingRight:16 }}>
          <span style={{ fontSize:10,color:P.tm }}>{profile?.email}</span>
          <button onClick={signOut} style={{ background:P.c2,color:P.tm,border:`1px solid ${P.bd}`,borderRadius:4,padding:"5px 10px",fontFamily:"'DM Sans', sans-serif",fontSize:10,cursor:"pointer" }}>Sign Out</button>
        </div>
      </div>

      {isViewer && <div style={{ background:P.aB,borderBottom:`1px solid ${P.aM||P.bd}`,padding:"6px 20px",fontSize:11,color:P.a,textAlign:"center",fontFamily:"'DM Sans', sans-serif",fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase" }}>Read-only view</div>}

      <div style={{ maxWidth:1300,margin:"0 auto",padding:"24px 16px" }}>

      {/* ===================== DASHBOARD ===================== */}
      {tab==="dashboard"&&(<>
        {/* Runway Cards */}
        <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr",gap:16,marginBottom:20 }}>
          <Card style={{ padding:20 }}>
            <Lbl>Baseline Runway</Lbl>
            <div style={{ display:"flex",alignItems:"baseline",gap:10 }}>
              <span style={{ fontSize:64,fontWeight:800,lineHeight:1,letterSpacing:"-0.04em",color:mgBase>=9?P.g:mgBase>=6?P.a:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{mgBase}</span>
              <span style={{ fontSize:16,color:P.tm }}>months green</span>
            </div>
            <div style={{ marginTop:6,color:P.tm,fontSize:12 }}>{fdFwdLabel?<>Deficit: <b style={{ color:P.r }}>{fdFwdLabel}</b></>:<span style={{ color:P.g }}>Green all year</span>}{" · Dec: "}<b style={{ color:blBase[11]>0?P.g:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(blBase[11])}</b></div>
          </Card>
          <div style={{ display:"grid",gridTemplateRows:"1fr 1fr",gap:16 }}>
            <Card style={{ padding:16,borderLeft:`3px solid ${hasActiveScenarios?P.p:P.bd}` }}>
              <Lbl>With Scenarios</Lbl>
              {hasActiveScenarios?<>
                <div style={{ fontSize:28,fontWeight:800,color:mg>=9?P.g:mg>=6?P.a:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{mg}<span style={{ fontSize:12,fontWeight:500,color:P.tm }}> months</span></div>
                <div style={{ fontSize:10,color:P.p,marginTop:4 }}>{(d.scenarios||[]).filter(s=>s.on).length} active scenario{(d.scenarios||[]).filter(s=>s.on).length>1?"s":""}</div>
              </>:<div style={{ fontSize:14,color:P.td,marginTop:8 }}>No active scenarios</div>}
            </Card>
            <Card style={{ padding:16,borderLeft:`3px solid ${outstanding>0?P.a:P.bd}` }}>
              <Lbl>If Late Collected</Lbl>
              {outstanding>0?<>
                <div style={{ fontSize:28,fontWeight:800,color:mgCollected>=9?P.g:mgCollected>=6?P.a:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{mgCollected}<span style={{ fontSize:12,fontWeight:500,color:P.tm }}> months</span></div>
                <div style={{ fontSize:10,color:P.a,marginTop:4 }}>{fmt(outstanding)} late</div>
              </>:<div style={{ fontSize:14,color:P.g,marginTop:8 }}>All current</div>}
            </Card>
          </div>
        </div>
        {/* Cash & Debt */}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16,marginBottom:20 }}>
          <Card style={{ padding:12 }}><Lbl>Cash</Lbl><div style={{ display:"flex",alignItems:"baseline",gap:6 }}><div style={{ fontSize:22,fontWeight:800,color:P.g,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(d.cashNow)}</div><button onClick={()=>{const v=prompt("Enter current bank balance:",d.cashNow);if(v!==null&&!isNaN(+v))save({...d,cashNow:Math.round(+v*100)/100});}} style={{ background:"transparent",border:`1px solid ${P.bd}`,borderRadius:4,padding:"2px 6px",color:P.td,fontSize:9,cursor:"pointer",fontFamily:"'DM Sans', sans-serif" }}>edit</button></div>{d.savings>0&&<div style={{ fontSize:11,color:P.tm,marginTop:4 }}>Savings: {fmt(d.savings)}</div>}{(()=>{const lastRecon=Object.entries(d.actuals||{}).sort((a,b)=>+b[0]-+a[0])[0];if(lastRecon)return<div style={{ fontSize:9,color:P.g,marginTop:4 }}>Verified: {MO[lastRecon[0]]} {new Date(lastRecon[1].reconDate).toLocaleDateString()}</div>;return null;})()}{(()=>{const delta=d.cashNow-(c.bl[cm]);return Math.abs(delta)>500?<div style={{ fontSize:10,color:P.a,marginTop:4 }}>Bank balance vs. {moLabel(cm)} forecast: {delta>0?"+":""}{fmt(delta)}</div>:null;})()}</Card>
          <Card style={{ padding:12 }}><Lbl>Debt</Lbl><div style={{ fontSize:22,fontWeight:800,color:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(Math.abs(d.sLoan+d.ccOwe))}</div></Card>
          <Card style={{ padding:12 }}><Lbl>2026 Revenue</Lbl><div style={{ fontSize:22,fontWeight:800,color:P.t,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(tRv)}</div></Card>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,marginBottom:20 }}>
          <Card><Lbl>Revenue Breakdown</Lbl><Pie data={pieD}/></Card>
        </div>
        <RunwayChart c={c} d={d} today={today} runwayMonths={mgBase} />
        <Lbl>Unit Economics</Lbl>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginTop:6,marginBottom:20 }}>
          {[["Rev/Client",fmt(Math.round(tRv/Math.max(aCl,1)/12)),P.t],["Rev/Head",fmt(Math.round(tRv/Math.max(c.at.length,1)/12)),P.t],["Clients/Dev",devs.length?(aCl/devs.length).toFixed(1):"—",P.t],["Devs",devs.length,P.tx],["Clients",aCl,P.tx]].map(([l,v,co])=><Card key={l} style={{ padding:12 }}><Lbl>{l}</Lbl><div style={{ fontSize:22,fontWeight:800,color:co,fontFamily:"'JetBrains Mono', monospace" }}>{v}</div></Card>)}
        </div>

        {/* Reconciliation */}
        <div style={{ marginBottom:20 }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8 }}>
            <Lbl>Month-End Reconciliation</Lbl>
            <button onClick={()=>setShowRecon(!showRecon)} style={{ background:showRecon?P.gB:"transparent",color:showRecon?P.g:P.tm,border:`1px solid ${showRecon?P.g+"44":P.bd}`,borderRadius:6,padding:"6px 14px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans', sans-serif" }}>
              {showRecon?"Hide":"Upload Statements"}
            </button>
          </div>
          {/* Show reconciled months summary even when collapsed */}
          {!showRecon && Object.keys(d.actuals||{}).length > 0 && (
            <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
              {Object.entries(d.actuals||{}).map(([mo,a])=>(
                <span key={mo} style={{ fontSize:10,padding:"4px 10px",borderRadius:4,background:P.gB,color:P.g }}>
                  {MO[mo]} ✓ {fmt(a.closingBal)}
                </span>
              ))}
            </div>
          )}
          {showRecon && <Reconcile d={d} save={save} compute={c} />}
        </div>
      </>)}

      {/* ===================== FORECAST ===================== */}
      {tab==="forecast"&&(<>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          {!isViewer ? <button onClick={()=>setFcEdit(v=>!v)} style={{ background:fcEdit?P.b:"transparent",color:fcEdit?"#fff":P.tm,border:`1px solid ${fcEdit?P.b:P.bd}`,borderRadius:6,padding:"8px 14px",fontFamily:"'DM Sans', sans-serif",fontSize:11,fontWeight:700,cursor:"pointer" }}>{fcEdit?"✓ Done editing":"✎ Edit values"}</button> : <span/>}
          <button onClick={()=>setScForm({ name:"",type:"revenue",amount:2000,startMo:cm,duration:0 })} style={{ background:P.a,color:P.bg,border:"none",borderRadius:6,padding:"8px 14px",fontFamily:"'DM Sans', sans-serif",fontSize:11,fontWeight:700,cursor:"pointer" }}>+ Add Scenario</button>
        </div>

        {/* Scenario Add Form */}
        {scForm && (
          <Card style={{ padding:16,marginBottom:16,border:`1px solid ${P.a}44`,background:`${P.aB}` }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
              <span style={{ fontSize:12,fontWeight:700,color:P.a }}>New Scenario</span>
              <button onClick={()=>setScForm(null)} style={{ background:"transparent",border:"none",color:P.td,cursor:"pointer",fontSize:14 }}>✕</button>
            </div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr auto auto auto auto",gap:10,alignItems:"end" }}>
              <div>
                <div style={{ fontSize:9,color:P.td,textTransform:"uppercase",marginBottom:3 }}>Name</div>
                <input value={scForm.name} onChange={e=>setScForm({...scForm,name:e.target.value})} placeholder="e.g. Acme Corp deal" style={{ background:P.c2,border:`1px solid ${P.bd}`,borderRadius:6,padding:"8px 10px",color:P.tx,fontSize:12,fontFamily:"'DM Sans', sans-serif",width:"100%",boxSizing:"border-box" }}/>
              </div>
              <div>
                <div style={{ fontSize:9,color:P.td,textTransform:"uppercase",marginBottom:3 }}>Type</div>
                <div style={{ display:"flex",gap:4 }}>
                  {["revenue","expense"].map(t=><button key={t} onClick={()=>setScForm({...scForm,type:t})} style={{ padding:"8px 12px",borderRadius:6,border:`1px solid ${scForm.type===t?(t==="revenue"?P.g:P.r):P.bd}`,background:scForm.type===t?(t==="revenue"?P.gB:P.rB):"transparent",color:scForm.type===t?(t==="revenue"?P.g:P.r):P.tm,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"'DM Sans', sans-serif" }}>{t==="revenue"?"Revenue":"Expense"}</button>)}
                </div>
              </div>
              <div>
                <div style={{ fontSize:9,color:P.td,textTransform:"uppercase",marginBottom:3 }}>$/Month</div>
                <input type="number" value={scForm.amount} onChange={e=>setScForm({...scForm,amount:Math.max(0,+e.target.value)})} style={{ background:P.c2,border:`1px solid ${P.bd}`,borderRadius:6,padding:"8px 10px",color:P.a,fontSize:12,fontFamily:"'JetBrains Mono', monospace",width:90,textAlign:"right" }}/>
              </div>
              <div>
                <div style={{ fontSize:9,color:P.td,textTransform:"uppercase",marginBottom:3 }}>Start</div>
                <select value={scForm.startMo} onChange={e=>setScForm({...scForm,startMo:+e.target.value})} style={{ background:P.c2,border:`1px solid ${P.bd}`,borderRadius:6,padding:"8px 10px",color:P.tx,fontSize:12,fontFamily:"'DM Sans', sans-serif" }}>
                  {MO.map((m,i)=><option key={i} value={i}>{m}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize:9,color:P.td,textTransform:"uppercase",marginBottom:3 }}>Duration</div>
                <select value={scForm.duration} onChange={e=>setScForm({...scForm,duration:+e.target.value})} style={{ background:P.c2,border:`1px solid ${P.bd}`,borderRadius:6,padding:"8px 10px",color:P.tx,fontSize:12,fontFamily:"'DM Sans', sans-serif" }}>
                  <option value={0}>Ongoing</option>
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map(n=><option key={n} value={n}>{n} mo</option>)}
                </select>
              </div>
            </div>
            <div style={{ display:"flex",justifyContent:"flex-end",marginTop:12 }}>
              <button disabled={!scForm.name.trim()||!scForm.amount} onClick={()=>{
                const ns = { id:"sc"+Date.now(), name:scForm.name.trim(), type:scForm.type, amount:scForm.amount, startMo:scForm.startMo, duration:scForm.duration, on:true };
                save({...d, scenarios:[...(d.scenarios||[]), ns]});
                setScForm(null);
              }} style={{ background:(!scForm.name.trim()||!scForm.amount)?P.c2:P.a,color:(!scForm.name.trim()||!scForm.amount)?P.td:P.bg,border:"none",borderRadius:6,padding:"8px 18px",fontFamily:"'DM Sans', sans-serif",fontSize:12,fontWeight:700,cursor:(!scForm.name.trim()||!scForm.amount)?"default":"pointer" }}>Add Scenario</button>
            </div>
          </Card>
        )}

        {/* Active Scenarios List */}
        {(d.scenarios||[]).length > 0 && (
          <div style={{ marginBottom:16 }}>
            <Lbl>Active Scenarios</Lbl>
            <div style={{ display:"flex",flexDirection:"column",gap:6,marginTop:6 }}>
              {(d.scenarios||[]).map((sc,si)=>{
                const start = sc.startMo||0;
                const dur = sc.duration||0;
                const end = dur > 0 ? Math.min(start + dur - 1, 11) : 11;
                const totalImpact = sc.amount * (end - start + 1);
                const isRev = sc.type === "revenue";
                return (
                  <div key={sc.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:P.c1,borderRadius:8,border:`1px dashed ${isRev?P.g:P.r}44`,opacity:sc.on?1:0.4 }}>
                    <span style={{ fontSize:9,fontWeight:700,color:isRev?P.g:P.r,textTransform:"uppercase",padding:"2px 6px",borderRadius:4,background:isRev?P.gB:P.rB,whiteSpace:"nowrap" }}>{isRev?"REV":"EXP"}</span>
                    <span style={{ fontSize:12,fontWeight:600,color:P.tx,flex:1 }}>{sc.name}</span>
                    <span style={{ fontSize:12,fontWeight:700,color:isRev?P.g:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{isRev?"+":"−"}{fmt(sc.amount)}/mo</span>
                    <span style={{ fontSize:10,color:P.tm }}>{MO[start]}{dur>0?`–${MO[end]}`:"+"}  ·  {fmt(totalImpact)} total</span>
                    <button onClick={()=>save({...d,scenarios:d.scenarios.map((s,i)=>i===si?{...s,on:!s.on}:s)})} style={{ background:sc.on?P.gB:P.c2,color:sc.on?P.g:P.td,border:`1px solid ${sc.on?P.g+"44":P.bd}`,borderRadius:4,padding:"3px 8px",fontSize:10,cursor:"pointer",fontFamily:"'DM Sans', sans-serif",fontWeight:600 }}>{sc.on?"ON":"OFF"}</button>
                    <button onClick={()=>save({...d,scenarios:d.scenarios.filter((_,i)=>i!==si)})} style={{ background:P.rB,color:P.r,border:`1px solid ${P.rM}`,borderRadius:4,padding:"3px 8px",fontSize:10,cursor:"pointer",fontFamily:"'DM Sans', sans-serif" }}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {fcEdit ? <ForecastEditor d={d} saved={saved} save={save} /> : (<>
        <Lbl>Cash Flow (Rolling 13-Month)</Lbl>
        <div style={{ overflowX:"auto",marginBottom:20 }}>
          <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
            <thead><tr><th style={{ ...th,textAlign:"left",width:160 }}></th>{win.map((s,i)=><th key={i} style={thCm(s)}>{s.label}</th>)}<th style={th}>Year</th></tr></thead>
            <tbody>
              {[
                {l:"Opening",v:win.map(s => s.inCurrentYear ? (s.idx===0?d.openBal:c.bl[s.idx-1]) : 0),co:P.tx},
                {l:"Revenue",v:winVals(c.rv),co:P.g},
                {l:"Expenses",v:winVals(c.ex),co:P.r},
              ].map(row=><tr key={row.l}><td style={{ padding:"5px 10px",color:row.co,borderBottom:`1px solid ${P.bd}10` }}>{row.l}</td>{row.v.map((v,i)=><td key={i} style={{ padding:"5px 6px",textAlign:"right",color:row.co,borderBottom:`1px solid ${P.bd}10`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(win[i]) }}>{win[i].inCurrentYear?fmt(v):"—"}</td>)}<td style={{ padding:"5px 6px",textAlign:"right",fontWeight:700,color:row.co,borderBottom:`1px solid ${P.bd}10`,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(row.l==="Opening"?[]:row.v))}</td></tr>)}

              <tr style={{ fontWeight:700 }}><td style={{ padding:"5px 10px",borderBottom:`1px solid ${P.bd}10` }}>Net Flow</td>{winVals(c.nt).map((v,i)=><td key={i} style={{ padding:"5px 6px",textAlign:"right",color:v>=0?P.g:P.r,borderBottom:`1px solid ${P.bd}10`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(win[i]) }}>{win[i].inCurrentYear?fmt(v):"—"}</td>)}<td style={{ padding:"5px 6px",textAlign:"right",color:sm(c.nt)>=0?P.g:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(c.nt))}</td></tr>

              <tr style={{ fontWeight:800 }}><td style={{ padding:"5px 10px" }}>BALANCE</td>{winVals(c.bl).map((v,i)=><td key={i} style={{ padding:"5px 6px",textAlign:"right",background:win[i].isCurrent?P.bB:v>5000?P.gB:v>0?P.aB:P.rB,color:win[i].isCurrent?P.b:v>5000?P.g:v>0?P.a:P.r,fontFamily:"'JetBrains Mono', monospace" }}>{win[i].inCurrentYear?fmt(v):"—"}</td>)}<td></td></tr>

            </tbody>
          </table>
        </div>

        {/* Revenue table — line items in muted white, TOTAL in green */}
        <Lbl>Revenue (Rolling 13-Month)</Lbl>
        <div style={{ overflowX:"auto",marginBottom:20 }}>
          <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
            <thead><tr><th style={{ ...th,textAlign:"left",width:160 }}></th>{win.map((s,i)=><th key={i} style={thCm(s)}>{s.label}</th>)}<th style={th}>Year</th></tr></thead>
            <tbody>
              {[
                { key:"za", label:"Zoho Annual",     source:c.rvDerived.za,   breakdown:c.rvBreakdown.za, expandable:true },
                { key:"zm", label:"Zoho Monthly",    source:c.rvDerived.zm,   breakdown:c.rvBreakdown.zm, expandable:true },
                { key:"im", label:"Infinity Mirror", source:c.rvDerived.im,   breakdown:c.rvBreakdown.im, expandable:true },
                { key:"mk", label:"Marketing",       source:d.rv.mk||[],      breakdown:null,             expandable:false },
                { key:"ot", label:"One-Time",        source:c.otMerged,       breakdown:c.rvBreakdown.ot, expandable:true },
              ].map(stream => {
                const open = expandedLines[stream.key] === true;
                const visibleKids = stream.expandable && stream.breakdown
                  ? stream.breakdown.filter(child => winVals(child.monthly).some(v => v !== 0))
                  : [];
                const showChevron = stream.expandable;
                return (
                  <React.Fragment key={stream.key}>
                    <tr onClick={showChevron ? () => setExpandedLines({ ...expandedLines, [stream.key]: !open }) : undefined}
                        style={{ cursor: showChevron ? "pointer" : "default" }}>
                      <td style={{ padding:"5px 10px",color:P.tm,borderBottom:`1px solid ${P.bd}10` }}>
                        {showChevron && <span style={{ display:"inline-block",width:14,fontSize:9,color:P.td,transition:"transform 0.15s",transform:open?"rotate(90deg)":"rotate(0)" }}>{"▶"}</span>}
                        {stream.label}
                      </td>
                      {win.map((s,i) => { const x = getWinVal(stream.source, s, 0); return <td key={i} style={{ padding:"5px 6px",textAlign:"right",color:x>0?P.tm:P.td,borderBottom:`1px solid ${P.bd}10`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(s) }}>{s.inCurrentYear?(x>0?fmt(x):"—"):"—"}</td>; })}
                      <td style={{ padding:"5px 6px",textAlign:"right",fontWeight:600,color:P.g,borderBottom:`1px solid ${P.bd}10`,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(stream.source))}</td>
                    </tr>
                    {open && stream.expandable && visibleKids.length === 0 && stream.key === "za" && (
                      <tr style={{ background:`${P.c2}80` }}>
                        <td colSpan={win.length+2} style={{ padding:"6px 10px 6px 32px",fontSize:11,color:P.td,fontStyle:"italic",borderBottom:`1px solid ${P.bd}15`,fontFamily:"'DM Sans', sans-serif" }}>No annual zoho clients have a renewalDate set.</td>
                      </tr>
                    )}
                    {open && visibleKids.map(child => {
                      const cVals = winVals(child.monthly);
                      return (
                        <tr key={child.clientId} style={{ background:`${P.c2}80` }}>
                          <td style={{ padding:"3px 10px 3px 32px",fontSize:11,color:P.td,borderBottom:`1px solid ${P.bd}15`,fontFamily:"'DM Sans', sans-serif" }}>{child.clientName}</td>
                          {cVals.map((v,i) => <td key={i} style={{ padding:"3px 6px",textAlign:"right",fontSize:11,color:v?P.td:`${P.td}60`,borderBottom:`1px solid ${P.bd}15`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(win[i]) }}>{v ? fmt(v) : "—"}</td>)}
                          <td style={{ padding:"3px 6px",textAlign:"right",fontSize:11,fontWeight:600,color:P.tm,borderBottom:`1px solid ${P.bd}15`,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(cVals))}</td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
              {/* Scenario revenue rows */}
              {(d.scenarios||[]).filter(s=>s.on&&s.type==="revenue").map(sc=>{const start=sc.startMo||0;const dur=sc.duration||0;const end=dur>0?Math.min(start+dur-1,11):11;const vals=MO.map((_,i)=>i>=start&&i<=end?sc.amount:0);return<tr key={sc.id}><td style={{ padding:"5px 10px",color:P.a,borderBottom:`1px solid ${P.bd}10`,fontStyle:"italic" }}><span style={{ fontSize:8,fontWeight:700,background:P.aB,color:P.a,padding:"1px 4px",borderRadius:3,marginRight:5 }}>SC</span>{sc.name}</td>{win.map((s,i)=>{const x=getWinVal(vals,s,0);return<td key={i} style={{ padding:"5px 6px",textAlign:"right",color:x>0?P.a:P.td,borderBottom:`1px solid ${P.bd}10`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(s) }}>{s.inCurrentYear?(x>0?fmt(x):"—"):"—"}</td>})}<td style={{ padding:"5px 6px",textAlign:"right",fontWeight:600,color:P.a,borderBottom:`1px solid ${P.bd}10`,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(vals))}</td></tr>})}
              <tr style={{ fontWeight:700 }}><td style={{ padding:"5px 10px",color:P.g,borderTop:`2px solid ${P.gM}` }}>TOTAL</td>{win.map((s,i)=>{const v=getWinVal(c.rv,s,0);return<td key={i} style={{ padding:"5px 6px",textAlign:"right",color:P.g,borderTop:`2px solid ${P.gM}`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(s) }}>{s.inCurrentYear?fmt(v):"—"}</td>})}<td style={{ padding:"5px 6px",textAlign:"right",color:P.g,borderTop:`2px solid ${P.gM}`,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(c.rv))}</td></tr>
            </tbody>
          </table>
        </div>

        <Lbl>Expenses (click to expand)</Lbl>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
            <thead><tr><th style={{ ...th,textAlign:"left",width:160 }}></th>{win.map((s,i)=><th key={i} style={thCm(s)}>{s.label}</th>)}<th style={th}>Year</th></tr></thead>
            <tbody>
              {locOrder(Object.keys(c.payroll)).map(loc=>(
                <XRow key={loc} label={locLabel(loc)} vals={winVals(c.payroll[loc])} win={win}
                  details={(c.payrollBreakdown[loc]||[]).map(m=>({n:m.n,v:winVals(m.v)}))}/>
              ))}
              <XRow label="Subscriptions" vals={winVals(c.sb)} win={win} details={d.sb.map(s=>({n:s.n,v:winVals(MO.map((_,i)=>{if(s.s&&i<s.s)return 0;if(s.e!==undefined&&i>s.e)return 0;return -s.a;}))}))}/>
              <XRow label="Other Costs" vals={winVals(c.oc)} win={win} details={d.oc.map(x=>({n:x.n,v:winVals(x.v)}))}/>
              <XRow label="Debt" vals={winVals(c.db)} win={win} details={d.db.map(x=>({n:x.n,v:winVals(x.v)}))}/>
              {/* Scenario expense rows */}
              {(d.scenarios||[]).filter(s=>s.on&&s.type==="expense").map(sc=>{const start=sc.startMo||0;const dur=sc.duration||0;const end=dur>0?Math.min(start+dur-1,11):11;const vals=MO.map((_,i)=>i>=start&&i<=end?-sc.amount:0);return<tr key={sc.id}><td style={{ padding:"5px 10px",color:P.a,borderBottom:`1px solid ${P.bd}20`,fontStyle:"italic" }}><span style={{ fontSize:8,fontWeight:700,background:P.aB,color:P.a,padding:"1px 4px",borderRadius:3,marginRight:5 }}>SC</span>{sc.name}</td>{win.map((s,i)=>{const x=getWinVal(vals,s,0);return<td key={i} style={{ padding:"5px 6px",textAlign:"right",color:x?P.a:P.td,borderBottom:`1px solid ${P.bd}20`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(s) }}>{s.inCurrentYear?(x?fmt(x):"—"):"—"}</td>})}<td style={{ padding:"5px 6px",textAlign:"right",fontWeight:600,color:P.a,borderBottom:`1px solid ${P.bd}20`,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(vals))}</td></tr>})}
              <tr style={{ fontWeight:700 }}><td style={{ padding:"5px 10px",color:P.r,borderTop:`2px solid ${P.rM}` }}>TOTAL</td>{winVals(c.ex).map((v,i)=><td key={i} style={{ padding:"5px 6px",textAlign:"right",color:P.r,borderTop:`2px solid ${P.rM}`,fontFamily:"'JetBrains Mono', monospace",background:tdCm(win[i]) }}>{win[i].inCurrentYear?fmt(v):"—"}</td>)}<td style={{ padding:"5px 6px",textAlign:"right",color:P.r,borderTop:`2px solid ${P.rM}`,fontFamily:"'JetBrains Mono', monospace" }}>{fmt(sm(c.ex))}</td></tr>
            </tbody>
          </table>
        </div>
        </>)}
      </>)}

      {/* ===================== CLIENTS (Paul-only reference list) ===================== */}
      {tab==="clients"&&(<ClientsTab d={d} save={save} isAdmin={isAdmin} />)}

      {/* ===================== PAYROLL ===================== */}
      {tab==="payroll"&&(<>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8 }}>
          <div style={{ display:"flex",gap:10,flexWrap:"wrap" }}>{allDepts.map(dd=><span key={dd} style={{ fontSize:10,color:DC[dd]||P.td,fontWeight:600 }}>● {dd}</span>)}</div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>setArc(!arc)} style={{ background:P.c2,color:P.tm,border:`1px solid ${P.bd}`,borderRadius:6,padding:"6px 12px",fontFamily:"'DM Sans', sans-serif",fontSize:11,cursor:"pointer" }}>{arc?"Hide":"Show"} Archived</button>
            <button onClick={addLocation} style={{ background:P.b,color:"white",border:"none",borderRadius:6,padding:"6px 14px",fontFamily:"'DM Sans', sans-serif",fontSize:11,fontWeight:700,cursor:"pointer" }}>+ Add location</button>
          </div>
        </div>
        {allLocs.map(ct=>{
          const pp=d.tm.filter(t=>(t.ct||"Other")===ct&&(t.on||arc));
          if(!pp.length) return null;
          const mo=pp.filter(p=>p.on).reduce((s,p)=>s+p.co,0);
          const selStyle={ background:P.c2,border:`1px solid ${P.bd}`,borderRadius:4,color:P.tx,fontFamily:"'DM Sans', sans-serif",fontSize:11,padding:4 };
          return(
            <div key={ct} style={{ marginBottom:20 }}>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10 }}>
                <span style={{ fontSize:16 }}>{FL[ct]||"📍"}</span>
                <span style={{ fontSize:13,fontWeight:700 }}>{LOC_NAME[ct]||ct}</span>
                <Bdg c="r">{fmt(-mo)}/mo</Bdg>
                <span style={{ fontSize:10,color:P.td }}>{pp.filter(p=>p.on).length} active</span>
                <button onClick={()=>addMember(ct)} style={{ background:"transparent",color:P.b,border:`1px solid ${P.bd}`,borderRadius:5,padding:"3px 10px",fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans', sans-serif" }}>+ Add here</button>
              </div>
              <div style={{ display:"grid",gap:6 }}>{pp.map(p=>(
                <div key={p.id} style={{ background:p.on?P.c1:`${P.c1}80`,borderRadius:8,padding:"10px 14px",border:`1px solid ${P.bd}`,display:"flex",alignItems:"center",gap:12,opacity:p.on?1:.4,flexWrap:"wrap" }}>
                  <div style={{ flex:1,minWidth:140 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                      <input value={p.nm} onChange={e=>updTm(p.id,{nm:e.target.value})} style={{ background:"transparent",border:"none",color:P.tx,fontFamily:"'DM Sans', sans-serif",fontSize:12,fontWeight:600,width:120 }}/>
                      <span style={{ fontSize:9,padding:"1px 6px",borderRadius:3,background:`${DC[p.dp]||P.td}20`,color:DC[p.dp]||P.td,fontWeight:600 }}>{p.dp||"—"}</span>
                    </div>
                    <input value={p.rl||""} onChange={e=>updTm(p.id,{rl:e.target.value})} style={{ background:"transparent",border:"none",color:P.tm,fontFamily:"'DM Sans', sans-serif",fontSize:11,marginTop:1 }} placeholder="Role"/>
                  </div>
                  <label style={{ display:"flex",flexDirection:"column",gap:2 }}><span style={{ fontSize:8,color:P.td,textTransform:"uppercase",letterSpacing:"0.05em" }}>Group</span>
                    <select value={p.dp||""} onChange={e=>{const v=e.target.value;if(v==="__new__"){const n=prompt("New department / group:");if(n&&n.trim())updTm(p.id,{dp:n.trim()});}else updTm(p.id,{dp:v});}} style={selStyle}>
                      {allDepts.map(dd=><option key={dd} value={dd}>{dd}</option>)}
                      {p.dp&&!allDepts.includes(p.dp)&&<option value={p.dp}>{p.dp}</option>}
                      <option value="__new__">＋ New group…</option>
                    </select>
                  </label>
                  <label style={{ display:"flex",flexDirection:"column",gap:2 }}><span style={{ fontSize:8,color:P.td,textTransform:"uppercase",letterSpacing:"0.05em" }}>Where</span>
                    <select value={ct} onChange={e=>{const v=e.target.value;if(v==="__new__"){const n=prompt("Move "+p.nm+" to new location:");if(n&&n.trim())updTm(p.id,{ct:n.trim()});}else updTm(p.id,{ct:v});}} style={selStyle}>
                      {allLocs.map(l=><option key={l} value={l}>{LOC_NAME[l]||l}</option>)}
                      <option value="__new__">＋ New location…</option>
                    </select>
                  </label>
                  <label style={{ display:"flex",flexDirection:"column",gap:2 }}><span style={{ fontSize:8,color:P.td,textTransform:"uppercase",letterSpacing:"0.05em" }}>Cost/mo</span>
                    <NumIn value={p.co} onChange={e=>updTm(p.id,{co:+e.target.value})} w={80}/>
                  </label>
                  <button onClick={()=>updTm(p.id,{on:!p.on})} style={{ background:"transparent",border:"none",cursor:"pointer",fontSize:14 }} title={p.on?"Archive":"Reactivate"}>{p.on?"📦":"♻️"}</button>
                  <button onClick={()=>save({...d,tm:d.tm.filter(t=>t.id!==p.id)})} style={{ background:"transparent",border:"none",color:P.rM,cursor:"pointer",fontSize:13 }}>×</button>
                </div>
              ))}</div>
            </div>
          );
        })}
      </>)}

      {/* ===================== ACTUALS (statement upload → reconcile → forecast lock) ===================== */}
      {tab==="actuals"&&isAdmin&&(<ActualsTab d={d} save={save} isAdmin={isAdmin} showToast={showToast} />)}

      </div>

      {!isViewer && <SaveBar dirty={dirty} saving={saving} onSave={persist} count={dirtyCount} onDiscard={discard} />}
      {toast && <Toast message={toast.msg} type={toast.type} />}
    </div>
  );
}
