#!/usr/bin/env python3
"""Fetch a 30 m elevation grid of the Hatchery reach, laid out directly in the level frame
(x downwind along 074 deg true, z toward Oregon), from the public USGS 10 m DEM served by
api.opentopodata.org. Run once; the result is committed next to this script.

    python3 tools/level-source/fetch_dem30.py tools/level-source/dem30_level.npy
"""
import json, math, sys, time, urllib.request
import numpy as np

LAT0, LON0, HEAD = 45.71839108345441, -121.55590853724422, 74.15309804590444
MLAT, MLON = 111145.8, 77853.0
X0, X1, Z0, Z1, STEP = -2700, 2700, -1500, 1500, 30
OUT = sys.argv[1]

h = math.radians(HEAD)
xs = np.arange(X0, X1 + 1, STEP)
zs = np.arange(Z0, Z1 + 1, STEP)
pts = []
for z in zs:
    for x in xs:
        y = -z  # level Y is to the left (Washington); z is to the right (Oregon)
        east = x * math.sin(h) - y * math.cos(h)
        north = x * math.cos(h) + y * math.sin(h)
        pts.append((LAT0 + north / MLAT, LON0 + east / MLON))
print(len(zs), 'rows', len(xs), 'cols', len(pts), 'points', flush=True)
vals = []
B = 100
for i in range(0, len(pts), B):
    chunk = pts[i:i + B]
    url = 'https://api.opentopodata.org/v1/ned10m?locations=' + '|'.join('%.5f,%.5f' % p for p in chunk)
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'generic-geo-lookup/1.0'})
            with urllib.request.urlopen(req, timeout=40) as r:
                d = json.loads(r.read().decode())
            if d.get('status') != 'OK':
                raise RuntimeError(str(d)[:200])
            vals.extend([e['elevation'] if e['elevation'] is not None else float('nan') for e in d['results']])
            break
        except Exception as e:  # noqa
            print('retry', i, attempt, repr(e)[:160], flush=True)
            time.sleep(3 + 3 * attempt)
    else:
        print('FAILED chunk', i, flush=True)
        vals.extend([float('nan')] * len(chunk))
    time.sleep(1.1)
    if (i // B) % 20 == 0:
        print('done', i + len(chunk), '/', len(pts), flush=True)
z = np.array(vals, dtype=np.float32).reshape(len(zs), len(xs))
np.save(OUT, z)
print('saved', OUT, z.shape, float(np.nanmin(z)), float(np.nanmax(z)), flush=True)
