import type { Context, Persistence } from './classification';

// Curated Indian demonstration scenarios, index-aligned with `sampleEvents`.
// Facility names are real installations used as plausible context for the demo;
// the evidence values are fictional fixtures and are never presented as mapped
// OpenStreetMap data or verified incidents.
type Scenario = {
  land: Context['land_cover'];
  facility?: { name: string; kind: string; distance_m: number };
  days?: number; span?: number; baseline?: number; passes?: number;
};

const SCENARIOS: Scenario[] = [
  // 0–5 industrial fire candidates
  { land: 'industrial', facility: { name: 'Reliance Jamnagar Refinery', kind: 'Refinery', distance_m: 1400 }, days: 6, span: 6, baseline: 22, passes: 11 },
  { land: 'industrial', facility: { name: 'Nayara Energy Vadinar Refinery', kind: 'Refinery', distance_m: 860 }, days: 5, span: 5, baseline: 19, passes: 9 },
  { land: 'industrial', facility: { name: 'Tata Steel Jamshedpur', kind: 'Steel Plant', distance_m: 2100 }, days: 6, span: 6, baseline: 26, passes: 12 },
  { land: 'industrial', facility: { name: 'Rourkela Steel Plant', kind: 'Steel Plant', distance_m: 1650 }, days: 5, span: 4, baseline: 18, passes: 8 },
  { land: 'industrial', facility: { name: 'Hazira Industrial Complex, Surat', kind: 'Steel Plant', distance_m: 980 }, days: 5, span: 5, baseline: 21, passes: 10 },
  { land: 'industrial', facility: { name: 'Paradip Refinery (IOCL)', kind: 'Refinery', distance_m: 1250 }, days: 4, span: 4, baseline: 15, passes: 7 },
  // 6–13 persistent thermal sources
  { land: 'industrial', facility: { name: 'Koyali Refinery (IOCL Gujarat)', kind: 'Gas Flare', distance_m: 320 }, days: 7, span: 7, baseline: 19, passes: 14 },
  { land: 'industrial', facility: { name: 'Dahej PCPIR Flare Stack', kind: 'Gas Flare', distance_m: 240 }, days: 7, span: 7, baseline: 17, passes: 13 },
  { land: 'industrial', facility: { name: 'Trombay Refinery, Mumbai', kind: 'Gas Flare', distance_m: 410 }, days: 6, span: 6, baseline: 22, passes: 12 },
  { land: 'industrial', facility: { name: 'Bhilai Steel Plant', kind: 'Steel Plant', distance_m: 780 }, days: 7, span: 7, baseline: 24, passes: 13 },
  { land: 'industrial', facility: { name: 'NALCO Angul Smelter', kind: 'Smelter', distance_m: 540 }, days: 6, span: 5, baseline: 16, passes: 11 },
  { land: 'industrial', facility: { name: 'HPCL Visakh Refinery', kind: 'Gas Flare', distance_m: 360 }, days: 7, span: 7, baseline: 20, passes: 14 },
  { land: 'industrial', facility: { name: 'CPCL Manali Refinery, Chennai', kind: 'Gas Flare', distance_m: 290 }, days: 6, span: 6, baseline: 18, passes: 12 },
  { land: 'industrial', facility: { name: 'Barauni Refinery (IOCL)', kind: 'Gas Flare', distance_m: 470 }, days: 5, span: 5, baseline: 14, passes: 9 },
  // 14–18 mining activity
  { land: 'mining', facility: { name: 'Gevra Opencast Mine, Korba', kind: 'Mining', distance_m: 620 }, days: 6, span: 6, baseline: 30, passes: 11 },
  { land: 'mining', facility: { name: 'Jharia Coalfield', kind: 'Mining', distance_m: 450 }, days: 7, span: 7, baseline: 41, passes: 15 },
  { land: 'mining', facility: { name: 'Talcher Coalfield', kind: 'Mining', distance_m: 830 }, days: 5, span: 5, baseline: 26, passes: 9 },
  { land: 'mining', facility: { name: 'Nigahi Opencast Mine, Singrauli', kind: 'Mining', distance_m: 710 }, days: 6, span: 5, baseline: 33, passes: 10 },
  { land: 'mining', facility: { name: 'Donimalai Iron Ore Mine, Bellary', kind: 'Mining', distance_m: 940 }, days: 4, span: 4, baseline: 22, passes: 7 },
  // 19–26 forest / wildfire
  { land: 'forest', facility: { name: 'Similipal Reserve boundary post', kind: 'Forest Range Office', distance_m: 5200 } },
  { land: 'forest', facility: { name: 'Bandipur Reserve boundary post', kind: 'Forest Range Office', distance_m: 6100 } },
  { land: 'forest', facility: { name: 'Sahyadri Range forest post', kind: 'Forest Range Office', distance_m: 4700 } },
  { land: 'forest', facility: { name: 'Kanha Reserve boundary post', kind: 'Forest Range Office', distance_m: 7300 } },
  { land: 'forest', facility: { name: 'Bastar forest division post', kind: 'Forest Range Office', distance_m: 5800 } },
  { land: 'forest', facility: { name: 'Nilgiris forest division post', kind: 'Forest Range Office', distance_m: 4300 } },
  { land: 'forest', facility: { name: 'Nainital forest division post', kind: 'Forest Range Office', distance_m: 6600 } },
  { land: 'forest', facility: { name: 'Manas Reserve boundary post', kind: 'Forest Range Office', distance_m: 8100 } },
  // 27–35 agricultural burning
  { land: 'agriculture', facility: { name: 'Ludhiana grain market (mandi)', kind: 'Agricultural Facility', distance_m: 3400 } },
  { land: 'agriculture', facility: { name: 'Sangrur grain market (mandi)', kind: 'Agricultural Facility', distance_m: 2900 } },
  { land: 'agriculture', facility: { name: 'Karnal rice mill cluster', kind: 'Agricultural Facility', distance_m: 3100 } },
  { land: 'agriculture', facility: { name: 'Meerut sugar mill', kind: 'Agricultural Facility', distance_m: 4200 } },
  { land: 'agriculture', facility: { name: 'Gorakhpur grain market (mandi)', kind: 'Agricultural Facility', distance_m: 3700 } },
  { land: 'agriculture', facility: { name: 'Muzaffarpur grain market (mandi)', kind: 'Agricultural Facility', distance_m: 4500 } },
  { land: 'agriculture', facility: { name: 'Burdwan rice mill cluster', kind: 'Agricultural Facility', distance_m: 2600 } },
  { land: 'agriculture', facility: { name: 'Nashik agricultural produce yard', kind: 'Agricultural Facility', distance_m: 3900 } },
  { land: 'agriculture', facility: { name: 'Guntur agricultural produce yard', kind: 'Agricultural Facility', distance_m: 3300 } },
];

export function demoIntelligence(index: number): { context: Context; persistence: Persistence } {
  const s = SCENARIOS[index % SCENARIOS.length];
  const repeated = s.days !== undefined;
  return {
    context: {
      status: 'ready', source: 'Synthetic fixture',
      // Only sub-kilometre facilities are treated as proximate by the rules;
      // forest/agricultural landmarks are shown as orientation context only.
      facility: s.facility ? { ...s.facility } : null,
      land_cover: s.land,
      fetched_at: new Date().toISOString(),
      note: 'Curated demonstration scenario. Not mapped OSM data or a verified incident.',
    },
    persistence: {
      status: 'ready',
      days: s.days ?? 1, span_days: s.span ?? 0,
      baseline_frp: s.baseline ?? null, matched_passes: s.passes ?? 1,
      source: repeated ? 'Curated multi-day demonstration history' : 'Curated single-pass demonstration',
    },
  };
}
