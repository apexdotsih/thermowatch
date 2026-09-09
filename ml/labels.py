"""
ml/labels.py — how to build a REAL labelled training set
=========================================================
train.py currently trains on a physically-synthesised set so a working model
ships today. To train on real data, build a CSV with these columns and pass it
to `python -m ml.train --data labelled.csv`:

    label, frp, bright_ti4, bright_ti5, delta_t, is_night, confidence_num,
    persistence_days, frp_ratio, dist_industry_km, land, abs_lat, month

`label` is one of: industrial_fire, persistent, forest, agriculture, mining
`land`  is one of: forest, crop, industrial, mining, unmapped

HOW TO GENERATE THE LABELS (the answer to "what trains your model?"):

1. Pull historical FIRMS detections for a study period (e.g. 6-12 months over
   India) — you already ingest these into Supabase (thermal_events).

2. Spatially join each detection to independent ground-truth sources:

     INDUSTRIAL / PERSISTENT
       EOG VIIRS Nightfire flare inventory (eogdata.mines.edu).
       Detection within ~1 km of a known flare site -> industrial context.
       Then split: frp_ratio >= 3 and high delta_t -> industrial_fire,
       otherwise -> persistent.

     WILDFIRE
       MODIS MCD64A1 burned-area polygons + forest land cover.
       Detection inside a burned-area polygon in forest -> forest.

     AGRICULTURE
       ESA WorldCover cropland + crop-burning season (Punjab/Haryana Oct-Nov,
       Apr-May). Cropland + burning month -> agriculture.

     MINING
       OSM landuse=quarry / Global Coal Mine Tracker polygons -> mining.

   Detections that match nothing are left UNLABELLED and dropped — we only
   train on confident examples.

3. Compute the feature columns:
       delta_t          = bright_ti4 - bright_ti5
       is_night         = 1 if daynight == 'N' else 0
       confidence_num   = {l:0, n:1, h:2}
       persistence_days = distinct active days at this pixel in the prior 7 days
       frp_ratio        = frp / median historical frp at this pixel
       dist_industry_km = distance to nearest OSM industrial feature
       land             = dominant land-cover class at the pixel
       abs_lat          = abs(latitude)
       month            = acquisition month (1-12)

4. Train with a SPATIAL hold-out (train.py already does this) and report
   per-class precision / recall / F1 + the confusion matrix from ml/metrics.json.

This module is documentation-first on purpose: the joins depend on which
ground-truth rasters you download. Implement the joins with geopandas +
rasterio once the source files are in hand.
"""
