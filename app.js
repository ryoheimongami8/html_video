'use strict';
/* 待機ループ — 1枚絵から生成するプロシージャル待機モーション
 * ・キャラは WebGL メッシュ変形、背景/エフェクトは Canvas2D
 * ・足は「全ての動きを合成した後」に元座標へ強制代入して固定
 * ・全周期は LOOP_T(14.4s) の約数 → 継ぎ目なしループ
 */

// ---------- 基本定数 ----------
const W = 1280, H = 720;
const CH = { w: 524, h: 776 };            // キャラ画像サイズ
const TAU = Math.PI * 2;
const LOOP_T = 14.4;                       // 演出・エフェクト共通の全体ループ秒
const COLS = 44, ROWS = 64;
const NV = (COLS + 1) * (ROWS + 1);
const FOOT_RECTS = [                       // 足固定マスク [x0,y0,x1,y1]（画像座標）
  [10, 616, 135, CH.h],
  [385, 616, 500, CH.h],
];
const FOOT_ANCHORS = [[72, 722], [440, 728]];
const SWORD = { a: [148, 258], b: [492, 520] };
const LS_KEY = 'html_video_idle_v1';
const GH_DEF = { on: true, mode: 'grad', c1: '#4de1ff', c2: '#a35cff', count: 7, step: 2, opacity: 0.6, glow: true };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (v) => v - Math.floor(v);
const SIN = (k, p, ph) => Math.sin(TAU * (k * p + (ph || 0)));
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 幾何ヘルパ ----------
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
function polySoft(poly, x, y, f) {   // 内側で 1、輪郭から f 外で 0 になる滑らかな重み
  let inside = false, md = 1e9;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    md = Math.min(md, distSeg(x, y, xi, yi, xj, yj));
  }
  return sstep(-f, f, inside ? md : -md);
}
function rectDist(x, y, r) {
  const dx = Math.max(r[0] - x, 0, x - r[2]);
  const dy = Math.max(r[1] - y, 0, y - r[3]);
  return Math.hypot(dx, dy);
}

// ---------- 部位マスク（画像座標） ----------
const HAIR = [[245, 55], [285, 95], [330, 140], [400, 170], [470, 185], [500, 235], [495, 270], [470, 340], [440, 350], [395, 335], [350, 300], [320, 260], [300, 200], [265, 150], [240, 100]];
const RIB = [[285, 75], [340, 80], [405, 115], [400, 160], [345, 150], [295, 110]];
const BOW = [[205, 10], [295, 20], [295, 115], [230, 110], [205, 60]];
const OBI = [[322, 248], [372, 250], [405, 330], [420, 395], [395, 392], [350, 345], [328, 290]];
const SLR = [[295, 160], [330, 175], [385, 240], [405, 330], [440, 410], [485, 510], [470, 530], [400, 480], [330, 420], [300, 330], [285, 240]];
const SLL = [[128, 215], [170, 210], [190, 260], [170, 330], [150, 440], [125, 440], [122, 330], [125, 250]];

// ---------- メッシュと静的重み ----------
const S = {
  rest: new Float32Array(NV * 2), uv: new Float32Array(NV * 2),
  fl: new Float32Array(NV), hard: new Uint8Array(NV),
  wt: new Float32Array(NV), wHead: new Float32Array(NV),
  wHair: new Float32Array(NV), hairD: new Float32Array(NV),
  wRib: new Float32Array(NV), ribD: new Float32Array(NV), wBow: new Float32Array(NV),
  wObi: new Float32Array(NV), obiD: new Float32Array(NV),
  wSlR: new Float32Array(NV), slRD: new Float32Array(NV),
  wSlL: new Float32Array(NV), slLD: new Float32Array(NV),
  wSkirt: new Float32Array(NV), wSword: new Float32Array(NV), wWatch: new Float32Array(NV),
  index: null,
};
(function buildMesh() {
  for (let j = 0; j <= ROWS; j++) {
    for (let i = 0; i <= COLS; i++) {
      const n = j * (COLS + 1) + i;
      const x = (i / COLS) * CH.w, y = (j / ROWS) * CH.h;
      S.rest[n * 2] = x; S.rest[n * 2 + 1] = y;
      S.uv[n * 2] = i / COLS; S.uv[n * 2 + 1] = j / ROWS;
      let d = 1e9;
      for (const r of FOOT_RECTS) d = Math.min(d, rectDist(x, y, r));
      S.hard[n] = d === 0 ? 1 : 0;
      S.fl[n] = d === 0 ? 1 : 1 - sstep(0, 30, d);
      S.wt[n] = 1 - sstep(300, 600, y);
      S.wHead[n] = 1 - sstep(170, 215, y);
      S.hairD[n] = Math.hypot(x - 255, y - 115);
      S.wHair[n] = polySoft(HAIR, x, y, 14) * sstep(45, 260, S.hairD[n]);
      S.ribD[n] = Math.hypot(x - 285, y - 88);
      S.wRib[n] = polySoft(RIB, x, y, 8) * sstep(5, 120, S.ribD[n]);
      S.wBow[n] = polySoft(BOW, x, y, 8);
      S.obiD[n] = Math.hypot(x - 335, y - 250);
      S.wObi[n] = polySoft(OBI, x, y, 8) * sstep(5, 120, S.obiD[n]);
      S.slRD[n] = Math.hypot(x - 300, y - 170);
      S.wSlR[n] = polySoft(SLR, x, y, 12) * sstep(20, 330, S.slRD[n]);
      S.slLD[n] = Math.hypot(x - 170, y - 215);
      S.wSlL[n] = polySoft(SLL, x, y, 12) * sstep(10, 220, S.slLD[n]);
      S.wSkirt[n] = sstep(430, 650, y);
      S.wSword[n] = 1 - sstep(18, 32, distSeg(x, y, SWORD.a[0], SWORD.a[1], SWORD.b[0], SWORD.b[1]));
      S.wWatch[n] = 1 - sstep(22, 32, distSeg(x, y, 222, 322, 222, 372));
    }
  }
  const idx = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    const a = j * (COLS + 1) + i, b = a + 1, c = a + COLS + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  S.index = new Uint16Array(idx);
})();

// ---------- 演出プリセット ----------
// T は LOOP_T の約数、breath.k は整数 → 継ぎ目なしループ
const PRESETS = [
  { id: 'calm', name: '穏やか呼吸', desc: '基本の待機。呼吸と髪・裾のやわらかい揺れ', T: 7.2,
    breath: { amp: 2.6, k: 2 }, head: 1, hair: 1, cloth: 1, skirt: 1, lean: 0, tremor: 0, wind: 0, flutter: 0, watch: 1, grade: null, vig: 0 },
  { id: 'gale', name: '疾風', desc: '強い風。髪・袖・裾が大きくなびく', T: 4.8,
    breath: { amp: 1.8, k: 3 }, head: 1.2, hair: 2.0, cloth: 2.0, skirt: 2.2, lean: 0, tremor: 0, wind: 1, flutter: 1, watch: 1.6,
    grade: { fill: 'rgba(130,210,255,0.13)', op: 'source-over' }, vig: 0.1 },
  { id: 'ready', name: '臨戦', desc: '呼吸が速く上体が前後。緊張感のある構え', T: 7.2,
    breath: { amp: 3.2, k: 3 }, head: 0.7, hair: 1.4, cloth: 1.2, skirt: 1.2, lean: 2.2, tremor: 0, wind: 0.2, flutter: 0, watch: 1.2,
    grade: { fill: 'rgba(255,80,50,0.11)', op: 'source-over' }, vig: 0.3 },
  { id: 'dream', name: '夢見', desc: 'ゆっくり大きく漂う。淡いパステル調', T: 14.4,
    breath: { amp: 3.4, k: 2 }, head: 1.5, hair: 1.8, cloth: 1.7, skirt: 1.7, lean: 0, tremor: 0, wind: 0.3, flutter: 0, watch: 1.4,
    grade: { fill: 'rgba(255,190,255,0.16)', op: 'source-over' }, vig: 0.1 },
  { id: 'focus', name: '集中', desc: '動きを抑え微振動。彩度を落として暗く絞る', T: 7.2,
    breath: { amp: 1.4, k: 1 }, head: 0.4, hair: 0.5, cloth: 0.5, skirt: 0.5, lean: 0, tremor: 0.7, wind: 0, flutter: 0, watch: 0.5,
    grade: { fill: 'rgba(0,0,30,0.26)', op: 'source-over', desat: 0.35 }, vig: 0.55 },
];
const BASE = Object.assign({}, PRESETS[0], { id: 'base', grade: null, vig: 0 });

