// Runs the exported gradient-boosted model in the browser — no npm deps, no
// server call. Same JSON artifact produced by ml/train.py, so training and
// production use the identical model. If the model is absent or errors, callers
// fall back to the rule engine.
import type { ThermalEvent } from "../thermal";
import type { Context, Persistence, Category } from "../classification";

type Node = {
  leaf: boolean; value: number; feature: number; threshold: number;
  left: number; right: number; missing_left: boolean;
};
type Model = {
  format: string; features: string[]; classes: string[];
  baseline: number[]; learning_rate: number;
  trees: Node[][][]; // [stage][class][node]
  metrics?: any;
};

let MODEL: Model | null = null;
let LOADED = false;

export async function loadModel(): Promise<Model | null> {
  if (LOADED) return MODEL;
  LOADED = true;
  // Model runs in the BROWSER only. It is fetched as a static asset (not bundled
  // into the server/Worker), so the Cloudflare Worker never parses or executes
  // it — this avoids the Worker CPU/memory limit (Error 1102). On the server
  // (no window) we skip loading entirely and callers use the rule engine.
  if (typeof window === "undefined") { MODEL = null; return null; }
  try {
    const res = await fetch("/model.json");
    if (!res.ok) throw new Error("model asset unavailable");
    const data = (await res.json()) as Model;
    if (data && data.format === "thermowatch-hgb-1") MODEL = data;
  } catch {
    MODEL = null; // no model -> rule engine handles everything
  }
  return MODEL;
}

export function modelMetrics() {
  return MODEL?.metrics ?? null;
}

function evalTree(tree: Node[], x: number[]): number {
  let i = 0;
  // guard against malformed trees
  for (let steps = 0; steps < 512; steps++) {
    const n = tree[i];
    if (!n || n.leaf) return n ? n.value : 0;
    const v = x[n.feature];
    const goLeft = Number.isNaN(v) ? n.missing_left : v <= n.threshold;
    i = goLeft ? n.left : n.right;
  }
  return 0;
}

function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((v) => v / s);
}

// Build the same 15-feature vector the trainer used.
function features(
  event: ThermalEvent,
  context: Context | undefined,
  persistence: Persistence | undefined,
  inferredLand: "forest" | "agriculture" | "industrial" | "mining" | "unmapped"
): number[] {
  const ti4 = event.brightness_ti4, ti5 = event.brightness_ti5;
  const delta = ti4 != null && ti5 != null ? ti4 - ti5 : NaN;
  const confMap: Record<string, number> = { l: 0, n: 1, h: 2 };
  const persistDays = persistence?.status === "ready" ? persistence.days : 0;
  const baseline = persistence?.status === "ready" ? persistence.baseline_frp : null;
  const ratio = baseline && baseline > 0 ? event.frp / baseline : 1.0;
  const near = context?.facility && context.facility.distance_m <= 3000 ? context.facility.distance_m : NaN;
  const distKm = Number.isFinite(near) ? (near as number) / 1000 : 40.0;
  const osm = context?.status === "ready" ? context.land_cover : undefined;
  const land = osm && osm !== "unmapped" && osm !== "mixed" ? osm : inferredLand;
  const month = new Date(event.detected_at).getUTCMonth() + 1;

  const map: Record<string, number> = {
    frp: event.frp,
    bright_ti4: ti4 ?? 0,
    bright_ti5: ti5 ?? 0,
    delta_t: Number.isNaN(delta) ? 0 : delta,
    is_night: event.day_night === "N" ? 1 : 0,
    confidence_num: confMap[(event.confidence || "n").toLowerCase()] ?? 1,
    persistence_days: persistDays,
    frp_ratio: ratio,
    dist_industry_km: distKm,
    land_forest: land === "forest" ? 1 : 0,
    land_crop: land === "agriculture" ? 1 : 0,
    land_industrial: land === "industrial" ? 1 : 0,
    land_mining: land === "mining" ? 1 : 0,
    abs_lat: Math.abs(event.latitude),
    month_sin: Math.sin((2 * Math.PI * month) / 12),
  };
  return MODEL!.features.map((f) => map[f] ?? 0);
}

export type MlResult = { category: Category; confidence: number; probs: Record<string, number> };

// Returns null when no model is available -> caller uses the rule engine.
export function predict(
  event: ThermalEvent,
  context: Context | undefined,
  persistence: Persistence | undefined,
  inferredLand: "forest" | "agriculture" | "industrial" | "mining" | "unmapped"
): MlResult | null {
  if (!MODEL) return null;
  try {
    const x = features(event, context, persistence, inferredLand);
    const K = MODEL.classes.length;
    const scores = MODEL.baseline.slice(0, K).map((b) => b);
    const lr = MODEL.learning_rate;
    for (const stage of MODEL.trees) {
      for (let c = 0; c < K; c++) {
        if (stage[c]) scores[c] += lr * evalTree(stage[c], x);
      }
    }
    const probs = softmax(scores);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    const out: Record<string, number> = {};
    MODEL.classes.forEach((cls, i) => (out[cls] = probs[i]));
    return { category: MODEL.classes[best] as Category, confidence: probs[best] * 100, probs: out };
  } catch {
    return null;
  }
}
