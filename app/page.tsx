"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowUpRight, Database, FlaskConical, Globe2, RefreshCw, Satellite } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import ClassificationControls from "@/components/classification-controls";
import ClassificationDetail from "@/components/classification-detail";
import { useIntelligence } from "@/components/use-intelligence";
import { CATEGORIES, defaultFilters, filterEvents, summarize, type ObservationFilters } from "@/lib/classification";
import ThermalGlobe from "@/components/thermal-globe";
import { sampleEvents, type ThermalEvent, type EventResponse } from "@/lib/thermal";

const utc = (value: string) => new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
// Satellite acquisition time rendered in Indian Standard Time.
const ist = (value: string) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " IST";
const ago = (value: string) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) { const h = Math.floor(seconds / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  const d = Math.floor(seconds / 86400); return `${d} day${d === 1 ? "" : "s"} ago`;
};
const coord = (e: ThermalEvent) => `${e.latitude.toFixed(4)}°, ${e.longitude.toFixed(4)}°`;

export default function Home() {
  const [data, setData] = useState<EventResponse | null>(null);
  const [sample, setSample] = useState(false);
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ThermalEvent | null>(null);
  const [filters, setFilters] = useState<ObservationFilters>({...defaultFilters});
  const [indiaFocus, setIndiaFocus] = useState(0);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/events?hours=${hours}&limit=1000`, { signal: controller.signal });
      const result = await response.json() as EventResponse;
      if (!response.ok) throw new Error(result.message || "The observation service is unavailable. Please retry.");
      setData(result);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load observations.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [hours]);
  useEffect(() => {
    setData(null); setSelected(null);
    if (sample) return;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5 * 60 * 1000);
    return () => { window.clearInterval(timer); request.current?.abort(); };
  }, [load, sample]);
  const rawEvents = useMemo(() => sample ? sampleEvents : data?.events ?? [], [sample, data]);
  const intelligence = useIntelligence(rawEvents, sample);
  // Newest satellite acquisition first (not fetch time).
  const events = useMemo(() => filterEvents(intelligence.events, filters).slice().sort((a, b) => b.detected_at.localeCompare(a.detected_at)), [intelligence.events, filters]);
  const totals = useMemo(() => summarize(events), [events]);
  const selectedResult = intelligence.events.find(e => e.id === selected?.id)?.classification;
  const filtersActive = filters.category !== 'all' || filters.minFrp !== '' || filters.maxFrp !== '' || filters.dayNight !== 'all' || filters.highIndustrial;
  const state = sample ? "Sample Mode - India" : error ? "Update failed" : busy ? "Refreshing observations" : data?.stale ? "Delayed satellite feed" : "NASA FIRMS connected";
  const sourceLabel = data?.source_mode === "nasa_public" ? "NASA public feed" : data?.source_mode === "fastapi" ? "Observation API" : "Supabase history";
  const historyLabel = data?.persistence === "connected" ? "History connected" : data?.persistence === "empty" ? "History awaiting first ingestion" : data?.persistence === "unavailable" ? "History connection unavailable" : "History not connected";
  const inspect = useCallback((event: ThermalEvent) => { setSelected(event); intelligence.prioritize(event); }, [intelligence.prioritize]);
  return (
    <main className="app-shell">
      <header className="topbar">
        <a href="/" className="brand"><span className="brand-mark"><Activity size={23} /></span><span>ThermoWatch <b>AI</b></span></a>
        <span className="header-label">THERMAL OBSERVATION EXPLORER</span>
        <span className="phase-label">PHASE 01</span>
      </header>
      <section className="workspace-heading">
        <div><div className="eyebrow">GLOBAL MONITORING / VIIRS</div><h1>Thermal observations</h1><p>Explore satellite detections. Inspect the underlying signal.</p></div>
        <div className="actions">
          <ClassificationControls filters={filters} onChange={setFilters} events={events} sample={sample} onRetry={intelligence.retry} />
          <Select value={hours} onValueChange={setHours} disabled={sample}>
            <SelectTrigger aria-label="Observation time window"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="24">Last 24 hours</SelectItem><SelectItem value="168">Last 7 days</SelectItem></SelectContent>
          </Select>
          <Button variant="outline" disabled={busy && !sample} onClick={() => { if (sample) setSample(false); else void load(); }}><RefreshCw className={busy && !sample ? "spin" : ""} />{sample ? "Return to real feed" : "Refresh"}</Button>
        </div>
      </section>
      <div className={`connection-strip ${sample ? "sample-strip" : ""}`} role="status">
        {sample ? <FlaskConical size={17} /> : <Database size={17} />}
        <strong>{state}</strong><span>{sample ? "Sample Mode - Curated detections over India for demonstration. These are fictional fixtures, not satellite detections." : error || (busy && !data ? "Downloading the latest NASA observations…" : data?.message || "Satellite observations refresh automatically every 5 minutes.")}</span>
        {!sample && !busy && <Button variant="ghost" size="sm" onClick={() => { request.current?.abort(); setBusy(false); setSelected(null); setSample(true); }}>Explore sample <ArrowUpRight /></Button>}
      </div>
      {!sample && data && <div className="feed-health"><span>{sourceLabel} · {historyLabel}</span><span>Latest observation: {data.latest_observation ? ist(data.latest_observation) : "None in this window"}</span><span>Feed checked: {data.fetched_at ? utc(data.fetched_at) : "—"} · Every 5 min</span>{!!data.rejected_rows && <span>{data.rejected_rows} malformed source rows excluded</span>}</div>}
      <div className="classification-summary" aria-label="Summary of visible detections">{([['Total detections',totals.total],['Industrial Fires',totals.industrial],['Persistent Sources',totals.persistent],['Natural Fires',totals.natural],['Mining Activity',totals.mining],['Unknown',totals.unknown]] as const).map(([label,value])=><div key={label}><span>{label}</span><strong>{value.toLocaleString()}</strong></div>)}</div>
      <div className="classification-status" role="status"><span>Visible: {events.length.toLocaleString()} / {rawEvents.length.toLocaleString()} loaded · OSM context {intelligence.checked.toLocaleString()} / {rawEvents.length.toLocaleString()}{sample?' (fictional)':intelligence.working?' · Enriching…':intelligence.checked<rawEvents.length?' · Partial context; retry in Filters':' checked'} · {sample?'Demo history':intelligence.historyState==='ready'?'7-day history checked':intelligence.historyState==='loading'?'Checking 7-day history…':'7-day history unavailable'}</span><Button variant="ghost" size="sm" onClick={()=>{setSelected(null);setIndiaFocus(v=>v+1);}}>Focus on India</Button></div>
      <div className="explorer-grid">
        <section className="globe-panel" aria-label="Interactive observation globe">
          <div className="globe-caption"><Globe2 size={16} /><span>GLOBAL VIEW</span><span className="neutral-tag">{sample ? "SAMPLE" : "RULE-BASED"}</span></div>
          <ThermalGlobe events={events} onSelect={inspect} selected={selected} indiaFocus={indiaFocus} />
          <div className="globe-footer"><span>Drag to rotate · Scroll to zoom</span><div className="classification-legend">{Object.entries(CATEGORIES).map(([key,c])=><span key={key}><i style={{background:c.color}} />{c.label}</span>)}</div></div>
        </section>
        <aside className="observations-panel">
          <div className="panel-heading"><div><h2>Observations</h2><p>{sample ? `Curated India sample - ${events.length} detections` : `${(data?.count ?? events.length).toLocaleString()} records in selected window`}</p></div><span className="count">{busy && !sample && !data ? "—" : events.length.toLocaleString()}</span></div>
          <div className="observation-list" aria-busy={busy && !sample}>
            {events.length ? events.map(event => <button key={event.id} className="observation" onClick={() => inspect(event)}><span className="event-icon" style={{color:CATEGORIES[event.classification.category].color}}><Satellite size={18} /></span><span className="event-text"><strong>{coord(event)}</strong><span>{ago(event.detected_at)} · {ist(event.detected_at)}</span><span>{event.satellite} · {event.day_night === "D" ? "Day" : "Night"}</span><span className="classification-label">{CATEGORIES[event.classification.category].label}{event.classification.confidence!==null?` · ${event.classification.confidence}%`:""}</span></span><span className="frp">{event.frp.toFixed(1)}<small>MW FRP</small></span></button>) : <Empty className="empty-state"><Satellite size={34} /><h3>{busy ? "Loading observations" : error ? "Feed unavailable" : filtersActive ? "No matching observations" : "No observations in this window"}</h3><p>{busy ? "Fetching satellite observation records." : error ? "Retry the NASA connection. No synthetic observations are substituted." : filtersActive ? "Adjust or reset the filters to see more detections." : "Try the 7-day window. An empty result does not establish absence of thermal activity."}</p></Empty>}
          </div>
          <div className="panel-note">{data?.truncated && !sample ? "Filters and counters cover the newest 1,000 loaded observations, not the full global feed." : "Counters cover visible detections. Natural Fires combines forest and agricultural candidates; classifications are provisional."}</div>
        </aside>
      </div>
      <footer className="app-footer"><span>NASA FIRMS · VIIRS observations · <a className="osm-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></span><span>Rule-based interpretation · OSM land context · Not verified incidents.</span><a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer">About the source <ArrowUpRight size={14} /></a></footer>
      <Sheet open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><SheetContent className="event-sheet w-full sm:max-w-lg overflow-y-auto"><SheetHeader><div className="eyebrow">{sample ? "SYNTHETIC SAMPLE" : "OBSERVATION RECORD"}</div><SheetTitle>Thermal detection</SheetTitle><SheetDescription>Satellite signal properties · classification evidence</SheetDescription></SheetHeader>{selected && <div className="event-detail"><div className="coordinate-card"><span>COORDINATES</span><strong>{coord(selected)}</strong><p>{ago(selected.detected_at)} · {ist(selected.detected_at)}</p></div><dl className="property-grid"><div><dt>Fire radiative power</dt><dd>{selected.frp.toFixed(1)} <small>MW</small></dd></div><div><dt>FIRMS confidence</dt><dd>{({l:"Low",n:"Nominal",h:"High"} as Record<string,string>)[selected.confidence] || selected.confidence}</dd></div><div><dt>Satellite</dt><dd>{selected.satellite}</dd></div><div><dt>Day / night</dt><dd>{selected.day_night === "D" ? "Day" : "Night"}</dd></div><div><dt>Brightness I4</dt><dd>{selected.brightness_ti4 ?? "—"} <small>K</small></dd></div><div><dt>Brightness I5</dt><dd>{selected.brightness_ti5 ?? "—"} <small>K</small></dd></div><div><dt>Scan / track</dt><dd>{selected.scan ?? "—"} / {selected.track ?? "—"} <small>km</small></dd></div><div><dt>Instrument</dt><dd>VIIRS</dd></div></dl>{selectedResult && <ClassificationDetail result={selectedResult} />}<div className="record-meta"><span>Record ID</span><code>{selected.id}</code><span>Product</span><code>{selected.source}</code><span>{selected.ingested_at ? "Ingested into history" : "Retrieved from NASA"}</span><code>{utc(selected.ingested_at || selected.retrieved_at!)}</code></div><Button variant="outline" asChild><a href={`https://www.openstreetmap.org/?mlat=${selected.latitude}&mlon=${selected.longitude}#map=12/${selected.latitude}/${selected.longitude}`} target="_blank" rel="noreferrer">View location in OpenStreetMap <ArrowUpRight /></a></Button></div>}</SheetContent></Sheet>
    </main>
  );
}