// ---------- 変位計算 ----------
let idleBlend = 1;
const bufA = { x: new Float32Array(NV), y: new Float32Array(NV) };
const bufB = { x: new Float32Array(NV), y: new Float32Array(NV) };
const pos = new Float32Array(NV * 2);

function evalPreset(P, p, ox, oy) {
  const R = S.rest;
  const b = SIN(P.breath.k, p);
  const bHead = SIN(P.breath.k, p, -0.08);
  const th = P.head * 0.010 * SIN(P.breath.k, p, -0.15);
  const cth = Math.cos(th), sth = Math.sin(th);
  const leanS = P.lean * SIN(1, p, 0.1);
  const trX = P.tremor * SIN(13, p), trY = P.tremor * 0.6 * SIN(17, p, 0.3);
  const thW = P.watch * 0.07 * SIN(2, p, -0.3);
  const cw = Math.cos(thW), sw = Math.sin(thW);
  // 刀は剛体：手元(体幹)の変位をそのまま平行移動
  const rigX = leanS + trX, rigY = -P.breath.amp * b + trY;

  for (let n = 0; n < NV; n++) {
    const x = R[n * 2], y = R[n * 2 + 1];
    const wt = S.wt[n];
    let dx = leanS * wt + trX * wt;
    let dy = -P.breath.amp * wt * b + trY * wt;

    // 頭（首を軸に回転＋上下）
    const wh = S.wHead[n];
    if (wh > 0) {
      const rx = x - 205, ry = y - 180;
      dx += wh * ((cth - 1) * rx - sth * ry);
      dy += wh * (sth * rx + (cth - 1) * ry) - wh * P.head * 0.8 * bHead;
    }
    // 髪（根元から遅れて伝わる進行波）
    let w = S.wHair[n];
    if (w > 0) {
      const ph = S.hairD[n] / 520;
      dy += P.hair * 7 * w * (0.65 * SIN(1, p, -ph) + 0.35 * SIN(3, p, -ph * 1.5 + 0.2)) + P.flutter * 2.5 * w * SIN(5, p, -ph * 2);
      dx += P.hair * 4.5 * w * (0.6 * SIN(2, p, -ph * 1.2 + 0.15) + 0.4 * SIN(1, p, -ph)) + P.wind * 6 * w * (0.5 + 0.5 * SIN(1, p, -ph));
    }
    // リボン
    w = S.wRib[n];
    if (w > 0) {
      const ph = S.ribD[n] / 200;
      dy += P.hair * 6 * w * SIN(2, p, -ph + 0.1);
      dx += P.hair * 5 * w * SIN(1, p, -ph) + P.wind * 6 * w * (0.5 + 0.5 * SIN(1, p, -ph));
    }
    w = S.wBow[n];
    if (w > 0) dy += P.hair * 1.2 * w * SIN(2, p, 0.3);
    // 帯の結び
    w = S.wObi[n];
    if (w > 0) {
      const ph = S.obiD[n] / 150;
      dx += P.cloth * 3.5 * w * SIN(1, p, -ph + 0.2) + P.wind * 3 * w;
      dy += P.cloth * 3 * w * SIN(2, p, -ph);
    }
    // 袖
    w = S.wSlR[n];
    if (w > 0) {
      const ph = S.slRD[n] / 350;
      dx += P.cloth * 2.5 * w * SIN(1, p, -ph + 0.1) + P.wind * 3 * w;
      dy += P.cloth * 1.5 * w * SIN(2, p, -ph);
    }
    w = S.wSlL[n];
    if (w > 0) {
      const ph = S.slLD[n] / 300;
      dx += P.cloth * 1.5 * w * SIN(1, p, -ph + 0.3);
      dy += P.cloth * 1.0 * w * SIN(2, p, -ph);
    }
    // 裾（足固定マスクとは別。足首付近は最終段で固定される）
    w = S.wSkirt[n];
    if (w > 0) {
      dx += P.skirt * 3.5 * w * (0.7 * SIN(1, p, -x / 900) + 0.3 * SIN(2, p, -x / 500 + 0.2)) + P.wind * 4 * w * (0.5 + 0.5 * SIN(1, p, 0.2));
      dy += P.skirt * 1.2 * w * SIN(2, p, -x / 700 + 0.5);
    }
    // 刀（剛体）
    const ws = S.wSword[n], wwatch = S.wWatch[n];
    const k = ws * (1 - wwatch);
    if (k > 0) { dx = lerp(dx, rigX, k); dy = lerp(dy, rigY, k); }
    // 懐中時計（振り子）
    if (wwatch > 0) {
      const rx = x - 224, ry = y - 318;
      dx += wwatch * ((cw - 1) * rx - sw * ry);
      dy += wwatch * (sw * rx + (cw - 1) * ry);
    }
    ox[n] = dx; oy[n] = dy;
  }
}

// 演出クロスフェード状態
const stageState = { cur: PRESETS[0], prev: null, mix: 1 };
function setStagePreset(P) {
  if (P === stageState.cur) return;
  stageState.prev = stageState.cur; stageState.cur = P; stageState.mix = 0;
}

// 最終座標を作る。足固定は必ずここで最後に適用する。
function buildPositions(clock, lockOn) {
  const cur = stageState.cur;
  evalPreset(cur, frac(clock / cur.T), bufA.x, bufA.y);
  let ax = bufA.x, ay = bufA.y;
  if (stageState.mix < 1 && stageState.prev) {
    const pv = stageState.prev;
    evalPreset(pv, frac(clock / pv.T), bufB.x, bufB.y);
    const m = stageState.mix * stageState.mix * (3 - 2 * stageState.mix);
    for (let n = 0; n < NV; n++) {
      bufB.x[n] = lerp(bufB.x[n], bufA.x[n], m);
      bufB.y[n] = lerp(bufB.y[n], bufA.y[n], m);
    }
    ax = bufB.x; ay = bufB.y;
  }
  finalize(ax, ay, lockOn);
}
function finalize(ax, ay, lockOn) {
  const R = S.rest;
  for (let n = 0; n < NV; n++) {
    const rx = R[n * 2], ry = R[n * 2 + 1];
    if (lockOn && S.hard[n]) { pos[n * 2] = rx; pos[n * 2 + 1] = ry; continue; }   // 元座標を代入
    const f = lockOn ? 1 - S.fl[n] : 1;
    pos[n * 2] = rx + ax[n] * f * idleBlend;
    pos[n * 2 + 1] = ry + ay[n] * f * idleBlend;
  }
}

// ---------- WebGL キャラ描画 ----------
const glc = document.createElement('canvas');
glc.width = CH.w; glc.height = CH.h;
let gl = null, glReady = false, glBuf = null, charImg = null;
function initGL(img) {
  gl = glc.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return false;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 aP;attribute vec2 aT;uniform vec2 uR;varying vec2 vT;void main(){vec2 c=aP/uR*2.0-1.0;gl_Position=vec4(c.x,-c.y,0.0,1.0);vT=aT;}'));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, 'precision mediump float;uniform sampler2D uS;varying vec2 vT;void main(){gl_FragColor=texture2D(uS,vT);}'));
  gl.linkProgram(pr); gl.useProgram(pr);
  gl.uniform2f(gl.getUniformLocation(pr, 'uR'), CH.w, CH.h);
  const tb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tb); gl.bufferData(gl.ARRAY_BUFFER, S.uv, gl.STATIC_DRAW);
  const lt = gl.getAttribLocation(pr, 'aT'); gl.enableVertexAttribArray(lt); gl.vertexAttribPointer(lt, 2, gl.FLOAT, false, 0, 0);
  glBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, glBuf); gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
  const lp = gl.getAttribLocation(pr, 'aP'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, S.index, gl.STATIC_DRAW);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.viewport(0, 0, CH.w, CH.h);
  return true;
}
function drawCharGL() {
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
  gl.drawElements(gl.TRIANGLES, S.index.length, gl.UNSIGNED_SHORT, 0);
}

