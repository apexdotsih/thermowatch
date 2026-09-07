import type { ThermalEvent } from './thermal';

export const RULE_VERSION = 'sih26162-rules-2';
export const CATEGORIES = {
  industrial_fire: { label: 'Industrial Fire', color: '#ef4444' },
  persistent: { label: 'Persistent Thermal Source', color: '#f59e0b' },
  forest: { label: 'Forest / Wildfire', color: '#22c55e' },
  agriculture: { label: 'Agricultural Burning', color: '#eab308' },
  mining: { label: 'Mining Activity', color: '#a855f7' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
} as const;
export type Category = keyof typeof CATEGORIES;
export type Facility = { name: string; kind: string; distance_m: number; osm_url?: string };
export type Context = {
  status: 'ready' | 'unavailable'; source: 'OpenStreetMap' | 'Synthetic fixture';
  facility: Facility | null; land_cover: 'forest' | 'agriculture' | 'industrial' | 'mining' | 'unmapped' | 'mixed';
  fetched_at: string; note?: string;
};
export type Persistence = { status: 'ready' | 'unavailable'; days: number; span_days: number; baseline_frp: number | null; matched_passes: number; source: string };
export type Classification = {
  category: Category; confidence: number | null; subtype?: string; reasons: string[];
  context?: Context; persistence?: Persistence; rule_version: string;
};
export type ClassifiedEvent = ThermalEvent & { classification: Classification };

export function distanceMeters(a: {latitude:number;longitude:number}, b: {latitude:number;longitude:number}): number {
  const rad = Math.PI / 180, dlat=(b.latitude-a.latitude)*rad, dlng=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlng/2)**2;
  return 6371008.8*2*Math.asin(Math.sqrt(Math.min(1,h)));
}

// Geographic land-region fallback. OSM polygons cover only a fraction of fire
// pixels, so when OSM context is unavailable or unmapped we infer coarse land
// context from location. Boxes are [west, south, east, north].
type RegionBox = [number, number, number, number];
const INDUSTRIAL_REGIONS: RegionBox[] = [
  [68.5, 21.5, 70.6, 23.6], [72.3, 20.9, 73.8, 22.7], [72.7, 18.9, 73.1, 19.3],
  [81.0, 21.0, 82.9, 22.7], [84.7, 20.1, 87.1, 21.6], [85.7, 22.5, 87.6, 24.0],
  [82.9, 17.4, 83.5, 18.0], [74.4, 29.7, 75.4, 30.5],
];
const FOREST_REGIONS: RegionBox[] = [
  [73.9, 9.5, 77.3, 16.2], [72.9, 15.4, 74.6, 21.2], [78.0, 18.8, 84.2, 23.6],
  [89.4, 21.9, 97.6, 28.6], [76.9, 29.4, 80.6, 31.6],
];
const CROPLAND_REGIONS: RegionBox[] = [
  [73.7, 27.9, 78.6, 32.1], [78.5, 24.4, 88.1, 28.1], [74.4, 21.4, 80.1, 25.6],
  [74.0, 16.4, 79.1, 21.6], [76.9, 9.9, 82.1, 17.1],
];
const inBox = (lat: number, lon: number, [w, s, e, n]: RegionBox) => lat >= s && lat <= n && lon >= w && lon <= e;
export function inferRegionLand(latitude: number, longitude: number): 'industrial' | 'forest' | 'agriculture' | 'unmapped' {
  if (INDUSTRIAL_REGIONS.some((b) => inBox(latitude, longitude, b))) return 'industrial';
  if (FOREST_REGIONS.some((b) => inBox(latitude, longitude, b))) return 'forest';
  if (CROPLAND_REGIONS.some((b) => inBox(latitude, longitude, b))) return 'agriculture';
  return 'unmapped';
}

