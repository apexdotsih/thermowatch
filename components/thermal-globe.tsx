"use client";
import { useEffect, useRef, useState } from "react";
import type { GlobeInstance } from "globe.gl";
import type { Topology, GeometryCollection } from "topojson-specification";
import { CATEGORIES, type ClassifiedEvent } from "@/lib/classification";
import type { ThermalEvent } from "@/lib/thermal";

export default function ThermalGlobe({ events, onSelect, selected, indiaFocus }: { events: ClassifiedEvent[]; indiaFocus: number; onSelect: (event: ThermalEvent) => void; selected: ThermalEvent | null }) {
  const container = useRef<HTMLDivElement>(null);
  const globe = useRef<GlobeInstance | null>(null);
  const current = useRef({ events, onSelect }); current.current = { events, onSelect };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    const host = container.current!;
    (async () => {
      const [{ default: Globe }, { feature }, { default: atlas }] = await Promise.all([
        import("globe.gl"), import("topojson-client"), import("world-atlas/countries-110m.json"),
      ]);
      if (disposed) return;
      const topology = atlas as unknown as Topology<{ countries: GeometryCollection }>;
      const map = feature(topology, topology.objects.countries);
      const g = new Globe(host, { animateIn: false })
        .width(host.clientWidth).height(host.clientHeight).backgroundColor("#080f18")
        .showAtmosphere(true).atmosphereColor("#3e708b").atmosphereAltitude(0.11)
        .showGraticules(true).polygonsData(map.features)
        .polygonCapColor(() => "#192e3b").polygonSideColor(() => "#192e3b")
        .polygonStrokeColor(() => "#385363").polygonAltitude(0.002)
        .pointsData(current.current.events).pointLat("latitude").pointLng("longitude")
        .pointAltitude(0.009).pointRadius(0.18).pointResolution(6).pointsTransitionDuration(0).pointColor(point => CATEGORIES[(point as ClassifiedEvent).classification.category].color)
        .pointLabel(point => { const e = point as ClassifiedEvent; return `${CATEGORIES[e.classification.category].label} · ${e.latitude.toFixed(3)}°, ${e.longitude.toFixed(3)}° · ${e.frp.toFixed(1)} MW`; })
        .onPointClick(point => current.current.onSelect(point as ThermalEvent))
        .pointOfView({lat: 20, lng: 72, altitude: 2.2}, 0);
      const material = g.globeMaterial() as unknown as { color: {set: (c: string) => void} };
      material.color.set("#0e1d29");
      g.controls().enablePan = false;
      g.controls().autoRotate = false;
      globe.current = g;
      observer = new ResizeObserver(() => { if (!disposed) g.width(host.clientWidth).height(host.clientHeight); });
      observer.observe(host);
    })().catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; observer?.disconnect(); globe.current?._destructor(); globe.current = null; host.replaceChildren(); };
  }, []);
  useEffect(() => { globe.current?.pointsData(events); }, [events]);
  useEffect(() => {
    if (selected) globe.current?.pointOfView({lat:selected.latitude,lng:selected.longitude,altitude:1.5},window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700);
  }, [selected]);
  useEffect(() => {
    if (indiaFocus) globe.current?.pointOfView({lat:22,lng:79,altitude:1.5},window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700);
  }, [indiaFocus]);
  return <><div className="globe-canvas" ref={container} aria-label="Drag to rotate the 3D globe. All observations are also accessible in the adjacent list." />{failed && <p className="globe-fallback" role="status">The 3D globe needs WebGL. You can still inspect every observation in the list.</p>}</>;
}