// ---------- 状態 ----------
const state = {
  playing: true, speed: 1, charVisible: true,
  stageOn: true, preset: 'calm',
  fx: {},                           // id -> {on, amt}
  bg: 'sunset', bgColor: '#3b4a6b', shadow: true,
  scale: 0.9, offX: 0, offY: 0,
  debug: false, lockOff: false,
  ghost: { on: true, mode: 'grad', c1: '#4de1ff', c2: '#a35cff', count: 7, step: 2, opacity: 0.6, glow: true },
  panelHidden: false,
};

// ---------- エフェクト ----------
const spr = {};
function makeSprite(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size); return c;
}
function radialSprite(size, stops) {
  return makeSprite(size, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
}
function star(ctx, x, y, r, a) {   // 4方向の光条
  ctx.save(); ctx.translate(x, y);
  ctx.globalAlpha *= a;
  ctx.drawImage(spr.glow, -r, -r, r * 2, r * 2);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(-r * 1.6, 0); ctx.quadraticCurveTo(0, -r * 0.08, r * 1.6, 0); ctx.quadraticCurveTo(0, r * 0.08, -r * 1.6, 0);
  ctx.moveTo(0, -r * 1.6); ctx.quadraticCurveTo(r * 0.08, 0, 0, r * 1.6); ctx.quadraticCurveTo(-r * 0.08, 0, 0, -r * 1.6);
  ctx.fill(); ctx.restore();
}
const FX = [
  { id: 'sakura', label: '桜吹雪', layer: 'front', on: true, amt: 0.7,
    init(r) {
      this.d = Array.from({ length: 48 }, () => ({ x0: r() * 1.3 - 0.15, c: 1 + Math.floor(r() * 2), ph: r(), sz: 6 + r() * 8, rot: r() * TAU, rk: Math.floor(r() * 5) - 2, sw: 20 + r() * 40, ks: 1 + Math.floor(r() * 3), ph2: r(), kf: 1 + Math.floor(r() * 3), col: r() }));
    },
    draw(ctx, c, p, a) {
      for (const d of this.d) {
        const u = frac(d.c * p + d.ph);
        const x = d.x0 * W + c.wind * W * 0.3 * u + d.sw * Math.sin(TAU * (d.ks * u + d.ph2));
        const y = -30 + (H + 60) * u;
        const al = a * Math.pow(Math.sin(Math.PI * u), 0.6);
        ctx.save(); ctx.translate(x, y); ctx.rotate(d.rot + TAU * d.rk * u);
        ctx.scale(0.45 + 0.55 * Math.abs(Math.cos(TAU * d.kf * u)), 1);
        ctx.globalAlpha = al;
        ctx.fillStyle = d.col < 0.5 ? '#ffc2d6' : '#ff9fbd';
        ctx.beginPath();
        ctx.moveTo(0, -d.sz);
        ctx.bezierCurveTo(d.sz * 0.9, -d.sz * 0.6, d.sz * 0.7, d.sz * 0.6, 0, d.sz);
        ctx.bezierCurveTo(-d.sz * 0.7, d.sz * 0.6, -d.sz * 0.9, -d.sz * 0.6, 0, -d.sz);
        ctx.fill(); ctx.restore();
      }
    } },
  { id: 'sparkle', label: 'キラキラ', layer: 'front', on: false, amt: 0.8,
    init(r) { this.d = Array.from({ length: 46 }, () => ({ x: r() * W, y: r() * H, k: 2 + Math.floor(r() * 3), ph: r(), sz: 5 + r() * 9 })); },
    draw(ctx, c, p, a) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const d of this.d) {
        const v = Math.max(0, SIN(d.k, p, d.ph));
        if (v < 0.02) continue;
        ctx.globalAlpha = a * v * v * v; star(ctx, d.x, d.y, d.sz * (0.6 + 0.6 * v), 1);
      }
      ctx.restore();
    } },
  { id: 'rays', label: '光の筋', layer: 'front', on: false, amt: 0.6,
    init(r) { this.d = Array.from({ length: 7 }, () => ({ ang: 0.35 + r() * 0.75, w: 40 + r() * 130, k: 1 + Math.floor(r() * 3), ph: r(), x: -160 + r() * 620 })); },
    draw(ctx, c, p, a) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const d of this.d) {
        ctx.save(); ctx.translate(d.x, -60); ctx.rotate(d.ang);
        const g = ctx.createLinearGradient(0, 0, H * 1.6, 0);
        g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.globalAlpha = a * 0.16 * (0.6 + 0.4 * SIN(d.k, p, d.ph));
        ctx.fillStyle = g; ctx.fillRect(0, -d.w / 2, H * 1.6, d.w); ctx.restore();
      }
      ctx.restore();
    } },
  { id: 'mist', label: '霧', layer: 'front', on: false, amt: 0.6,
    init(r) { this.d = Array.from({ length: 8 }, () => ({ x0: r() * W, y: H * (0.55 + r() * 0.4), s: 260 + r() * 260, ph: r(), c: 1 })); },
    draw(ctx, c, p, a) {
      for (const d of this.d) {
        const u = frac(d.c * p + d.ph);
        ctx.globalAlpha = a * 0.5 * Math.sin(Math.PI * u);
        ctx.drawImage(spr.mist, d.x0 + (u - 0.5) * W * 0.6 - d.s, d.y - d.s / 2, d.s * 2, d.s);
      }
      ctx.globalAlpha = 1;
    } },
  { id: 'rain', label: '雨', layer: 'front', on: false, amt: 0.6,
    init(r) { this.d = Array.from({ length: 150 }, () => ({ x0: r() * (W + 300) - 100, c: 16 + Math.floor(r() * 7), ph: r(), len: 20 + r() * 26 })); },
    draw(ctx, c, p, a) {
      ctx.save(); ctx.strokeStyle = 'rgba(205,225,255,0.85)'; ctx.lineWidth = 1.3;
      for (const d of this.d) {
        const u = frac(d.c * p + d.ph);
        const x = d.x0 - 0.25 * H * u, y = -50 + (H + 100) * u;
        ctx.globalAlpha = a * 0.6 * Math.min(1, u * 8, (1 - u) * 8);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - d.len * 0.22, y + d.len); ctx.stroke();
      }
      ctx.restore();
    } },
  { id: 'glint', label: '刀の閃光', layer: 'front', on: false, amt: 0.9,
    init() {},
    draw(ctx, c, p, a) {
      const u = frac(3 * p);
      if (u > 0.38) return;
      const t = u / 0.38, al = Math.sin(Math.PI * t);
      const x = lerp(SWORD.a[0] + 40, SWORD.b[0] - 10, t), y = lerp(SWORD.a[1] + 30, SWORD.b[1] - 5, t);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      star(ctx, c.ox + x * c.sc, c.oy + y * c.sc, 34 * c.sc + 8, a * al);
      ctx.restore();
    } },
  { id: 'aura', label: 'オーラ', layer: 'back', on: false, amt: 0.7,
    init() {},
    draw(ctx, c, p, a) {
      const r = 400 * c.sc * (1 + 0.05 * SIN(2, p));
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * (0.55 + 0.25 * SIN(2, p));
      ctx.drawImage(spr.aura, c.ox + 250 * c.sc - r, c.oy + 400 * c.sc - r * 1.15, r * 2, r * 2.3);
      ctx.restore();
    } },
  { id: 'atkflash', label: '攻撃の閃光（攻撃時のみ）', layer: 'top', on: true, amt: 0.7,
    init() {},
    draw(ctx, c, p, a) {
      const f = c.atkFrame;
      if (f < 17 || f > 27) return;
      const u = (f - 17) / 10, al = Math.sin(Math.PI * Math.min(1, u * 1.15));
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.55 * al; ctx.drawImage(spr.glow, 0, 0, W, H);
      ctx.globalAlpha = a * 0.35 * al; ctx.fillStyle = '#cfe9ff'; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } },
  { id: 'vignette', label: 'ビネット', layer: 'top', on: true, amt: 0.3,
    init() {},
    draw(ctx, c, p, a) {
      ctx.save(); ctx.globalAlpha = clamp(a + c.vigExtra, 0, 1); ctx.drawImage(spr.vig, 0, 0, W, H); ctx.restore();
    } },
];

