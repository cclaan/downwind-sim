"""Game-ready copy of a skinned character GLB: textures resized and stored as JPEG, vertex
data packed (KHR_mesh_quantization: 8-bit normals, tangents and weights, 16-bit UVs),
animation clips dropped. Positions, indices, joints and the skeleton are kept exactly.

The game loads public/characters/<name>-foiler.glb, with 512 px textures on every device
(1024 px looked the same at Retina desktop size, for twice the download). After
re-exporting a character from Blender:

    python3 tools/pack-character.py ~/path/man-foiler.glb public/characters/man-foiler.glb 512

Needs numpy and Pillow. The model must have the Mixamo skeleton names (mixamorig:Hips ...)
and face +Z in its rest pose, as Mixamo and Meshy exports do; see src/render/rider/skinned.ts.
"""
import sys, json, struct, io
import numpy as np
from PIL import Image

DT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def load(p):
    b = open(p, 'rb').read()
    magic, ver, length = struct.unpack_from('<4sII', b, 0)
    assert magic == b'glTF' and ver == 2
    off, js, binc = 12, None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<II', b, off); off += 8
        if ctype == 0x4E4F534A: js = json.loads(b[off:off + clen])
        elif ctype == 0x004E4942: binc = b[off:off + clen]
        off += clen
    return js, binc

def read(js, binc, i):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    dt = np.dtype(DT[a['componentType']]); n = NC[a['type']]
    stride = bv.get('byteStride', dt.itemsize * n)
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    arr = np.ndarray((a['count'], n), dtype=dt, buffer=binc, offset=off, strides=(stride, dt.itemsize)).copy()
    if a.get('normalized'):
        arr = arr.astype(np.float64) / np.iinfo(dt).max
        if dt.kind == 'i': arr = np.maximum(arr, -1.0)
    return a, arr

src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
js, binc = load(src)
out = bytearray()
views, accs = [], []

def put(data, target=None, stride=None):
    out.extend(b'\0' * (-len(out) % 4))
    v = {'buffer': 0, 'byteOffset': len(out), 'byteLength': len(data)}
    if target: v['target'] = target
    if stride: v['byteStride'] = stride
    out.extend(data)
    views.append(v)
    return len(views) - 1

