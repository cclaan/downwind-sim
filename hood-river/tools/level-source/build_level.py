#!/usr/bin/env python3
"""Bake the Hatchery reach into src/sim/levelData.ts.

Inputs (next to this script)
  hatchery-reach.npz   dem60: USGS 10 m DEM sampled every ~60 m on a lat/lon grid;
                       bathy20: water depth from NOAA chart 18532 depth areas and soundings,
                       20 m pixels, 0.15 m units
  dem30_level.npy      the same DEM sampled every 30 m directly in the level frame
                       (fetch_dem30.py), covering the playable reach

Level frame: origin on the river centreline abeam the Hatchery launch; +x downwind along
074 deg true; +z to the right, toward Oregon; heights in metres above the river surface.

Outputs, as base64 typed arrays in a TypeScript module
  coarse grid (60 m): land height, water depth, wave envelope
  fine grid (30 m, playable reach): land height, water depth

    python3 tools/level-source/build_level.py
"""
import base64, json, math, os
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'src', 'sim', 'levelData.ts')

LAT0, LON0, HEAD = 45.71839108345441, -121.55590853724422, 74.15309804590444
MLAT, MLON = 111145.8, 77853.0
H = math.radians(HEAD)

src = np.load(os.path.join(HERE, 'hatchery-reach.npz'))
dem60, lats, lons = src['dem60'], src['dem60_lats'], src['dem60_lons']
bathy = src['bathy20'].astype(np.float32) * 0.15
bmeta = json.loads(str(src['bathy_meta']))
dem30 = np.load(os.path.join(HERE, 'dem30_level.npy'))
POOL = float(np.nanmin(dem60))


def to_latlon(x, z):
    y = -z
    east = x * math.sin(H) - y * math.cos(H)
    north = x * math.cos(H) + y * math.sin(H)
    return LAT0 + north / MLAT, LON0 + east / MLON


def sample_dem60(x, z):
    lat, lon = to_latlon(x, z)
    r = (lat - lats[0]) / (lats[1] - lats[0])
    c = (lon - lons[0]) / (lons[1] - lons[0])
    r = np.clip(r, 0, len(lats) - 1)
    c = np.clip(c, 0, len(lons) - 1)
    return ndimage.map_coordinates(np.nan_to_num(dem60, nan=POOL), [r, c], order=1, mode='nearest') - POOL


def sample_bathy(x, z):
    lat, lon = to_latlon(x, z)
    px = (lon - bmeta['LONA']) * MLON * bmeta['PPM'] / 2.0
    py = (bmeta['LATB'] - lat) * MLAT * bmeta['PPM'] / 2.0
    inside = (px >= 0) & (px <= bathy.shape[1] - 1) & (py >= 0) & (py <= bathy.shape[0] - 1)
    d = ndimage.map_coordinates(bathy, [py, px], order=1, mode='constant', cval=0.0)
    return np.where(inside, d, 0.0)


def smoothstep(e0, e1, v):
    u = np.clip((v - e0) / (e1 - e0), 0, 1)
    return u * u * (3 - 2 * u)


def grid(x0, x1, z0, z1, step):
    xs = np.arange(x0, x1 + 1, step, dtype=np.float64)
    zs = np.arange(z0, z1 + 1, step, dtype=np.float64)
    X, Z = np.meshgrid(xs, zs)
    return xs, zs, X, Z


def fill_depth(depth, water, step):
    """Chart depth where the chart has it; elsewhere in the water, deepen away from shore."""
    shore = ndimage.distance_transform_edt(water) * step
    guess = np.minimum(12.0, 0.4 + shore * 0.05)
    known = water & (depth > 0.05)
    out = np.where(known, depth, guess)
    out = np.where(water, np.maximum(out, 0.3), 0.0)
    return out, shore


# ---------------------------------------------------------------------------------------
# coarse grid: the whole visible gorge
# ---------------------------------------------------------------------------------------
CX0, CX1, CZ0, CZ1, CSTEP = -4320, 6480, -3720, 3300, 60
cxs, czs, CX, CZ = grid(CX0, CX1, CZ0, CZ1, CSTEP)
ch = np.maximum(0.0, sample_dem60(CX, CZ))
cwater = ch < 0.3
cdepth, cshore = fill_depth(sample_bathy(CX, CZ), cwater, CSTEP)
ch = np.where(cwater, 0.0, ch)

# ---------------------------------------------------------------------------------------
# fine grid: the playable reach, already in the level frame
# ---------------------------------------------------------------------------------------
FX0, FX1, FZ0, FZ1, FSTEP = -2700, 2700, -1500, 1500, 30
fxs, fzs, FX, FZ = grid(FX0, FX1, FZ0, FZ1, FSTEP)
assert dem30.shape == FX.shape, (dem30.shape, FX.shape)
fh = np.maximum(0.0, np.nan_to_num(dem30, nan=POOL) - POOL)
fwater = fh < 0.3
fdepth, fshore = fill_depth(sample_bathy(FX, FZ), fwater, FSTEP)
fh = np.where(fwater, 0.0, fh)