// ---------- 背景 ----------
const BGS = [
  { id: 'sunset', label: '夕焼け', css: 'linear-gradient(#ffb27a,#c95f8f,#3a2a5c)' },
  { id: 'night', label: '夜空', css: 'linear-gradient(#0b1030,#27346b)' },
  { id: 'sakura', label: '桜色', css: 'linear-gradient(#ffe6ee,#f6aec7)' },
  { id: 'forest', label: '深緑', css: 'linear-gradient(#17352b,#0c1c1a)' },
  { id: 'washitsu', label: '和室', css: 'linear-gradient(#e9dcc2,#b79c6c)' },
  { id: 'sky', label: '昼空', css: 'linear-gradient(#78c4ff,#e6f6ff)' },
  { id: 'solid', label: '単色', css: '#3b4a6b' },
  { id: 'image', label: '画像', css: 'repeating-linear-gradient(45deg,#556,#556 8px,#667 8px,#667 16px)' },
  { id: 'transparent', label: '透過', css: 'repeating-conic-gradient(#ccc 0% 25%,#fff 0% 50%) 0 0/16px 16px' },
];
let bgCanvas = document.createElement('canvas'); bgCanvas.width = W; bgCanvas.height = H;
let bgImage = null, stars = [];
function linGrad(g, stops, y0, y1) {
  const gr = g.createLinearGradient(0, y0 || 0, 0, y1 || H);
  stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr;
}
function renderBg() {
  const g = bgCanvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  const id = state.bg;
  if (id === 'transparent') {
    for (let y = 0; y < H; y += 24) for (let x = 0; x < W; x += 24) { g.fillStyle = ((x + y) / 24) % 2 ? '#e4e4e4' : '#fafafa'; g.fillRect(x, y, 24, 24); }
    return;
  }
  if (id === 'solid') { g.fillStyle = state.bgColor; g.fillRect(0, 0, W, H); return; }
  if (id === 'image') {
    if (!bgImage) { g.fillStyle = '#334'; g.fillRect(0, 0, W, H); g.fillStyle = '#99a'; g.font = '28px sans-serif'; g.textAlign = 'center'; g.fillText('「画像を選択」から背景画像を読み込み', W / 2, H / 2); return; }
    const s = Math.max(W / bgImage.width, H / bgImage.height);
    g.drawImage(bgImage, (W - bgImage.width * s) / 2, (H - bgImage.height * s) / 2, bgImage.width * s, bgImage.height * s); return;
  }
  const map = {
    sunset: [[0, '#ffb27a'], [0.55, '#c95f8f'], [1, '#3a2a5c']],
    night: [[0, '#0b1030'], [1, '#27346b']],
    sakura: [[0, '#ffe6ee'], [1, '#f6aec7']],
    forest: [[0, '#17352b'], [1, '#0c1c1a']],
    washitsu: [[0, '#e9dcc2'], [1, '#b79c6c']],
    sky: [[0, '#78c4ff'], [1, '#e6f6ff']],
  };
  g.fillStyle = linGrad(g, map[id]); g.fillRect(0, 0, W, H);
  if (id === 'sunset') { g.drawImage(radialSprite(500, [[0, 'rgba(255,245,210,.95)'], [0.25, 'rgba(255,210,150,.55)'], [1, 'rgba(255,180,120,0)']]), 150, 120, 500, 500); }
  if (id === 'washitsu') { g.strokeStyle = 'rgba(90,60,30,.25)'; g.lineWidth = 2; for (let x = 0; x < W; x += 160) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H * 0.72); g.stroke(); } g.fillStyle = 'rgba(80,50,20,.28)'; g.fillRect(0, H * 0.72, W, H * 0.28); }
}
function drawBgAnimated(ctx, p) {
  if (state.bg !== 'night') return;
  for (const s of stars) {
    ctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * SIN(s.k, p, s.ph));
    ctx.fillStyle = '#fff'; ctx.fillRect(s.x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;
}

// ---------- 攻撃（連番フレーム再生＋足位置補正） ----------
// 元GIFは生成時に体全体がドリフトして足が滑るため、各フレームを「後ろ足を接地点へピン」するよう
// オフセットで平行移動して描く。オフセット = 自動算出(meta.json) + 手動補正(adj)。
const ATK = { meta: null, imgs: [], loaded: 0, adj: [], phase: 'idle', t: 0, settle: 0, settleFrom: 1, ramp: 1, idleWait: 0,
  autoOn: false, autoSec: 4, edit: false, editFrame: 0, onion: true, hit: false };
const ATK_SETTLE = 0.18;                // 攻撃前: 待機の揺れを0へ収める秒
const ATK_RAMP = 0.7;                   // 攻撃後: 待機の揺れを0から戻す秒
const ADJ_KEY = LS_KEY + '_atkadj';
function atkLoadAdj() {
  const n = ATK.meta.n; ATK.adj = Array.from({ length: n }, () => [0, 0]);
  try { const j = JSON.parse(localStorage.getItem(ADJ_KEY) || 'null'); if (j && j.length === n) ATK.adj = j; } catch (e) { }
}
function atkSaveAdj() { try { localStorage.setItem(ADJ_KEY, JSON.stringify(ATK.adj)); } catch (e) { } }
function atkOff(i) {
  const o = ATK.meta.frames[i].off, a = ATK.adj[i];
  return [o[0] + a[0], o[1] + a[1]];
}
function atkFrameAt(t) { return Math.min(ATK.meta.n - 1, Math.floor(t / (ATK.meta.frameMs / 1000))); }
function atkStart() {
  if (!ATK.meta || ATK.loaded < ATK.meta.n) return;
  if (ATK.phase === 'attack' || ATK.phase === 'settle') return;
  ATK.edit = false; ATK.phase = 'settle'; ATK.settle = 0; ATK.settleFrom = idleBlend; syncAtkUI();
}
function drawAtkFrame(ctx, lay, i, k, alpha) {      // k: オフセット倍率（戻り時に0へ）
  const m = ATK.meta, o = atkOff(i);
  const x = lay.ox + (m.crop[0] - m.idleOrigin[0] + o[0] * k) * lay.sc;
  const y = lay.oy + (m.crop[1] - m.idleOrigin[1] + o[1] * k) * lay.sc;
  ctx.save(); ctx.globalAlpha = alpha; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(ATK.imgs[i], x, y, m.crop[2] * lay.sc, m.crop[3] * lay.sc); ctx.restore();
}
const ghostCv = document.createElement('canvas'); const ghostCtx = ghostCv.getContext('2d');
const GH_SCALE = 0.6;
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function ghostColor(g, k, j) {          // k=1(新しい)..count(古い)
  const t = g.count > 1 ? (k - 1) / (g.count - 1) : 0;
  if (g.mode === 'orig') return null;
  if (g.mode === 'solid') return g.c1;
  if (g.mode === 'rainbow') return 'hsl(' + ((j * 9 + k * 38) % 360) + ',95%,62%)';
  const a = hexRgb(g.c1), b = hexRgb(g.c2);
  return 'rgb(' + a.map((v, i) => Math.round(lerp(v, b[i], t))).join(',') + ')';
}
function drawGhosts(ctx, lay, cur) {
  const g = state.ghost, m = ATK.meta;
  if (!g.on || cur <= 0) return;
  const sw = Math.round(m.crop[2] * GH_SCALE), sh = Math.round(m.crop[3] * GH_SCALE);
  if (ghostCv.width !== sw) { ghostCv.width = sw; ghostCv.height = sh; }
  const fade = sstep(0, 1, (m.n - 1 - cur) / 8);                   // 攻撃の終わりで残像を消す
  for (let k = g.count; k >= 1; k--) {
    const j = cur - k * g.step;
    if (j < 0 || !ATK.imgs[j]) continue;
    const age = 1 - (k - 1) / (g.count + 0.5);
    const al = g.opacity * age * age * fade;
    if (al <= 0.01) continue;
    const col = ghostColor(g, k, j);
    ghostCtx.globalCompositeOperation = 'source-over'; ghostCtx.clearRect(0, 0, sw, sh);
    ghostCtx.drawImage(ATK.imgs[j], 0, 0, sw, sh);
    if (col) { ghostCtx.globalCompositeOperation = 'source-in'; ghostCtx.fillStyle = col; ghostCtx.fillRect(0, 0, sw, sh); }
    const o = atkOff(j);
    const x = lay.ox + (m.crop[0] - m.idleOrigin[0] + o[0]) * lay.sc, y = lay.oy + (m.crop[1] - m.idleOrigin[1] + o[1]) * lay.sc;
    ctx.save(); ctx.globalAlpha = al; ctx.globalCompositeOperation = g.glow && col ? 'lighter' : 'source-over';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ghostCv, x, y, m.crop[2] * lay.sc, m.crop[3] * lay.sc); ctx.restore();
  }
}
function drawAtkGuides(ctx, lay) {
  const m = ATK.meta, X = (x) => lay.ox + (x - m.idleOrigin[0]) * lay.sc, Y = (y) => lay.oy + (y - m.idleOrigin[1]) * lay.sc;
  ctx.save(); ctx.lineWidth = 1.5; ctx.setLineDash([8, 5]);
  ctx.strokeStyle = 'rgba(255,70,70,.95)';
  ctx.beginPath(); ctx.moveTo(X(m.ref.rear[0]), Y(560)); ctx.lineTo(X(m.ref.rear[0]), Y(m.ref.rear[1] + 20));
  ctx.moveTo(X(m.ref.rear[0]) - 70 * lay.sc, Y(m.ref.rear[1])); ctx.lineTo(X(m.ref.rear[0]) + 70 * lay.sc, Y(m.ref.rear[1])); ctx.stroke();
  ctx.strokeStyle = 'rgba(80,200,255,.95)';
  ctx.beginPath(); ctx.moveTo(X(m.ref.front[0]) - 70 * lay.sc, Y(m.ref.front[1])); ctx.lineTo(X(m.ref.front[0]) + 70 * lay.sc, Y(m.ref.front[1])); ctx.stroke();
  // 現フレームの検出足位置（補正後）
  const d = m.frames[ATK.editFrame].det, o = atkOff(ATK.editFrame);
  ctx.setLineDash([]);
  [['rear', '#ff4646'], ['front', '#50c8ff']].forEach(([k, col]) => {
    if (!d[k]) return; ctx.strokeStyle = col; ctx.beginPath();
    ctx.arc(X(d[k][0] + o[0]), Y(d[k][1] + o[1]), 7, 0, TAU); ctx.stroke();
  });
  ctx.restore();
}
function atkVerify() {
  const m = ATK.meta, rows = []; let worstY = 0, worstX = 0, planted = 0;
  m.frames.forEach((f, i) => {
    const o = atkOff(i);
    if (f.det.rear) {
      const ex = f.det.rear[0] + o[0] - m.ref.rear[0], ey = f.det.rear[1] + o[1] - m.ref.rear[1];
      worstX = Math.max(worstX, Math.abs(ex)); worstY = Math.max(worstY, Math.abs(ey)); planted++;
      if (Math.abs(ex) > 4 || Math.abs(ey) > 4) rows.push(i + ':(' + ex.toFixed(1) + ',' + ey.toFixed(1) + ')');
    }
  });
  return { rearDetectedFrames: planted, worstRearErrX: +worstX.toFixed(2), worstRearErrY: +worstY.toFixed(2), over4px: rows };
}
window.__atkVerify = atkVerify;