// Scores describe rule support, not calibrated probabilities or incident verification.
export function classify(event: ThermalEvent, context?: Context, persistence?: Persistence): Classification {
  const reasons: string[] = [];
  const result = (category: Category, confidence: number | null, subtype?: string): Classification => ({category, confidence: confidence === null ? null : Math.max(0,Math.min(95,confidence-(event.confidence === 'l' ? 20 : 0))), subtype, reasons, context, persistence, rule_version:RULE_VERSION});

  const delta = event.brightness_ti4 !== null && event.brightness_ti5 !== null ? event.brightness_ti4-event.brightness_ti5 : null;
  reasons.push(`${event.frp.toFixed(1)} MW FRP; ${event.day_night === 'N' ? 'night' : 'day'} overpass${delta === null ? '; I4/I5 contrast unavailable' : `; I4-I5 contrast ${delta.toFixed(1)} K`}.`);

  const ready = context?.status === 'ready';
  const osmLand = ready ? context!.land_cover : undefined;
  const near = context?.facility && context.facility.distance_m <= 1000 ? context.facility : null;
  if (context?.facility) reasons.push(`Possible association: ${context.facility.name}, ${Math.round(context.facility.distance_m)} m from its mapped geometry. Proximity does not establish the source.`);

  const repeated = persistence?.status === 'ready' && persistence.days >= 4 && persistence.span_days >= 3;
  const baseline = persistence?.status === 'ready' ? persistence.baseline_frp : null;
  const ratio = baseline !== null && baseline > 0 ? event.frp/baseline : null;
  if (persistence?.status === 'ready' && persistence.days > 1) reasons.push(`Recurring: ${persistence.days} active days, ${persistence.matched_passes} matched overpasses${baseline === null ? '' : `, baseline ${baseline.toFixed(1)} MW`}.`);
  const strong = event.frp >= 30 && delta !== null && delta >= 20;

  if ((!event.frp || event.frp <= 0) && delta === null) {
    reasons.push('No usable FRP or thermal-contrast signal in this detection.');
    return result('unknown', null);
  }
  if (osmLand === 'mixed') {
    reasons.push('Conflicting mapped OSM land uses within the search radius: review required.');
    return result('unknown', null);
  }

  let land: 'forest' | 'agriculture' | 'industrial' | 'mining' | 'unmapped';
  if (ready && osmLand && osmLand !== 'unmapped') {
    land = osmLand as typeof land;
  } else {
    land = inferRegionLand(event.latitude, event.longitude);
    if (land !== 'unmapped') reasons.push(`No mapped OSM polygons here; geographic land-region inference: ${land}.`);
  }

  const industrialContext = (near !== null && near.kind !== 'Mining') || land === 'industrial';

  if (land === 'mining' || near?.kind === 'Mining') {
    reasons.push('Thermal activity within a quarry/coalfield: mining-related heat source.');
    return result('mining', 72 + (repeated ? 6 : 0) + (osmLand === 'mining' ? 4 : 0));
  }

  if (industrialContext) {
    if (repeated && ratio !== null && ratio >= 3 && strong) {
      reasons.push(`FRP is ${ratio.toFixed(1)}x the site baseline — an abnormal thermal event at an industrial site, not routine operation.`);
      return result('industrial_fire', 84 + (event.confidence === 'h' ? 4 : 0));
    }
    if (strong && event.frp >= 50) {
      reasons.push('High radiative power with strong thermal contrast at an industrial site: candidate industrial fire.');
      return result('industrial_fire', 70 + (event.day_night === 'N' ? 4 : 0));
    }
    reasons.push(repeated ? 'Steady output recurring at the same location: consistent with a continuous flare or smelter, not a wildfire.' : 'Industrial context; treated as an operational thermal source pending temporal evidence.');
    return result('persistent', (repeated ? 80 : 64) + (event.day_night === 'N' ? 3 : 0), near?.kind);
  }

  if (land === 'forest') {
    reasons.push('Transient high-intensity heat in forest cover: consistent with an active wildfire.');
    return result('forest', 72 + (event.frp >= 20 ? 5 : 0) + (delta !== null && delta >= 10 ? 3 : 0) + (event.day_night === 'N' ? 2 : 0));
  }

  if (land === 'agriculture') {
    reasons.push('Low-power daytime heat over cropland: consistent with crop-residue burning.');
    return result('agriculture', (event.day_night === 'D' ? 74 : 66) + (event.frp < 30 ? 4 : 0));
  }

  if (strong || event.frp >= 30) {
    reasons.push('No mapped or regional land context; a large/hot thermal anomaly is most consistent with an active vegetation fire.');
    return result('forest', 58 + (event.day_night === 'N' ? 3 : 0));
  }
  if (event.frp > 0) {
    if (event.day_night === 'D') {
      reasons.push('No mapped context; a small daytime thermal anomaly is most consistent with agricultural/land-clearing burning.');
      return result('agriculture', 55);
    }
    reasons.push('No mapped context; a small nighttime thermal anomaly attributed to a generic vegetation fire.');
    return result('forest', 54);
  }
  reasons.push('Available evidence does not distinguish a source category.');
  return result('unknown', null);
}

export type ObservationFilters = { category: Category | 'all'; minFrp: string; maxFrp: string; dayNight: 'all'|'D'|'N'; highIndustrial: boolean };
export const defaultFilters: ObservationFilters = {category:'all',minFrp:'',maxFrp:'',dayNight:'all',highIndustrial:false};
export function filterEvents(events: ClassifiedEvent[], filters: ObservationFilters): ClassifiedEvent[] {
  return events.filter(e=>(filters.category==='all'||e.classification.category===filters.category)
    && (filters.minFrp===''||e.frp>=Number(filters.minFrp)) && (filters.maxFrp===''||e.frp<=Number(filters.maxFrp))
    && (filters.dayNight==='all'||e.day_night===filters.dayNight)
    && (!filters.highIndustrial||(['industrial_fire','persistent','mining'].includes(e.classification.category)&&(e.classification.confidence??0)>=80)));
}
export function summarize(events: ClassifiedEvent[]) {
  return {total:events.length,industrial:events.filter(e=>e.classification.category==='industrial_fire').length,persistent:events.filter(e=>e.classification.category==='persistent').length,natural:events.filter(e=>['forest','agriculture'].includes(e.classification.category)).length,mining:events.filter(e=>e.classification.category==='mining').length,unknown:events.filter(e=>e.classification.category==='unknown').length};
}
