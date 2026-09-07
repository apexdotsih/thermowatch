import osmtogeojson from 'osmtogeojson';
import type { Feature, Geometry, Position } from 'geojson';
import { distanceMeters } from '../classification.ts';
import type { Context, Facility } from '../classification';
export type Location = {id:string;latitude:number;longitude:number};
const cache = new Map<string,{expires:number;fetched_at:string;features:Feature[]}>();
export const tileKey = (p:Location) => `${Math.floor(p.latitude*50)},${Math.floor(p.longitude*50)}`;
const offsetLng = (x:number,origin:number) => ((x-origin+540)%360)-180;
function inRing(p:Location, ring:Position[]) {
  let inside=false;
  const unwrapped:number[][]=[];
  for(const v of ring) {
    let x=offsetLng(v[0],p.longitude);
    const previous=unwrapped.at(-1)?.[0];
    if(previous!==undefined){while(x-previous>180)x-=360;while(x-previous< -180)x+=360;}
    unwrapped.push([x,v[1]-p.latitude]);
  }
  for(let i=0,j=unwrapped.length-1;i<unwrapped.length;j=i++) {
    const [xi,yi]=unwrapped[i],[xj,yj]=unwrapped[j];
    if ((yi>0)!==(yj>0) && 0<(xj-xi)*(-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}
export function contains(p:Location,g:Geometry):boolean {
  if(g.type==='Polygon') return inRing(p,g.coordinates[0])&&!g.coordinates.slice(1).some(r=>inRing(p,r));
  if(g.type==='MultiPolygon') return g.coordinates.some(c=>contains(p,{type:'Polygon',coordinates:c}));
  return false;
}
function lineDistance(p:Location,line:Position[]) {
  let min=Infinity;
  const xy=(v:Position)=>[offsetLng(v[0],p.longitude)*111195*Math.cos(p.latitude*Math.PI/180),(v[1]-p.latitude)*111195];
  for(let i=0;i<line.length;i++) {
    min=Math.min(min,distanceMeters(p,{latitude:line[i][1],longitude:line[i][0]}));
    if(i===0) continue;
    const a=xy(line[i-1]),b=xy(line[i]);
    if(Math.abs(offsetLng(line[i-1][0],p.longitude)-offsetLng(line[i][0],p.longitude))>180)continue;
    const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
    const t=den?Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/den)):0;
    min=Math.min(min,Math.hypot(a[0]+t*dx,a[1]+t*dy));
  }
  return min;
}
export function geometryDistance(p:Location,g:Geometry):number {
  if(contains(p,g)) return 0;
  switch(g.type) {
    case 'Point': return distanceMeters(p,{latitude:g.coordinates[1],longitude:g.coordinates[0]});
    case 'MultiPoint': return Math.min(...g.coordinates.map(c=>geometryDistance(p,{type:'Point',coordinates:c})));
    case 'LineString': return lineDistance(p,g.coordinates);
    case 'MultiLineString': case 'Polygon': return Math.min(...g.coordinates.map(r=>lineDistance(p,r)));
    case 'MultiPolygon': return Math.min(...g.coordinates.map(c=>geometryDistance(p,{type:'Polygon',coordinates:c})));
    default:return Infinity;
  }
}
export function contextFromFeatures(p:Location,features:Feature[]):Context {
  let facility:Facility|null=null;
  const cover=new Set<Context['land_cover']>();
  for(const f of features) {
    if(!f.geometry || f.properties?.tainted) continue;
    const t=f.properties?.tags??f.properties??{};
    const kind=t.man_made==='flare' || t.industrial==='flare' ? 'Gas Flare' : t.landuse==='quarry'||t.industrial==='mine' ? 'Mining' : t.power==='plant'&&!['solar','wind','hydro'].includes(t['plant:source']) ? 'Power Plant' : /steel/.test(t.industrial||t.product||'') ? 'Steel Plant' : t.industrial==='furnace'||t.man_made==='kiln' ? 'Furnace / Kiln' : t.man_made==='works'||t.landuse==='industrial'||t.industrial ? 'Industrial Facility' : null;
    if(kind) {
      const distance_m=geometryDistance(p,f.geometry);
      if(distance_m<=2000&&(!facility||distance_m<facility.distance_m)) {
        const id=String(f.id??'');
        facility={name:String(t.name||`Unnamed OSM ${kind.toLowerCase()}`).slice(0,200),kind,distance_m:Math.round(distance_m),...(/^(node|way|relation)\/\d+$/.test(id)?{osm_url:`https://www.openstreetmap.org/${id}`}:{})};
      }
    }
    if(contains(p,f.geometry)) {
      if(t.landuse==='forest'||t.natural==='wood') cover.add('forest');
      if(['farmland','orchard','vineyard','plant_nursery'].includes(t.landuse)) cover.add('agriculture');
      if(t.landuse==='industrial') cover.add('industrial');
      if(t.landuse==='quarry') cover.add('mining');
    }
  }
  return {status:'ready',source:'OpenStreetMap',facility,land_cover:cover.size>1?'mixed':[...cover][0]??'unmapped',fetched_at:new Date().toISOString(),note:'Local OSM polygons, not satellite land-cover imagery. Search radius 2 km; unmapped or large enclosing areas may be absent.'};
}
export async function boundedText(response:Response,maxBytes:number):Promise<string> {
  if(!response.body) throw new Error('Empty response');
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>maxBytes)throw new Error('Response too large');text+=decoder.decode(value,{stream:true});}return text+decoder.decode(); }
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
let cooldownUntil=0;
let primaryUnavailableUntil=0;
let failureNote='OSM is temporarily unavailable.';
let budgetDay='',budgetQueries=0,budgetBytes=0;
const MAX_DAILY_QUERIES=90,MAX_DAILY_BYTES=9*1024*1024;
export async function loadContexts(points:Location[],fetcher:typeof fetch=fetch):Promise<Record<string,Context>> {
  const groups=new Map<string,Location[]>();for(const p of points){const key=tileKey(p);groups.set(key,[...(groups.get(key)??[]),p]);}
  if(groups.size>8) throw new Error('At most eight spatial tiles per request');
  const missing=[...groups.keys()].filter(k=>!cache.has(k)||cache.get(k)!.expires<Date.now());
  const result:Record<string,Context>={};
  try {
    if(missing.length) {
      if(Date.now()<cooldownUntil) throw new Error('OSM cooldown');
      const day=new Date().toISOString().slice(0,10);if(budgetDay!==day){budgetDay=day;budgetQueries=0;budgetBytes=0;}
      if(budgetQueries>=MAX_DAILY_QUERIES||budgetBytes>=MAX_DAILY_BYTES)throw new Error('OSM daily budget reached');
      budgetQueries++;
      const clauses=missing.flatMap(key=>{
        const [lat,lng]=key.split(',').map(Number).map(x=>(x+.5)/50);
        const around=`(around:4000,${lat.toFixed(4)},${lng.toFixed(4)})`;
        return [`nwr${around}[landuse~"^(industrial|quarry|forest|farmland|orchard|vineyard|plant_nursery)$"];`,`nwr${around}[natural=wood];`,`nwr${around}[man_made~"^(works|flare|kiln)$"];`,`nwr${around}[power=plant];`,`nwr${around}[industrial];`];
      }).join('');
      const primary='https://maps.mail.ru/osm/tools/overpass/api/interpreter',secondary='https://overpass-api.de/api/interpreter';
      const endpoints=Date.now()<primaryUnavailableUntil?[secondary]:[primary,secondary];
      let response:Response|undefined;
      for(const endpoint of endpoints) {
        try {
          response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'ThermoWatch/1.0 (+https://thermowatch-ai.mohitknowsgg.chatgpt.site)','Accept':'application/json'},body:new URLSearchParams({data:`[out:json][timeout:20][maxsize:67108864];(${clauses});out geom;`}),signal:AbortSignal.timeout(25000)});
          if(response.ok)break;
          const status=response.status;await response.body?.cancel();
          if(status<500||endpoint===secondary)throw new Error(`OSM HTTP ${status}`);
          primaryUnavailableUntil=Date.now()+10*60000;
        }catch(error){
          if(endpoint===secondary||error instanceof Error&&/^OSM HTTP [234]/.test(error.message))throw error;
          primaryUnavailableUntil=Date.now()+10*60000;
        }
      }
      if(!response?.ok)throw new Error(`OSM HTTP ${response?.status??503}`);
      const body=await boundedText(response,Math.min(8*1024*1024,MAX_DAILY_BYTES-budgetBytes));budgetBytes+=new TextEncoder().encode(body).length;
      const json=JSON.parse(body);
      if(json.remark||!Array.isArray(json.elements))throw new Error('Incomplete OSM response');
      const features=osmtogeojson(json).features;
      // All features belong to this small batch; trim each tile before caching.
      for(const key of missing){const [lat,lng]=key.split(',').map(Number).map(x=>(x+.5)/50);const center={id:key,latitude:lat,longitude:lng};cache.set(key,{expires:Date.now()+6*3600000,fetched_at:new Date().toISOString(),features:features.filter(f=>f.geometry&&geometryDistance(center,f.geometry)<=4000)});}
      while(cache.size>512)cache.delete(cache.keys().next().value!);
    }
  } catch(error) {
    cooldownUntil=Date.now()+60000;
    const message=error instanceof Error?error.message:'Unknown failure';
    failureNote=/^OSM (HTTP [0-9]{3}|daily budget reached|cooldown)$/.test(message)?message:message==='Incomplete OSM response'?'OSM returned a partial response':error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'OSM lookup timed out':'OSM response could not be processed';
    console.warn('osm_context_failure',error instanceof Error?error.name:'Error',message.slice(0,300));
  }
  for(const [key,items]of groups)for(const p of items){const entry=cache.get(key);result[p.id]=entry&&entry.expires>Date.now()?{...contextFromFeatures(p,entry.features),fetched_at:entry.fetched_at}:{status:'unavailable',source:'OpenStreetMap',facility:null,land_cover:'unmapped',fetched_at:new Date().toISOString(),note:`${failureNote}. Retry later; no facility association was inferred.`};}
  return result;
}