// ---------- メイン描画 ----------
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
let clock = 0, last = 0, lastFoot = { drift: 0, raw: 0 };

function layout() {
  const sc = state.scale;
  const ox = Math.round(W / 2 - (CH.w * sc) / 2 + state.offX);
  const oy = Math.round(H - CH.h * sc - 10 + state.offY);
  return { sc, ox, oy };
}
function render() {
  const lay = layout();
  const P = stageState.cur;
  const pFx = frac(clock / LOOP_T);
  const mixT = stageState.mix < 1 ? stageState.mix : 1;
  const grade = P.grade, gPrev = stageState.prev && stageState.mix < 1 ? stageState.prev : null;
  const vigExtra = lerp(gPrev ? gPrev.vig : P.vig, P.vig, mixT);
  const c = { W, H, ox: lay.ox, oy: lay.oy, sc: lay.sc, wind: P.wind, vigExtra };

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bgCanvas, 0, 0);
  drawBgAnimated(ctx, pFx);
  const layerFx = (layer) => { for (const f of FX) { const s = state.fx[f.id]; if (f.layer === layer && s && s.on) { ctx.save(); f.draw(ctx, c, pFx, s.amt); ctx.restore(); } } };
  layerFx('back');
  if (state.shadow && state.charVisible) {
    const cx = lay.ox + ((FOOT_ANCHORS[0][0] + FOOT_ANCHORS[1][0]) / 2) * lay.sc, cy = lay.oy + 735 * lay.sc;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(1, 0.09);
    ctx.globalAlpha = 0.5; ctx.drawImage(spr.shadow, -260 * lay.sc, -260 * lay.sc, 520 * lay.sc, 520 * lay.sc); ctx.restore();
  }
  const atkOn = ATK.meta && (ATK.phase === 'attack' || ATK.edit);
  if (state.charVisible) {
    if (!atkOn) {
      if (glReady) {
        buildPositions(clock, !state.lockOff);
        drawCharGL();
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(glc, lay.ox, lay.oy, CH.w * lay.sc, CH.h * lay.sc);
      } else if (charImg) {
        ctx.drawImage(charImg, lay.ox, lay.oy, CH.w * lay.sc, CH.h * lay.sc);
      }
    }
    if (atkOn) {
      const cf = ATK.edit ? ATK.editFrame : atkFrameAt(ATK.t);
      if (ATK.edit && ATK.onion) { drawAtkFrame(ctx, lay, 0, 1, 0.3); }
      if (!ATK.edit) drawGhosts(ctx, lay, cf);
      drawAtkFrame(ctx, lay, cf, 1, 1);
    }
  }
  c.atkFrame = ATK.meta && ATK.phase === 'attack' && !ATK.edit ? atkFrameAt(ATK.t) : -1;
  layerFx('front');
  // 演出グレーディング
  const drawGrade = (g, alpha) => {
    if (!g || alpha <= 0) return;
    ctx.save(); ctx.globalAlpha = alpha; ctx.globalCompositeOperation = g.op; ctx.fillStyle = g.fill; ctx.fillRect(0, 0, W, H);
    if (g.desat) { ctx.globalCompositeOperation = 'saturation'; ctx.globalAlpha = alpha * g.desat; ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  };
  if (gPrev) drawGrade(gPrev.grade, 1 - mixT);
  drawGrade(grade, mixT);
  layerFx('top');
  if (ATK.edit && ATK.meta) drawAtkGuides(ctx, lay);
  if (state.debug && !atkOn) drawDebug(lay);
}

