import { distanceMeters } from '../classification.ts';
import type { Persistence } from '../classification';
import type { ThermalEvent } from '../thermal';
import { parsePublicFeed } from './observation-feed.ts';
export type HistoryTarget=Pick<ThermalEvent,'id'|'latitude'|'longitude'|'detected_at'|'satellite'|'day_night'>;
const key=(lat:number,lng:number)=>`${Math.floor(lat*50)},${Math.floor((((lng+180)%360+360)%360-180)*50)}`;
const median=(v:number[])=>{v.sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
export function historyCollector(targets:HistoryTarget[]) {
  const grid=new Map<string,HistoryTarget[]>();
  const stats=new Map(targets.map(t=>[t.id,{days:new Set<string>(),passes:new Set<string>(),baseline:new Map<string,number>()}]));
  for(const t of targets) {
    // Polar targets are left unavailable rather than using a misleading planar match.
    if(Math.abs(t.latitude)>85)continue;
    const dlat=.0068,dlng=dlat/Math.cos(t.latitude*Math.PI/180),keys=new Set<string>();
    for(let y=Math.floor((t.latitude-dlat)*50);y<=Math.floor((t.latitude+dlat)*50);y++)for(let x=Math.floor((t.longitude-dlng)*50);x<=Math.floor((t.longitude+dlng)*50);x++)keys.add(key((y+.5)/50,(x+.5)/50));
    for(const k of keys)grid.set(k,[...(grid.get(k)??[]),t]);
  }
  return {
    consume(e:ThermalEvent) {
      for(const t of grid.get(key(e.latitude,e.longitude))??[]) {
        const age=(Date.parse(t.detected_at)-Date.parse(e.detected_at))/86400000;
        if(age<1||age>7||distanceMeters(t,e)>750)continue;
        const s=stats.get(t.id)!,day=e.detected_at.slice(0,10),pass=`${e.satellite}:${e.detected_at.slice(0,13)}:${e.day_night}`;
        s.days.add(day);s.passes.add(pass);
        // A single pixel cluster cannot count as multiple active days. Use daily maximum
        // FRP then median across comparable days to avoid pixel-count weighting.
        if(e.satellite===t.satellite&&e.day_night===t.day_night)s.baseline.set(day,Math.max(s.baseline.get(day)??0,e.frp));
      }
    },
    finish():Record<string,Persistence> {
      return Object.fromEntries(targets.map(t=>{const s=stats.get(t.id)!,days=[...s.days].sort(),values=[...s.baseline.values()];return [t.id,{status:Math.abs(t.latitude)>85?'unavailable':'ready',days:days.length,span_days:days.length>1?(Date.parse(days.at(-1)!)-Date.parse(days[0]))/86400000:0,baseline_frp:values.length>=3?median(values):null,matched_passes:s.passes.size,source:'NASA S-NPP current 7-day public feed; historical coverage is shorter for older observations'}];}));
    },
  };
}
const cached=new Map<string,{expires:number;value:Record<string,Persistence>}>();
const pending=new Map<string,Promise<Record<string,Persistence>>>();
export async function loadHistory(targets:HistoryTarget[],fetcher:typeof fetch=fetch) {
  const signature=JSON.stringify(targets);
  const hit=cached.get(signature);if(hit&&hit.expires>Date.now())return hit.value;
  if(pending.has(signature))return pending.get(signature)!;
  const task=(async()=>{
    const collector=historyCollector(targets);
    const response=await fetcher('https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_7d.csv',{signal:AbortSignal.timeout(55000)});
    await parsePublicFeed(response,168,Date.now(),collector.consume);
    const value=collector.finish();cached.set(signature,{value,expires:Date.now()+300000});while(cached.size>4)cached.delete(cached.keys().next().value!);return value;
  })();pending.set(signature,task);try{return await task;}finally{pending.delete(signature);}
}
