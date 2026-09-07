import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicFeed, parseObservation, readFeed } from '../lib/server/observation-feed.ts';

const row = {latitude:'23.12',longitude:'72.61',bright_ti4:'330.2',scan:'.42',track:'.39',acq_date:'2026-09-06',acq_time:'3',satellite:'N',confidence:'nominal',version:'2.0NRT',bright_ti5:'294.8',frp:'18.4',daynight:'N'};
const now = Date.parse('2026-09-06T01:00:00Z');
const csv = rows => Object.keys(row).join(',')+'\n'+rows.map(r=>Object.keys(row).map(k=>r[k]).join(',')).join('\n');

test('NASA full confidence labels and short UTC times normalize without inventing ingestion', () => {
  const result = parseObservation(row,new Date(now).toISOString());
  assert.equal(result.confidence,'n'); assert.equal(result.detected_at,'2026-09-06T00:03:00Z');
  assert.equal(result.ingested_at,null); assert.equal(result.frp,18.4);
});
test('streaming parser handles chunk boundaries, filters the window, sorts, and reports invalid rows', async () => {
  const text = csv([row,{...row,acq_time:'4'},{...row,acq_date:'2026-09-01'},{...row,frp:'NaN'}]);
  const stream = new ReadableStream({start(c){for(let i=0;i<text.length;i+=13)c.enqueue(new TextEncoder().encode(text.slice(i,i+13)));c.close();}});
  const result = await parsePublicFeed(new Response(stream),24,now);
  assert.equal(result.events.length,2); assert.equal(result.count,2); assert.equal(result.events[0].detected_at,'2026-09-06T00:04:00Z');assert.equal(result.rejected_rows,1);
});
test('NASA error pages are not interpreted as an empty success', async () => {
  await assert.rejects(parsePublicFeed(new Response('<html>Unavailable</html>'),24,now));
});
test('impossible dates and nonfinite values are rejected', () => {
  for(const delta of [{acq_date:'2026-02-30'},{acq_time:'2400'},{longitude:'Infinity'},{confidence:'87'}])assert.throws(()=>parseObservation({...row,...delta},new Date(now).toISOString()));
});
test('globe payload stays bounded for large source files and preserves newest records', async () => {
  const rows=Array.from({length:9000},(_,i)=>({...row,longitude:String(i/100),acq_time:String(i%60).padStart(4,'0')}));
  const result=await parsePublicFeed(new Response(csv(rows)),24,now);
  assert.equal(result.events.length,2000);assert.equal(result.count,9000);assert.equal(result.truncated,true);
  assert.equal(result.events[0].detected_at,'2026-09-06T00:59:00Z');
});
test('configured Supabase is queried with a server-only key and exact count', async () => {
  let called=false;
  const page=await readFeed({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test'}, {hours:24,limit:1000,offset:0}, async(url,init)=>{
    called=true;assert.equal(new URL(url).hostname,'example.supabase.co');assert.equal(init.headers.apikey,'sb_secret_test');assert.equal(init.headers.Authorization,undefined);
    return Response.json([parseObservation(row,new Date(now).toISOString())],{headers:{'content-range':'0-0/1'}});
  });
  assert.ok(called);assert.equal(page.source_mode,'supabase');assert.equal(page.persistence,'connected');assert.equal(page.events.length,1);
});
test('unconfigured feed fetches real NASA; configured database failure is explicitly identified', async () => {
  const fresh={...row,acq_date:new Date().toISOString().slice(0,10),acq_time:'0'};
  const urls=[];
  const fake=async(url)=>{urls.push(String(url)); if(String(url).includes('supabase'))return new Response('',{status:503}); return new Response(csv([fresh]));};
  const result=await readFeed({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test'}, {hours:24,limit:1000,offset:0},fake);
  assert.equal(result.source_mode,'nasa_public');assert.equal(result.persistence,'unavailable');assert.ok(urls.some(u=>u.startsWith('https://firms.modaps.eosdis.nasa.gov/')));assert.ok(result.events.every(e=>!e.id.startsWith('synthetic')));
});