function drawDebug(lay) {
  const X = (x) => lay.ox + x * lay.sc, Y = (y) => lay.oy + y * lay.sc;
  ctx.save(); ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,255,160,.9)'; ctx.fillStyle = 'rgba(0,255,160,.12)';
  for (const r of FOOT_RECTS) { ctx.fillRect(X(r[0]), Y(r[1]), (r[2] - r[0]) * lay.sc, (r[3] - r[1]) * lay.sc); ctx.strokeRect(X(r[0]), Y(r[1]), (r[2] - r[0]) * lay.sc, (r[3] - r[1]) * lay.sc); }
  ctx.strokeStyle = 'rgba(255,60,60,.95)'; ctx.setLineDash([6, 4]);
  for (const a of FOOT_ANCHORS) { ctx.beginPath(); ctx.moveTo(X(a[0]), Y(560)); ctx.lineTo(X(a[0]), Y(CH.h)); ctx.moveTo(X(a[0]) - 14, Y(a[1])); ctx.lineTo(X(a[0]) + 14, Y(a[1])); ctx.stroke(); }
  ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
  for (let j = 0; j <= ROWS; j += 2) { ctx.beginPath(); for (let i = 0; i <= COLS; i++) { const n = j * (COLS + 1) + i; const px = X(pos[n * 2]), py = Y(pos[n * 2 + 1]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke(); }
  ctx.restore();
  // 足固定領域の最大変位（最終座標）
  let mx = 0, raw = 0;
  for (let n = 0; n < NV; n++) if (S.hard[n]) {
    mx = Math.max(mx, Math.abs(pos[n * 2] - S.rest[n * 2]), Math.abs(pos[n * 2 + 1] - S.rest[n * 2 + 1]));
  }
  const el = document.getElementById('dbgOut');
  if (el && !el.dataset.hold) el.textContent = '足固定領域 最大変位(最終座標): ' + mx.toFixed(4) + ' px' + (state.lockOff ? '\n※固定OFF(比較表示)' : '');
}

function tick(dt) {
  if (state.playing) clock += dt * state.speed;
  if (ATK.meta && !ATK.edit) {
    if (ATK.phase === 'settle' && state.playing) {
      ATK.settle += dt * state.speed;
      idleBlend = ATK.settleFrom * (1 - sstep(0, 1, ATK.settle / ATK_SETTLE));
      if (ATK.settle >= ATK_SETTLE) { idleBlend = 0; ATK.phase = 'attack'; ATK.t = 0; syncAtkUI(); }
    } else if (ATK.phase === 'attack' && state.playing) {
      ATK.t += dt * state.speed;
      if (ATK.t >= ATK.meta.n * ATK.meta.frameMs / 1000) { ATK.phase = 'idle'; ATK.ramp = 0; ATK.idleWait = 0; idleBlend = 0; syncAtkUI(); }
    } else if (ATK.phase === 'idle') {
      if (ATK.ramp < 1 && state.playing) { ATK.ramp = Math.min(1, ATK.ramp + dt * state.speed / ATK_RAMP); idleBlend = sstep(0, 1, ATK.ramp); }
      else if (ATK.ramp >= 1) idleBlend = 1;
      if (ATK.autoOn && state.playing && ATK.ramp >= 1) { ATK.idleWait += dt; if (ATK.idleWait >= ATK.autoSec) atkStart(); }
    }
  } else if (ATK.edit) idleBlend = 1;
  if (stageState.mix < 1) stageState.mix = Math.min(1, stageState.mix + dt / 0.6);
}
function frame(ts) {
  const dt = Math.min(0.1, (ts - last) / 1000 || 0); last = ts;
  tick(dt);
  render();
  const li = document.getElementById('loopinfo');
  if (li) li.textContent = frac(clock / LOOP_T).toFixed(2) + ' / ループ ' + LOOP_T + 's';
  requestAnimationFrame(frame);
}

// ---------- 検証 ----------
function verify() {
  const out = [];
  const savedStage = { cur: stageState.cur, prev: stageState.prev, mix: stageState.mix };
  stageState.prev = null; stageState.mix = 1;
  const blendSaved = idleBlend; idleBlend = 1;
  let maxLock = 0, maxLoop = 0;
  const ax = new Float32Array(NV), ay = new Float32Array(NV), bx = new Float32Array(NV), by = new Float32Array(NV);
  for (const P of [...PRESETS, BASE]) {
    stageState.cur = P;
    for (let s = 0; s <= 1440; s++) {
      buildPositions((s / 1440) * LOOP_T, true);
      for (let n = 0; n < NV; n++) if (S.hard[n]) maxLock = Math.max(maxLock, Math.abs(pos[n * 2] - S.rest[n * 2]), Math.abs(pos[n * 2 + 1] - S.rest[n * 2 + 1]));
    }
    evalPreset(P, 0, ax, ay); evalPreset(P, 1, bx, by);
    for (let n = 0; n < NV; n++) maxLoop = Math.max(maxLoop, Math.abs(ax[n] - bx[n]), Math.abs(ay[n] - by[n]));
    // 演出クロスフェード中でも固定が保たれるか
    stageState.prev = PRESETS[1]; stageState.mix = 0.5;
    for (let s = 0; s <= 120; s++) {
      buildPositions((s / 120) * LOOP_T, true);
      for (let n = 0; n < NV; n++) if (S.hard[n]) maxLock = Math.max(maxLock, Math.abs(pos[n * 2] - S.rest[n * 2]), Math.abs(pos[n * 2 + 1] - S.rest[n * 2 + 1]));
    }
    stageState.prev = null; stageState.mix = 1;
  }
  // 足のピクセルを描く格子セルの全頂点が固定されているか
  let uncovered = -1;
  try {
    const cv = document.createElement('canvas'); cv.width = CH.w; cv.height = CH.h;
    const g = cv.getContext('2d'); g.drawImage(charImg, 0, 0);
    const data = g.getImageData(0, 0, CH.w, CH.h).data;
    uncovered = 0;
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const x0 = Math.floor((i / COLS) * CH.w), x1 = Math.ceil(((i + 1) / COLS) * CH.w), y0 = Math.floor((j / ROWS) * CH.h), y1 = Math.ceil(((j + 1) / ROWS) * CH.h);
      if (y0 < 650 || (x0 > 128 && x1 < 396)) continue;   // 足首より下・両足側（靴・足袋）のみ検査。中央は裾
      let opaque = false;
      for (let y = y0; y < y1 && !opaque; y++) for (let x = x0; x < x1; x++) if (data[(y * CH.w + x) * 4 + 3] > 16) { opaque = true; break; }
      if (!opaque) continue;
      const a = j * (COLS + 1) + i;
      if (!(S.hard[a] && S.hard[a + 1] && S.hard[a + COLS + 1] && S.hard[a + COLS + 2])) uncovered++;
    }
  } catch (e) { uncovered = -1; }
  stageState.cur = savedStage.cur; stageState.prev = savedStage.prev; stageState.mix = savedStage.mix; idleBlend = blendSaved;
  const res = { footMaxDisp: maxLock, loopClosureErr: maxLoop, uncoveredFootCells: uncovered };
  out.push('足固定 最大変位(全演出×1441サンプル+クロスフェード): ' + maxLock.toExponential(2) + ' px');
  out.push('ループ端 t=0 と t=T の頂点差 最大: ' + maxLoop.toExponential(2) + ' px');
  out.push('足ピクセルを含むが未固定のセル数: ' + (uncovered < 0 ? '検査不可(画像がCORS制限)' : uncovered));
  const el = document.getElementById('dbgOut');
  if (el) { el.dataset.hold = '1'; el.textContent = out.join('\n'); setTimeout(() => { delete el.dataset.hold; }, 8000); }
  console.log('[verify]', res);
  return res;
}
window.__verify = verify;
window.__app = { tick, render, ATK, ghostColor, drawGhosts, get idleBlend() { return idleBlend; }, state, S, stageState, PRESETS, FX, buildPositions, pos, setClock(t) { clock = t; render(); } };

// ---------- UI ----------
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify({ state, fx: state.fx })); } catch (e) { } }
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (j && j.state) { const { panelHidden, playing, ...rest } = j.state; Object.assign(state, rest); }
  } catch (e) { }
  state.ghost = Object.assign({}, GH_DEF, state.ghost);
  for (const f of FX) if (!state.fx[f.id]) state.fx[f.id] = { on: f.on, amt: f.amt };
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