# ---------------------------------------------------------------------------------------
# wave envelope (coarse grid): where the bumps are big
#   - the current, and so the steepening, is strongest over the deep channel that hugs
#     Washington; the Oregon third is a sand shelf where everything is smaller
#   - flat in the eddies inshore
#   - fading east of Wells Island, near flat off the Hood River waterfront
# ---------------------------------------------------------------------------------------
fine_shore_on_coarse = ndimage.map_coordinates(
    fshore, [(CZ - FZ0) / FSTEP, (CX - FX0) / FSTEP], order=1, mode='nearest')
in_fine = (CX >= FX0) & (CX <= FX1) & (CZ >= FZ0) & (CZ <= FZ1)
shore = np.where(in_fine, fine_shore_on_coarse, cshore)
fine_depth_on_coarse = ndimage.map_coordinates(
    fdepth, [(CZ - FZ0) / FSTEP, (CX - FX0) / FSTEP], order=1, mode='nearest')
depth = np.where(in_fine, fine_depth_on_coarse, cdepth)

current = np.minimum(1.0, (depth / 18.0) ** (2.0 / 3.0))
size = smoothstep(0.8, 3.5, depth) * (0.5 + 0.5 * current)
inshore = smoothstep(15.0, 130.0, shore)
downrange = 1.0 - 0.72 * smoothstep(1350.0, 2350.0, CX)
SHORE_SCALE = 0.12
env = SHORE_SCALE + (1.0 - SHORE_SCALE) * size * inshore * downrange
env = np.where(shore > 0, env, 0.0)
env = ndimage.gaussian_filter(env, 1.0)
# normalise so the best water off the Hatchery is exactly full size
ref = env[(np.abs(CX) < 400) & (CZ > -480) & (CZ < -120)]
env = np.clip(env / np.percentile(ref, 90), 0, 1)

# ---------------------------------------------------------------------------------------
# write
# ---------------------------------------------------------------------------------------
HEIGHT_UNIT = 0.02
DEPTH_UNIT = 0.15


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode('ascii')


def enc_height(h):
    return b64(np.clip(np.round(h / HEIGHT_UNIT), 0, 65535).astype('<u2'))


def enc_depth(d):
    return b64(np.clip(np.round(d / DEPTH_UNIT), 0, 255).astype(np.uint8))


def enc_unit(v):
    return b64(np.clip(np.round(v * 255), 0, 255).astype(np.uint8))


with open(OUT, 'w') as f:
    f.write('// GENERATED by tools/level-source/build_level.py. Do not edit by hand.\n')
    f.write('// Elevation: USGS 10 m DEM (public domain). Depth: NOAA chart 18532 (public domain).\n')
    f.write('/* eslint-disable */\n')
    f.write('export const LEVEL_DATA = {\n')
    f.write(f'  origin: {{ lat: {LAT0}, lon: {LON0}, headingDeg: {HEAD} }},\n')
    f.write(f'  poolElevation: {POOL:.2f},\n')
    f.write(f'  heightUnit: {HEIGHT_UNIT},\n  depthUnit: {DEPTH_UNIT},\n')
    f.write(f'  coarse: {{ x0: {CX0}, z0: {CZ0}, step: {CSTEP}, nx: {len(cxs)}, nz: {len(czs)},\n')
    f.write(f"    height: '{enc_height(ch)}',\n")
    f.write(f"    depth: '{enc_depth(cdepth)}',\n")
    f.write(f"    env: '{enc_unit(env)}',\n  }},\n")
    f.write(f'  fine: {{ x0: {FX0}, z0: {FZ0}, step: {FSTEP}, nx: {len(fxs)}, nz: {len(fzs)},\n')
    f.write(f"    height: '{enc_height(fh)}',\n")
    f.write(f"    depth: '{enc_depth(fdepth)}',\n  }},\n")
    f.write('} as const\n')

print('pool', POOL)
print('coarse', ch.shape, 'max h', float(ch.max()), 'water', float(cwater.mean()))
print('fine', fh.shape, 'max h', float(fh.max()), 'water', float(fwater.mean()))
print('env at hatchery band:', float(env[(np.abs(CX) < 100) & (np.abs(CZ + 300) < 100)].mean()),
      'mid river:', float(env[(np.abs(CX) < 100) & (np.abs(CZ) < 60)].mean()),
      'oregon shelf:', float(env[(np.abs(CX) < 100) & (np.abs(CZ - 350) < 60)].mean()))
print('wrote', os.path.normpath(OUT), os.path.getsize(OUT), 'bytes')

# quick-look images for checking by eye
try:
    from PIL import Image
    q = os.path.join(HERE, 'preview')
    os.makedirs(q, exist_ok=True)
    def save(name, a, lo, hi):
        im = np.clip((a - lo) / (hi - lo), 0, 1)
        Image.fromarray((im * 255).astype(np.uint8)).resize((a.shape[1] * 4, a.shape[0] * 4), Image.NEAREST).save(os.path.join(q, name))
    save('coarse_height.png', np.sqrt(ch), 0, 29)
    save('coarse_env.png', env, 0, 1)
    save('coarse_depth.png', cdepth, 0, 25)
    save('fine_height.png', np.sqrt(fh), 0, 22)
    save('fine_depth.png', fdepth, 0, 25)
    print('previews in', q)
except Exception as e:  # noqa
    print('no previews:', e)
