"""攻撃の最終フレーム(f59)から待機姿勢(character.png)へ戻る補間フレームをオプティカルフローで生成する。

使い方: python tools/make_return_frames.py [K=12]   (extract_attack.py の後に実行)
出力: assets/attack/r00.webp ... と meta.json の追記(attackN / retN / frames)
依存: pillow numpy opencv-python-headless
f59 は meta の自動オフセット(足ピン)を適用した位置に置いてから補間するので、
補間フレーム自体のオフセットは 0（待機と同じ座標系）。
"""
import json, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent
adir = root / 'assets' / 'attack'
meta = json.loads((adir / 'meta.json').read_text(encoding='utf-8'))
K = int(sys.argv[1]) if len(sys.argv) > 1 else 12
N0 = meta.get('attackN', meta['n'])
meta['frames'] = meta['frames'][:N0]
W, H = meta['crop'][2], meta['crop'][3]
ox, oy = meta['idleOrigin'][0] - meta['crop'][0], meta['idleOrigin'][1] - meta['crop'][1]

# A: 攻撃最終フレーム（足ピンのオフセット適用済み） / B: 待機姿勢
last = Image.open(adir / f'f{N0 - 1:02d}.webp').convert('RGBA')
off = meta['frames'][N0 - 1]['off']
A = Image.new('RGBA', (W, H), (0, 0, 0, 0))
A.alpha_composite(last, (int(round(off[0])), int(round(off[1]))))
B = Image.new('RGBA', (W, H), (0, 0, 0, 0))
B.alpha_composite(Image.open(root / 'assets' / 'character.png').convert('RGBA'), (ox, oy))
A = np.array(A).astype(np.float32); B = np.array(B).astype(np.float32)


def prem(x):
    a = x[..., 3:4] / 255.0
    return np.concatenate([x[..., :3] * a, x[..., 3:4]], axis=2)         # premultiplied RGB + A(0..255)


def gray(x):
    a = x[..., 3:4] / 255.0
    rgb = x[..., :3] * a + 128 * (1 - a)                                 # 灰背景に合成
    g = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    al = (x[..., 3] * 0.35).astype(np.uint8)
    return cv2.addWeighted(g, 0.7, al, 0.3, 0)


ga, gb = gray(A), gray(B)
dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
dis.setPatchSize(12); dis.setPatchStride(4); dis.setVariationalRefinementIterations(10)
F_AB = dis.calc(ga, gb, None)       # A(x) -> B(x+F_AB)  : Aの画素がBでどこへ行くか
F_BA = dis.calc(gb, ga, None)       # B(x) -> A(x+F_BA)
F_AB = cv2.GaussianBlur(F_AB, (0, 0), 3); F_BA = cv2.GaussianBlur(F_BA, (0, 0), 3)

pa, pb = prem(A), prem(B)
gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))


def warp(img, flow, k):
    return cv2.remap(img, gx + flow[..., 0] * k, gy + flow[..., 1] * k, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))


def sstep(x): return x * x * (3 - 2 * x)


for old in adir.glob('r*.webp'):
    old.unlink()
for i in range(K):
    t = sstep((i + 1) / (K + 1))
    # t 時刻の画素 x は、A側では x - t*F_AB 付近、B側では x - (1-t)*F_BA 付近から来る（近似）
    wa = warp(pa, F_BA, t)               # A を t 分だけ B 方向へ
    wb = warp(pb, F_AB, 1 - t)           # B を (1-t) 分だけ A 方向へ
    out = (1 - t) * wa + t * wb
    al = np.clip(out[..., 3], 0, 255)
    rgb = np.where(al[..., None] > 0.5, out[..., :3] / np.maximum(al[..., None] / 255.0, 1e-3), 0)
    rgba = np.concatenate([np.clip(rgb, 0, 255), al[..., None]], axis=2).astype(np.uint8)
    Image.fromarray(rgba, 'RGBA').save(adir / f'r{i:02d}.webp', 'WEBP', quality=92, method=4)
    meta['frames'].append(dict(det=dict(rear=None, front=None), off=[0.0, 0.0], interp=True))

meta['attackN'] = N0; meta['retN'] = K; meta['n'] = N0 + K
(adir / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
print('return frames', K, 'total', meta['n'])