function applyStage() {
  const P = state.stageOn ? PRESETS.find((x) => x.id === state.preset) || PRESETS[0] : BASE;
  setStagePreset(P);
}
function buildUI() {
  const body = document.getElementById('panel-body');
  body.innerHTML = '';
  // 再生
  const d1 = el('<details open><summary>再生</summary></details>');
  const r1 = el('<div class="row"><button id="btnPlay"></button><label><input type="checkbox" id="chChar"> キャラ表示</label></div>');
  d1.append(r1);
  d1.append(el('<div class="row"><span>速度</span><input type="range" id="rgSpeed" min="0.2" max="2" step="0.05"><span class="val" id="vSpeed"></span></div>'));
  body.append(d1);
  // 攻撃
  const dA = el('<details open><summary>攻撃</summary></details>');
  dA.append(el('<div class="row"><button id="btnAtk">⚔ 攻撃（A）</button><span class="val" id="atkState" style="width:auto"></span></div>'));
  dA.append(el('<div class="row"><label><input type="checkbox" id="chAuto"> 自動で繰り返す</label><input type="range" id="rgAuto" min="1" max="12" step="0.5"><span class="val" id="vAuto"></span></div>'));
  dA.append(el('<div class="dbg" id="atkLoad">攻撃フレーム読込中…</div>'));
  body.append(dA);
  // 残像
  const dG = el('<details open><summary>残像（攻撃時）</summary></details>');
  dG.append(el('<div class="row"><label><input type="checkbox" id="chGh"> 残像を出す</label><label><input type="checkbox" id="chGlow"> 発光（加算）</label></div>'));
  dG.append(el('<div class="row"><select id="selGh"><option value="grad">2色グラデ</option><option value="solid">単色</option><option value="rainbow">虹色</option><option value="orig">元の色</option></select><input type="color" id="colG1" title="新しい残像"><input type="color" id="colG2" title="古い残像"></div>'));
  const pres = [['蒼雷', '#4de1ff', '#a35cff'], ['紅蓮', '#ff5a3c', '#ffd23c'], ['翠', '#5cffb0', '#2c7bff'], ['金', '#fff2a8', '#ff9a2c'], ['桜', '#ffc2e0', '#ff5fa0'], ['虚', '#ffffff', '#3a3a6a']];
  const pr = el('<div class="swatches"></div>');
  pres.forEach(([n, a, b]) => { const sb = el('<button class="sw"></button>'); sb.textContent = n; sb.style.background = 'linear-gradient(90deg,' + a + ',' + b + ')'; sb.onclick = () => { state.ghost.c1 = a; state.ghost.c2 = b; state.ghost.mode = 'grad'; refreshUI(); save(); }; pr.append(sb); });
  dG.append(pr);
  [['count', '本数', 1, 14, 1], ['step', '間隔(コマ)', 1, 5, 1], ['opacity', '濃さ', 0.1, 1, 0.05]].forEach(([k, l, mn, mx, st]) => {
    const r = el('<div class="row"><span style="width:64px"></span><input type="range"><span class="val"></span></div>');
    r.firstChild.textContent = l; const rg = r.querySelector('input'); rg.min = mn; rg.max = mx; rg.step = st; rg.value = state.ghost[k];
    const v = r.querySelector('.val'); v.textContent = state.ghost[k];
    rg.oninput = () => { state.ghost[k] = +rg.value; v.textContent = rg.value; save(); };
    dG.append(r);
  });
  body.append(dG);
  // 攻撃フレーム補正
  const dE = el('<details><summary>攻撃フレーム補正（足位置）</summary></details>');
  dE.append(el('<div class="row"><label><input type="checkbox" id="chEdit"> 補正モード（フレーム停止して編集）</label></div>'));
  dE.append(el('<div class="row"><button id="eBack">◀</button><input type="range" id="eFrame" min="0" max="59" step="1"><button id="eFwd">▶</button></div>'));
  dE.append(el('<div class="dbg" id="eNum"></div>'));
  dE.append(el('<div class="row"><span style="width:20px">X</span><button data-d="x-5">-5</button><button data-d="x-1">-1</button><button data-d="x1">+1</button><button data-d="x5">+5</button></div>'));
  dE.append(el('<div class="row"><span style="width:20px">Y</span><button data-d="y-5">-5</button><button data-d="y-1">-1</button><button data-d="y1">+1</button><button data-d="y5">+5</button></div>'));
  dE.append(el('<div class="row"><label><input type="checkbox" id="chOnion"> 待機ポーズを重ねる</label></div>'));
  dE.append(el('<div class="row"><button id="eCopy">前フレームの補正をコピー</button><button id="eReset">このフレームを戻す</button></div>'));
  dE.append(el('<div class="row"><button id="eAll">全補正リセット</button><button id="eExport">JSON出力</button><button id="eVerify">検証</button></div>'));
  dE.append(el('<div class="dbg" id="eOut">赤の縦線・横線=後ろ足の接地基準、青の横線=前足の接地基準。丸=現フレームの検出足位置(補正後)。基準に重なるよう X/Y を調整。</div>'));
  body.append(dE);
  // 演出
  const d2 = el('<details open><summary>演出（動きの切替）</summary></details>');
  d2.append(el('<div class="row"><label><input type="checkbox" id="chStage"> 演出を使う</label></div>'));
  PRESETS.forEach((P) => {
    const o = el('<label class="opt"><input type="radio" name="preset"><b></b><small></small></label>');
    o.querySelector('input').value = P.id; o.querySelector('b').textContent = P.name; o.querySelector('small').textContent = P.desc;
    d2.append(o);
  });
  body.append(d2);
  // エフェクト
  const d3 = el('<details open><summary>エフェクト（重ね掛け可）</summary></details>');
  FX.forEach((f) => {
    const r = el('<div class="row"><label class="grow"><input type="checkbox"><span></span></label><input type="range" min="0" max="1" step="0.05"><span class="val"></span></div>');
    r.querySelector('span').textContent = f.label;
    const cb = r.querySelector('input[type=checkbox]'), rg = r.querySelector('input[type=range]'), v = r.querySelector('.val');
    cb.checked = state.fx[f.id].on; rg.value = state.fx[f.id].amt; v.textContent = (+rg.value).toFixed(2);
    cb.onchange = () => { state.fx[f.id].on = cb.checked; save(); };
    rg.oninput = () => { state.fx[f.id].amt = +rg.value; v.textContent = (+rg.value).toFixed(2); save(); };
    d3.append(r);
  });
  body.append(d3);
  // 背景
  const d4 = el('<details open><summary>背景</summary></details>');
  const sw = el('<div class="swatches"></div>');
  BGS.forEach((b) => {
    const s = el('<button class="sw"></button>'); s.textContent = b.label; s.style.background = b.css; s.dataset.id = b.id;
    s.onclick = () => { state.bg = b.id; renderBg(); refreshUI(); save(); if (b.id === 'image' && !bgImage) document.getElementById('fileBg').click(); };
    sw.append(s);
  });
  d4.append(sw);
  d4.append(el('<div class="row"><span>単色</span><input type="color" id="colBg"><button id="btnImg">画像を選択</button><input type="file" id="fileBg" accept="image/*" hidden></div>'));
  d4.append(el('<div class="row"><label><input type="checkbox" id="chShadow"> 足元の影</label></div>'));
  body.append(d4);
  // 配置
  const d5 = el('<details><summary>配置</summary></details>');
  [['scale', 'サイズ', 0.4, 1.4, 0.01], ['offX', 'X', -500, 500, 1], ['offY', 'Y', -300, 300, 1]].forEach(([k, l, mn, mx, st]) => {
    const r = el('<div class="row"><span style="width:44px"></span><input type="range"><span class="val"></span></div>');
    r.firstChild.textContent = l; const rg = r.querySelector('input'); rg.min = mn; rg.max = mx; rg.step = st; rg.value = state[k];
    const v = r.querySelector('.val'); v.textContent = (+rg.value).toFixed(k === 'scale' ? 2 : 0);
    rg.oninput = () => { state[k] = +rg.value; v.textContent = (+rg.value).toFixed(k === 'scale' ? 2 : 0); save(); };
    d5.append(r);
  });
  const rb = el('<div class="row"><button id="btnReset">配置リセット</button></div>'); d5.append(rb);
  body.append(d5);
  // デバッグ
  const d6 = el('<details><summary>足軸チェック（デバッグ）</summary></details>');
  d6.append(el('<div class="row"><label><input type="checkbox" id="chDbg"> 固定領域・軸線・メッシュを表示</label></div>'));
  d6.append(el('<div class="row"><label><input type="checkbox" id="chLock"> 足固定を切る（比較用）</label></div>'));
  d6.append(el('<div class="row"><button id="btnVerify">検証を実行</button></div>'));
  d6.append(el('<div class="dbg" id="dbgOut"></div>'));
  body.append(d6);

  document.getElementById('btnPlay').onclick = () => { state.playing = !state.playing; refreshUI(); };
  document.getElementById('chChar').onchange = (e) => { state.charVisible = e.target.checked; save(); };
  document.getElementById('rgSpeed').oninput = (e) => { state.speed = +e.target.value; refreshUI(); save(); };
  document.getElementById('chStage').onchange = (e) => { state.stageOn = e.target.checked; applyStage(); refreshUI(); save(); };
  body.querySelectorAll('input[name=preset]').forEach((r) => { r.onchange = () => { state.preset = r.value; state.stageOn = true; applyStage(); refreshUI(); save(); }; });
  document.getElementById('colBg').oninput = (e) => { state.bgColor = e.target.value; state.bg = 'solid'; renderBg(); refreshUI(); save(); };
  document.getElementById('btnImg').onclick = () => document.getElementById('fileBg').click();
  document.getElementById('fileBg').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const im = new Image(); im.onload = () => { bgImage = im; state.bg = 'image'; renderBg(); refreshUI(); }; im.src = URL.createObjectURL(f);
  };
  document.getElementById('chShadow').onchange = (e) => { state.shadow = e.target.checked; save(); };
  document.getElementById('btnReset').onclick = () => { state.scale = 0.9; state.offX = 0; state.offY = 0; buildUI(); refreshUI(); save(); };
  document.getElementById('chDbg').onchange = (e) => { state.debug = e.target.checked; save(); };
  document.getElementById('chLock').onchange = (e) => { state.lockOff = e.target.checked; save(); };
  document.getElementById('btnVerify').onclick = verify;
  bindAtkUI();
  const G = () => state.ghost, gi = (id) => document.getElementById(id);
  gi('chGh').onchange = (e) => { G().on = e.target.checked; save(); };
  gi('chGlow').onchange = (e) => { G().glow = e.target.checked; save(); };
  gi('selGh').onchange = (e) => { G().mode = e.target.value; save(); };
  gi('colG1').oninput = (e) => { G().c1 = e.target.value; save(); };
  gi('colG2').oninput = (e) => { G().c2 = e.target.value; save(); };
  refreshUI();
}
function syncAtkUI() {
  const e = document.getElementById('atkState'); if (!e) return;
  e.textContent = ATK.edit ? '補正中' : ATK.phase === 'attack' || ATK.phase === 'settle' ? '攻撃中' : ATK.ramp < 1 ? '待機へ戻る' : '待機';
}
function bindAtkUI() {
  const $ = (id) => document.getElementById(id);
  $('btnAtk').onclick = atkStart;
  $('chAuto').onchange = (e) => { ATK.autoOn = e.target.checked; ATK.idleWait = 0; };
  $('rgAuto').value = ATK.autoSec; $('vAuto').textContent = ATK.autoSec + 's';
  $('rgAuto').oninput = (e) => { ATK.autoSec = +e.target.value; $('vAuto').textContent = ATK.autoSec + 's'; };
  const upd = () => {
    if (!ATK.meta) return;
    const o = atkOff(ATK.editFrame), a = ATK.adj[ATK.editFrame];
    $('eFrame').value = ATK.editFrame;
    $('eNum').textContent = 'フレーム ' + ATK.editFrame + ' / 自動(' + ATK.meta.frames[ATK.editFrame].off.join(',') + ') 手動(' + a[0] + ',' + a[1] + ') 合計(' + o[0].toFixed(1) + ',' + o[1].toFixed(1) + ')';
  };
  $('chEdit').onchange = (e) => { ATK.edit = e.target.checked && !!ATK.meta; if (ATK.edit) ATK.phase = 'idle'; syncAtkUI(); upd(); };
  $('chOnion').checked = ATK.onion; $('chOnion').onchange = (e) => { ATK.onion = e.target.checked; };
  const go = (f) => { ATK.editFrame = clamp(f, 0, (ATK.meta ? ATK.meta.n : 60) - 1); upd(); };
  $('eFrame').oninput = (e) => go(+e.target.value);
  $('eBack').onclick = () => go(ATK.editFrame - 1);
  $('eFwd').onclick = () => go(ATK.editFrame + 1);
  document.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = () => {
      if (!ATK.meta) return; const m = /([xy])(-?\d+)/.exec(b.dataset.d), a = ATK.adj[ATK.editFrame];
      a[m[1] === 'x' ? 0 : 1] += +m[2]; atkSaveAdj(); upd();
    };
  });
  $('eReset').onclick = () => { if (!ATK.meta) return; ATK.adj[ATK.editFrame] = [0, 0]; atkSaveAdj(); upd(); };
  $('eCopy').onclick = () => { if (!ATK.meta || ATK.editFrame < 1) return; ATK.adj[ATK.editFrame] = ATK.adj[ATK.editFrame - 1].slice(); atkSaveAdj(); upd(); };
  $('eAll').onclick = () => { if (!ATK.meta) return; ATK.adj = ATK.adj.map(() => [0, 0]); atkSaveAdj(); upd(); };
  $('eExport').onclick = () => { if (!ATK.meta) return; const t = JSON.stringify(ATK.meta.frames.map((f, i) => atkOff(i).map((v) => +v.toFixed(1)))); $('eOut').textContent = t; try { navigator.clipboard.writeText(t); } catch (e) { } };
  $('eVerify').onclick = () => { if (!ATK.meta) return; $('eOut').textContent = JSON.stringify(atkVerify()); };
  window.__atkUpd = upd; upd(); syncAtkUI();
}
function refreshUI() {
  const $ = (id) => document.getElementById(id);
  $('btnPlay').textContent = state.playing ? '⏸ 停止' : '▶ 再生';
  $('chChar').checked = state.charVisible;
  $('rgSpeed').value = state.speed; $('vSpeed').textContent = '×' + state.speed.toFixed(2);
  $('chStage').checked = state.stageOn;
  document.querySelectorAll('input[name=preset]').forEach((r) => { r.checked = r.value === state.preset; r.closest('.opt').classList.toggle('on', r.checked && state.stageOn); });
  document.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s.dataset.id === state.bg));
  $('colBg').value = state.bgColor; $('chShadow').checked = state.shadow;
  $('chGh').checked = state.ghost.on; $('chGlow').checked = state.ghost.glow; $('selGh').value = state.ghost.mode; $('colG1').value = state.ghost.c1; $('colG2').value = state.ghost.c2;
  $('chDbg').checked = state.debug; $('chLock').checked = state.lockOff;
}
function setPanelHidden(h) {
  state.panelHidden = h;
  document.querySelector('.app').classList.toggle('panel-hidden', h);
}
window.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || '')) && e.target.type !== 'checkbox' && e.target.type !== 'radio' && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); state.playing = !state.playing; refreshUI(); }
  else if (e.key === 'h' || e.key === 'H') setPanelHidden(!state.panelHidden);
  else if (e.key === 'a' || e.key === 'A') atkStart();
});

