import { test } from 'node:test';
import assert from 'node:assert/strict';
import {classify,CATEGORIES,filterEvents,defaultFilters,summarize,distanceMeters} from '../lib/classification.ts';
import {contextFromFeatures,contains,geometryDistance,loadContexts} from '../lib/server/osm-context.ts';
import {historyCollector} from '../lib/server/thermal-history.ts';
import {exportObservations} from '../lib/export-observations.ts';
import {sampleEvents} from '../lib/thermal.ts';
import {demoIntelligence} from '../lib/demo-intelligence.ts';
const event={...sampleEvents[0],id:'live-example',source:'VIIRS_SNPP_NRT'};
const context={status:'ready',source:'OpenStreetMap',facility:{name:'Steel works',kind:'Steel Plant',distance_m:150},land_cover:'industrial',fetched_at:new Date().toISOString()};
const persistence={status:'ready',days:5,span_days:5,baseline_frp:20,matched_passes:5,source:'test'};
const p={id:'p',latitude:0,longitude:0};
const polygon={type:'Polygon',coordinates:[[[-.02,-.02],[.02,-.02],[.02,.02],[-.02,.02],[-.02,-.02]]]};
test('fictional scenarios classify into valid, substantive categories',()=>{
 const output=sampleEvents.map((e,i)=>{const d=demoIntelligence(i);return {...e,classification:classify(e,d.context,d.persistence)};});
 const cats=new Set(output.map(e=>e.classification.category));
 assert.ok([...cats].every(c=>c in CATEGORIES));
 ['industrial_fire','persistent','forest','agriculture','mining'].forEach(c=>assert.ok(cats.has(c)));
 assert.ok(output.every(e=>e.source==='SYNTHETIC_FIXTURE'&&e.classification.context.source==='Synthetic fixture'));
 const s=summarize(output);assert.equal(s.total,12);assert.equal(s.total,s.industrial+s.persistent+s.natural+s.mining+s.unknown);
});
test('missing/unavailable OSM falls back to geographic + intrinsic classification',()=>{
 assert.equal(classifyRules(event).category,'industrial_fire');assert.equal(classifyRules(event,context).category,'industrial_fire');
 assert.equal(classifyRules(event,{...context,status:'unavailable'},persistence).category,'industrial_fire');
 assert.equal(classifyRules(event,context,{...persistence,days:1}).category,'industrial_fire');
});
test('stable repeated industrial source and FRP anomaly take different paths',()=>{
 assert.equal(classifyRules({...event,frp:21},context,persistence).category,'persistent');
 assert.equal(classifyRules({...event,frp:90},context,persistence).category,'industrial_fire');
 assert.equal(classifyRules({...event,frp:90,brightness_ti4:null},context,persistence).category,'persistent');
 assert.equal(classifyRules({...event,frp:90},context,{...persistence,baseline_frp:null}).category,'industrial_fire');
 assert.ok(classifyRules({...event,frp:90,confidence:'l'},context,persistence).confidence<80);
});
test('land-cover conflicts and nearby industry prevent overconfident natural attribution',()=>{
 assert.equal(classifyRules(event,{...context,land_cover:'mixed'},persistence).category,'unknown');
 assert.equal(classifyRules(event,{...context,land_cover:'forest'},undefined).category,'industrial_fire');
 assert.equal(classifyRules(event,{...context,facility:null,land_cover:'forest'}).category,'forest');
 assert.equal(classifyRules(event,{...context,facility:null,land_cover:'unmapped'}).category,'industrial_fire');
});
test('geometry uses containment, holes and edge distance rather than centroids',()=>{
 assert.equal(contains(p,polygon),true);assert.equal(geometryDistance(p,polygon),0);
 const hole={type:'Polygon',coordinates:[...polygon.coordinates,[[-.001,-.001],[.001,-.001],[.001,.001],[-.001,.001],[-.001,-.001]]]};
 assert.equal(contains(p,hole),false);assert.ok(geometryDistance(p,hole)>100);
 assert.ok(geometryDistance({id:'outside',latitude:0,longitude:.021},polygon)>100);
 assert.ok(geometryDistance({id:'outside',latitude:0,longitude:.021},polygon)<120);
 const seam={type:'Polygon',coordinates:[[[179,-1],[-179,-1],[-179,1],[179,1],[179,-1]]]};
 assert.equal(contains({id:'date',latitude:0,longitude:179.9},seam),true);
 assert.equal(contains(p,seam),false);assert.ok(geometryDistance(p,seam)>19000000);
 assert.ok(distanceMeters({latitude:0,longitude:179.999},{latitude:0,longitude:-179.999})<230);
});
test('OSM actual names, polygon land use and source link are retained',()=>{
 const c=contextFromFeatures(p,[{type:'Feature',id:'way/42',properties:{landuse:'industrial',name:'Example Steel'},geometry:polygon}]);
 assert.equal(c.facility.name,'Example Steel');assert.equal(c.facility.distance_m,0);assert.equal(c.land_cover,'industrial');assert.equal(c.facility.osm_url,'https://www.openstreetmap.org/way/42');
 const outside=contextFromFeatures({id:'out',latitude:.03,longitude:.03},[{type:'Feature',properties:{natural:'wood'},geometry:polygon}]);assert.equal(outside.land_cover,'unmapped');
});
test('OSM server outage falls back, but rate limits do not rotate endpoints',async()=>{
 const calls=[];
 const result=await loadContexts([{id:'fallback',latitude:52.5,longitude:13.4}],async(url)=>{
  calls.push(String(url));
  if(calls.length===1)return new Response('Origin unavailable',{status:521});
  return Response.json({elements:[{type:'node',id:123,lat:52.5,lon:13.4,tags:{man_made:'works',name:'Fixture factory'}}]});
 });
 assert.equal(calls.length,2);assert.ok(calls[1].includes('overpass-api.de'));assert.equal(result.fallback.status,'ready');assert.equal(result.fallback.facility.name,'Fixture factory');
 let limitedCalls=0;
 const limited=await loadContexts([{id:'limited',latitude:52.6,longitude:13.4}],async()=>{limitedCalls++;return new Response('Rate limit',{status:429});});
 assert.equal(limitedCalls,1);assert.equal(limited.limited.status,'unavailable');
});
test('OSM errors do not become no-facility evidence',async()=>{
 const result=await loadContexts([{id:'remote',latitude:48,longitude:11}],async()=>new Response('rate limited',{status:429}));
 assert.equal(result.remote.status,'unavailable');assert.equal(result.remote.facility,null);
});
test('history excludes future and same-day pixels, deduplicates days, and separates sensor/night baseline',()=>{
 const target={...event,latitude:20,longitude:80,detected_at:'2026-01-15T14:24:00Z'};
 const collector=historyCollector([target]);
 for(let day=9;day<=13;day++)for(let pixel=0;pixel<3;pixel++)collector.consume({...target,id:`${day}-${pixel}`,detected_at:`2026-01-${day.toString().padStart(2,'0')}T12:24:00Z`,frp:20});
 collector.consume({...target,detected_at:'2026-01-16T12:24:00Z',frp:1000});
 collector.consume({...target,detected_at:'2026-01-15T12:24:00Z',frp:1000});
 collector.consume({...target,latitude:21,detected_at:'2026-01-08T12:24:00Z',frp:1000});
 collector.consume({...target,day_night:'N',detected_at:'2026-01-12T00:24:00Z',frp:1000});
 const result=collector.finish()[target.id];assert.equal(result.days,5);assert.equal(result.span_days,4);assert.equal(result.baseline_frp,20);assert.equal(result.matched_passes,6);
});
test('history matches locations across spatial tile boundaries',()=>{
 const target={...event,latitude:20.0199,longitude:80.0199};const collector=historyCollector([target]);
 collector.consume({...target,latitude:20.0201,longitude:80.0201,detected_at:'2026-01-12T00:24:00Z'});
 assert.equal(collector.finish()[target.id].days,1);
});
test('combined filters and export use the same visible classified data',()=>{
 const output=sampleEvents.map((e,i)=>{const d=demoIntelligence(i);return {...e,classification:classify(e,d.context,d.persistence)};});
 const filtered=filterEvents(output,{...defaultFilters,highIndustrial:true,minFrp:'50'});
 assert.ok(filtered.length>0);assert.ok(filtered.every(e=>e.classification.category==='industrial_fire'&&e.frp>=50));
 const geo=JSON.parse(exportObservations(filtered,'geojson',true));assert.equal(geo.features.length,filtered.length);assert.deepEqual(geo.features[0].geometry.coordinates,[filtered[0].longitude,filtered[0].latitude]);assert.equal(geo.features[0].properties.synthetic_sample,true);
 filtered[0].classification.context.facility.name='=HYPERLINK("bad")';assert.match(exportObservations(filtered,'csv',true),/'=HYPERLINK/);
 assert.equal(filterEvents(output,{...defaultFilters,minFrp:'100',maxFrp:'10'}).length,0);
});
