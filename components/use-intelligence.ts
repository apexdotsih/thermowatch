'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classify, type Context, type Persistence } from '@/lib/classification';
import { demoIntelligence } from '@/lib/demo-intelligence';
import type { ThermalEvent } from '@/lib/thermal';
const tile=(p:ThermalEvent)=>`${Math.floor(p.latitude*50)},${Math.floor(p.longitude*50)}`;
export function useIntelligence(events:ThermalEvent[],sample:boolean) {
  const [contexts,setContexts]=useState<Record<string,Context>>({});
  const [history,setHistory]=useState<Record<string,Persistence>>({});
  const [working,setWorking]=useState(false),[historyState,setHistoryState]=useState('pending');
  const [revision,setRevision]=useState(0);
  const cache=useRef<Record<string,Context>>({});
  const priority=useRef<ThermalEvent|null>(null);
  const prioritize=useCallback((e:ThermalEvent)=>{priority.current=e;},[]);
  useEffect(()=>{
    if(sample||!events.length){setWorking(false);return;}
    const controller=new AbortController();let disposed=false;
    const valid=Object.fromEntries(events.filter(e=>cache.current[e.id]?.status==='ready'&&Date.now()-Date.parse(cache.current[e.id].fetched_at)<6*3600000).map(e=>[e.id,cache.current[e.id]]));
    setContexts(valid);setHistory({});setHistoryState('loading');setWorking(true);
    const points=events.map(({id,latitude,longitude,detected_at,satellite,day_night})=>({id,latitude,longitude,detected_at,satellite,day_night}));
    void fetch('/api/intelligence/history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({points}),signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error('History unavailable');const d=await r.json() as {history:Record<string,Persistence>};if(!disposed){setHistory(d.history);setHistoryState('ready');}}).catch(()=>{if(!disposed)setHistoryState('unavailable');});
    const queue=events.filter(e=>!valid[e.id]).sort((a,b)=>Number(b.latitude>=6&&b.latitude<=37&&b.longitude>=68&&b.longitude<=98)-Number(a.latitude>=6&&a.latitude<=37&&a.longitude>=68&&a.longitude<=98));
    void(async()=>{
      let failedBatches=0;
      while(queue.length&&!disposed) {
        if(priority.current){const index=queue.findIndex(e=>e.id===priority.current?.id);if(index>0)queue.unshift(...queue.splice(index,1));priority.current=null;}
        const keys=new Set<string>(),batch:ThermalEvent[]=[];
        for(let i=0;i<queue.length&&batch.length<200;){const k=tile(queue[i]);if(keys.has(k)||keys.size<8){keys.add(k);batch.push(...queue.splice(i,1));}else i++;}
        try {
          const r=await fetch('/api/intelligence/context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({points:batch.map(({id,latitude,longitude})=>({id,latitude,longitude}))}),signal:controller.signal});
          if(!r.ok)throw new Error('Context unavailable');const d=await r.json() as {contexts:Record<string,Context>};
          if(!disposed){Object.assign(cache.current,d.contexts);setContexts(v=>({...v,...d.contexts}));}
          failedBatches=Object.values(d.contexts).every(c=>c.status==='unavailable')?failedBatches+1:0;
        }catch{if(!disposed){setContexts(v=>({...v,...Object.fromEntries(batch.map(e=>[e.id,{status:'unavailable',source:'OpenStreetMap',facility:null,land_cover:'unmapped',fetched_at:new Date().toISOString(),note:'OSM lookup failed. Retry enrichment.'}]))}));failedBatches++;}}
        if(failedBatches>=2)break;
        // Sequential bounded batches with spacing respect the shared public service.
        if(queue.length&&!disposed)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,3000);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
      }
      if(!disposed)setWorking(false);
      if(Object.keys(cache.current).length>3000)cache.current=Object.fromEntries(events.filter(e=>cache.current[e.id]).map(e=>[e.id,cache.current[e.id]]));
    })();
    return()=>{disposed=true;controller.abort();};
  },[events,sample,revision]);
  const classified=useMemo(()=>events.map((e,i)=>{const demo=sample?demoIntelligence(i):null;return {...e,classification:classify(e,demo?.context??contexts[e.id],demo?.persistence??history[e.id])};}),[events,sample,contexts,history]);
  const checked=sample?events.length:events.filter(e=>contexts[e.id]?.status==='ready').length;
  return {events:classified,working,checked,historyState:sample?'sample':historyState,prioritize,retry:()=>setRevision(v=>v+1)};
}