// ---------- 起動 ----------
function makeSprites() {
  spr.glow = radialSprite(128, [[0, 'rgba(255,255,255,.95)'], [0.25, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]);
  spr.mist = radialSprite(256, [[0, 'rgba(255,255,255,.55)'], [0.6, 'rgba(255,255,255,.18)'], [1, 'rgba(255,255,255,0)']]);
  spr.aura = radialSprite(512, [[0, 'rgba(255,255,255,0)'], [0.45, 'rgba(140,200,255,.35)'], [0.75, 'rgba(120,170,255,.22)'], [1, 'rgba(120,170,255,0)']]);
  spr.shadow = radialSprite(256, [[0, 'rgba(0,0,0,.75)'], [0.6, 'rgba(0,0,0,.35)'], [1, 'rgba(0,0,0,0)']]);
  spr.vig = makeSprite(512, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, s * 0.25, s / 2, s / 2, s * 0.72);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)'); g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
}
function start(img) {
  charImg = img;
  makeSprites();
  const r = mulberry32(20260930);
  FX.forEach((f, i) => f.init(mulberry32(1000 + i * 77)));
  for (let i = 0; i < 90; i++) stars.push({ x: r() * W, y: r() * H * 0.75, r: 1 + Math.floor(r() * 2), k: 1 + Math.floor(r() * 3), ph: r() });
  load();
  try { glReady = initGL(img); } catch (e) { console.error(e); glReady = false; }
  if (!glReady) { const n = document.getElementById('notice'); n.hidden = false; n.textContent = 'WebGL が使えないため静止画表示です。'; }
  renderBg(); buildUI(); applyStage(); stageState.prev = null; stageState.mix = 1;
  loadAttack();
  requestAnimationFrame((t) => { last = t; frame(t); });
}
function loadAttack() {
  const info = document.getElementById('atkLoad'), btn = document.getElementById('btnAtk');
  if (btn) btn.disabled = true;
  fetch('assets/attack/meta.json').then((r) => r.json()).then((m) => {
    ATK.meta = m; atkLoadAdj();
    document.getElementById('eFrame').max = m.n - 1;
    let done = 0;
    for (let i = 0; i < m.n; i++) {
      const im = new Image();
      im.onerror = () => console.error('frame load failed', i);
      im.onload = () => {
        done++; ATK.loaded = done; if (info) info.textContent = '攻撃フレーム ' + done + '/' + m.n;
        if (done === m.n) { if (btn) btn.disabled = false; if (info) info.textContent = '攻撃フレーム ' + m.n + '枚 準備完了（Aキー/ステージのクリックでも発動）'; if (window.__atkUpd) window.__atkUpd(); }
      };
      const an = m.attackN || m.n;
      im.src = 'assets/attack/' + (i < an ? 'f' + String(i).padStart(2, '0') : 'r' + String(i - an).padStart(2, '0')) + '.webp';
      ATK.imgs.push(im);
    }
  }).catch(() => { if (info) info.textContent = '攻撃フレームを読み込めません'; });
}
canvas.addEventListener('click', () => { if (!ATK.edit) atkStart(); });
const img = new Image();
img.onload = () => start(img);
img.onerror = () => { const n = document.getElementById('notice'); n.hidden = false; n.textContent = 'assets/character.png を読み込めません'; };
img.src = 'assets/character.png';
