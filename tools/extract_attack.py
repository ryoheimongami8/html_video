"""攻撃GIFを連番WebPに分解し、足(サンダル)位置を検出して足固定オフセットを自動算出する。

使い方: python tools/extract_attack.py <input.gif> [--meta]  (--meta は meta.json のみ再計算)
出力: assets/attack/f00.webp ... と assets/attack/meta.json
依存: pillow numpy scipy
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageSequence, ImageFilter
from scipy import ndimage as ndi

src = Path(sys.argv[1])
out = Path(__file__).resolve().parent.parent / 'assets' / 'attack'
out.mkdir(parents=True, exist_ok=True)

im = Image.open(src)
dur = im.info.get('duration', 40)
frames = [f.convert('RGBA').copy() for f in ImageSequence.Iterator(im)]
arr = [np.array(f) for f in frames]
N = len(frames)

# 共通クロップ（全フレームの不透明領域の和）
x0 = y0 = 10**9; x1 = y1 = 0
for a in arr:
    ys, xs = np.where(a[..., 3] > 16)
    x0, x1 = min(x0, xs.min()), max(x1, xs.max() + 1)
    y0, y1 = min(y0, ys.min()), max(y1, ys.max() + 1)
pad = 6
x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
x1, y1 = min(im.width, x1 + pad), min(im.height, y1 + pad)


def sandals(a):
    al = a[..., 3] > 128
    dark = al & (a[..., 0] < 80) & (a[..., 1] < 80) & (a[..., 2] < 125)
    lab, _ = ndi.label(dark)
    bot = np.where(al)[0].max()
    res = []
    for k, sl in enumerate(ndi.find_objects(lab), 1):
        h = sl[0].stop - sl[0].start; w = sl[1].stop - sl[1].start
        ar = int((lab[sl] == k).sum())
        if 1200 < ar < 4000 and 55 < w < 140 and h < 82 and sl[0].stop > bot - 150:
            res.append(((sl[1].start + sl[1].stop) / 2, sl[0].stop, w, h, ar))
    return sorted(res)


# 基準姿勢（フレーム0）: 後ろ足 R / 前足 F の接地点
s0 = sandals(arr[0])
F0, R0 = s0[0], s0[-1]
REF = dict(rear=[R0[0], R0[1]], front=[F0[0], F0[1]])

det = []
for i, a in enumerate(arr):
    s = sandals(a)
    rear = next((c for c in reversed(s) if c[0] > 650), None)
    front = next((c for c in s if c[0] < 650), None)
    det.append(dict(rear=[rear[0], rear[1]] if rear else None, front=[front[0], front[1]] if front else None))

# 後ろ足ピン: 検出できたフレームは後ろ足を基準位置へ、無いフレームは前足でdyのみ推定→dxは補間
dx = [None] * N; dy = [None] * N
for i, d in enumerate(det):
    if d['rear']:
        dx[i] = REF['rear'][0] - d['rear'][0]; dy[i] = REF['rear'][1] - d['rear'][1]
    elif d['front']:
        dy[i] = REF['front'][1] - d['front'][1] if i > 11 else 0.0
for i in range(0, 9):
    dx[i] = 0.0; dy[i] = 0.0                 # 待機姿勢の区間
for i in (9, 10, 11):
    dx[i] = 0.0; dy[i] = 0.0


def fill(v):
    idx = [i for i, x in enumerate(v) if x is not None]
    return [float(np.interp(i, idx, [v[k] for k in idx])) for i in range(N)]


dx = fill(dx); dy = fill(dy)


def med3(v):
    return [float(np.median(v[max(0, i - 1):i + 2])) for i in range(N)]


raw_dx, raw_dy = list(dx), list(dy)
dx = med3(dx); dy = med3(dy)
for i, d in enumerate(det):                       # 検出できたフレームは中央値でなまさず実測値を使う
    if d['rear'] and i >= 12:
        dx[i], dy[i] = raw_dx[i], raw_dy[i]
# 着地区間（23-35, 50-59）は区間中央値で固定してブレを消す
for a_, b_ in ((23, 35), (50, 59)):
    mx, my = float(np.median(dx[a_:b_ + 1])), float(np.median(dy[a_:b_ + 1]))
    for i in range(a_, b_ + 1):
        dx[i], dy[i] = mx, my

META_ONLY = '--meta' in sys.argv
for i, f in enumerate(frames):
    if META_ONLY:
        break
    c = f.crop((x0, y0, x1, y1))
    a = c.getchannel('A').filter(ImageFilter.GaussianBlur(0.7))   # GIFの1bitアルファの縁を軽く滑らかに
    c.putalpha(a)
    c.save(out / f'f{i:02d}.webp', 'WEBP', quality=92, method=6)

meta = dict(n=N, frameMs=dur, crop=[int(x0), int(y0), int(x1 - x0), int(y1 - y0)], ref=REF,
            idleOrigin=[409, 0],
            frames=[dict(det=det[i], off=[round(dx[i], 1), round(dy[i], 1)]) for i in range(N)])
(out / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
print('frames', N, 'crop', meta['crop'], 'ref', REF)
for i in range(N):
    print(i, det[i]['rear'] and [round(v) for v in det[i]['rear']], det[i]['front'] and [round(v) for v in det[i]['front']], meta['frames'][i]['off'])