def attr(arr, ctype, typ, normalized=False, minmax=False, vertex=True):
    dt = np.dtype(DT[ctype]); n = NC[typ]
    elem = dt.itemsize * n
    stride = (elem + 3) // 4 * 4 if vertex else None
    a = np.ascontiguousarray(arr.astype(dt))
    if vertex and stride != elem:
        padded = np.zeros((a.shape[0], stride // dt.itemsize), dtype=dt)
        padded[:, :n] = a
        a = padded
    view = put(a.tobytes(), 34962 if vertex else None, stride if vertex else None)
    acc = {'bufferView': view, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
    if normalized: acc['normalized'] = True
    if minmax:
        acc['min'] = [float(x) for x in arr.min(axis=0)]; acc['max'] = [float(x) for x in arr.max(axis=0)]
    accs.append(acc)
    return len(accs) - 1

for mesh in js['meshes']:
    for pr in mesh['primitives']:
        new = {}
        for name, i in pr['attributes'].items():
            a, v = read(js, binc, i)
            if name == 'POSITION':
                new[name] = attr(v.astype(np.float32), 5126, 'VEC3', minmax=True)
            elif name == 'NORMAL':
                v = v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)
                new[name] = attr(np.clip(np.round(v * 127), -127, 127), 5120, 'VEC3', normalized=True)
            elif name == 'TANGENT':
                t = v.astype(np.float64)
                t[:, :3] /= np.maximum(np.linalg.norm(t[:, :3], axis=1, keepdims=True), 1e-9)
                t[:, 3] = np.where(t[:, 3] < 0, -1.0, 1.0)
                new[name] = attr(np.clip(np.round(t * 127), -127, 127), 5120, 'VEC4', normalized=True)
            elif name.startswith('TEXCOORD') and v.min() >= 0 and v.max() <= 1:
                new[name] = attr(np.round(v * 65535), 5123, 'VEC2', normalized=True)
            elif name.startswith('WEIGHTS'):
                w = np.maximum(v.astype(np.float64), 0)
                w /= np.maximum(w.sum(axis=1, keepdims=True), 1e-9)
                q = np.floor(w * 255 + 0.5).astype(np.int32)
                top = q.argmax(axis=1)
                q[np.arange(len(q)), top] += 255 - q.sum(axis=1)
                new[name] = attr(np.clip(q, 0, 255), 5121, 'VEC4', normalized=True)
            elif name.startswith('JOINTS'):
                new[name] = attr(v, 5121 if v.max() < 256 else 5123, 'VEC4')
            else:
                new[name] = attr(v, a['componentType'], a['type'], normalized=a.get('normalized', False))
        pr['attributes'] = new
        if 'indices' in pr:
            a, v = read(js, binc, pr['indices'])
            ct = 5123 if v.max() < 65536 else 5125
            dt = np.dtype(DT[ct])
            view = put(np.ascontiguousarray(v.reshape(-1).astype(dt)).tobytes(), 34963)
            accs.append({'bufferView': view, 'componentType': ct, 'count': int(v.size), 'type': 'SCALAR'})
            pr['indices'] = len(accs) - 1
        pr.pop('targets', None)
for skin in js.get('skins', []):
    if 'inverseBindMatrices' in skin:
        a, v = read(js, binc, skin['inverseBindMatrices'])
        view = put(np.ascontiguousarray(v.astype(np.float32)).tobytes())
        accs.append({'bufferView': view, 'componentType': 5126, 'count': int(v.shape[0]), 'type': 'MAT4'})
        skin['inverseBindMatrices'] = len(accs) - 1

# textures: colour maps as ordinary JPEG, data maps (normal, metal/rough) without chroma subsampling
role = {}
for m in js.get('materials', []):
    pbr = m.get('pbrMetallicRoughness', {})
    for key, info in [('color', pbr.get('baseColorTexture')), ('data', pbr.get('metallicRoughnessTexture')),
                      ('data', m.get('normalTexture')), ('data', m.get('occlusionTexture')), ('color', m.get('emissiveTexture'))]:
        if info: role[js['textures'][info['index']]['source']] = key
sizes = {}
for i, im in enumerate(js.get('images', [])):
    bv = js['bufferViews'][im['bufferView']]
    o = bv.get('byteOffset', 0)
    img = Image.open(io.BytesIO(binc[o:o + bv['byteLength']]))
    if img.mode not in ('RGB', 'L'): img = img.convert('RGB')
    if max(img.size) > size: img = img.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    if role.get(i) == 'color': img.save(buf, 'JPEG', quality=88, optimize=True)
    else: img.save(buf, 'JPEG', quality=92, subsampling=0, optimize=True)
    im['bufferView'] = put(buf.getvalue())
    im['mimeType'] = 'image/jpeg'
    sizes[im.get('name', str(i))] = len(buf.getvalue())

js.pop('animations', None)
js['accessors'] = accs
js['bufferViews'] = views
js['buffers'] = [{'byteLength': len(out)}]
for key in ('extensionsUsed', 'extensionsRequired'):
    js[key] = sorted(set(js.get(key, [])) | {'KHR_mesh_quantization'})
js['asset']['extras'] = {'packed': f'textures {size} px JPEG, vertex data quantized, clips dropped; from {src.split("/")[-1]}'}
j = json.dumps(js, separators=(',', ':')).encode()
j += b' ' * (-len(j) % 4)
out.extend(b'\0' * (-len(out) % 4))
with open(dst, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(j) + 8 + len(out)))
    f.write(struct.pack('<II', len(j), 0x4E4F534A)); f.write(j)
    f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)
tex = sum(sizes.values())
print(f'{dst.split("/")[-1]}: {(28 + len(j) + len(out)) / 1e6:.2f} MB (textures {tex / 1e6:.2f} MB, rest {(len(out) - tex) / 1e6:.2f} MB)')
