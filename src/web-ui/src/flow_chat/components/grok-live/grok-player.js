// grok-player.js — Grok Bot 头像动画引擎的浏览器 ESM 播放器。
//
// 本文件是按逆向语义文档对原版引擎（grokbot renderer bundle）的忠实移植。
// 关键函数旁标注了原始混淆名（如 `// Qa`），参数、曲线、求值顺序均与原版一致。
// 数据（clips/states/表情/形状度量/常量）全部来自 grok-recipes.json，不在此硬编码。
//
// 用法：
//   import { createGrokBot } from "./vendor/grok-player.js";
//   const bot = createGrokBot(el, { size: 320, state: "idle", seed: 1, follow: true });
//   bot.setState("thinking"); bot.destroy();
//
// 已移植：状态机 Nx、clip 求值 vt/Qa、bridge bx/rest 帧 ul/wx、表情机 Bb（含
// 三条过渡路径与 lidMorph）、眨眼 gx/ab、注视 al/ex、look/poke、morph 行为器 cx、
// morph 覆盖层 yE + 12 种生成器、眼睛 SDF 管线（cT/UM/ST/RM）、sphere 身体 wT/vT、
// glow TT（49 stops + halo）、morph 身体轮廓混合（gM/kM/SM/TE）。
// 未移植：非 sphere 身体形状（Bodymoves_A=clover、Rotation_*=cloud 会回退 sphere
// 并警告一次）、proof 线框调试层、多身体 setBody 交叉淡化的轮廓混合（PE）、
// pencil morph 的身体环轮廓 VT（回退为圆形环 $h，其余 pencil 动画完整）。

const TAU = Math.PI * 2; // ut / CT
const DEG = Math.PI / 180; // vn

// ---------- 基础数学 ----------
const le = (e, t, n) => Math.min(n, Math.max(t, e)); // le
const Jo = e => { const t = le(e, 0, 1); return t * t * (3 - 2 * t); }; // Jo (smoothstep)
const Qo = e => e < .5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2; // Qo easeInOutCubic
const Ye = e => 1 - Math.pow(1 - e, 3); // Ye easeOutCubic
const Es = e => 1 + 2.70158 * Math.pow(e - 1, 3) + 1.70158 * Math.pow(e - 1, 2); // Es easeOutBack
const eb = Jo; // eb 同为 smoothstep
const ma = (e, t, n) => { const r = le((n - e) / (t - e), 0, 1); return r * r * (3 - 2 * r); }; // ma
const Bt = e => (e % 1 + 1) % 1; // Bt
const fo = (e, t, n) => e <= t || e >= n ? 0 : Math.sin(Math.PI * (e - t) / (n - t)) ** 2; // fo
const cd = e => e - TAU * Math.round(e / TAU); // cd
const Dr = e => { const t = e % TAU; return t < 0 ? t + TAU : t; }; // Dr
const ad = (e, t, n) => [e[0] + (t[0] - e[0]) * n, e[1] + (t[1] - e[1]) * n]; // ad
const ud = (e, t) => { const n = t[0] - e[0], r = t[1] - e[1]; return n * n + r * r; }; // ud
function QM(e, t, n) { // QM：点到线段距离
  const r = n[0] - t[0], o = n[1] - t[1], s = e[0] - t[0], i = e[1] - t[1],
    a = r * r + o * o, c = a > 0 ? le((s * r + i * o) / a, 0, 1) : 0, u = s - r * c, l = i - o * c;
  return Math.sqrt(u * u + l * l);
}

// ---------- 贝塞尔 easing（Qa：牛顿迭代解 x，再取 y） ----------
const el = (e, t, n) => { const r = 1 - e; return 3 * r * r * e * t + 3 * r * e * e * n + e * e * e; };
const sb = (e, t, n) => { const r = 1 - e; return 3 * r * r * t + 6 * r * e * (n - t) + 3 * e * e * (1 - n); };
function Qa(e, t) {
  const [n, r, o, s] = t; let i = e;
  for (let a = 0; a < 8; a++) {
    const c = el(i, n, o) - e, u = sb(i, n, o);
    if (Math.abs(c) < 1e-6 || Math.abs(u) < 1e-6) break;
    i = le(i - c / u, 0, 1);
  }
  return el(i, r, s);
}

// ---------- 随机数 tc + 洗牌 Lx/hl ----------
function tc(e) {
  let t = e | 0;
  return () => {
    t = t + 1831565813 | 0;
    let n = Math.imul(t ^ t >>> 15, t | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}
const hl = (e, t, n) => { const r = e[t], o = e[n]; e[t] = o, e[n] = r; };
function Lx(e, t, n) {
  const r = [...e];
  for (let s = r.length - 1; s > 0; s -= 1) hl(r, s, Math.floor(t() * (s + 1)));
  const o = r.findIndex(s => s !== n);
  return o > 0 && hl(r, 0, o), r;
}

// ---------- 四元数 ----------
function ra(e, t) { // ra：哈密顿积
  return [e[0] * t[0] - e[1] * t[1] - e[2] * t[2] - e[3] * t[3],
  e[0] * t[1] + e[1] * t[0] + e[2] * t[3] - e[3] * t[2],
  e[0] * t[2] - e[1] * t[3] + e[2] * t[0] + e[3] * t[1],
  e[0] * t[3] + e[1] * t[2] - e[2] * t[1] + e[3] * t[0]];
}
const Po = (e, t) => { const n = Math.sin(t / 2); return [Math.cos(t / 2), e[0] * n, e[1] * n, e[2] * n]; }; // Po 轴角
const cb = e => { const t = Math.hypot(e[0], e[1], e[2], e[3]) || 1; return [e[0] / t, e[1] / t, e[2] / t, e[3] / t]; };
function ir(e) { // ir：四元数→3×3
  const [t, n, r, o] = e;
  return [1 - 2 * (r * r + o * o), 2 * (n * r - t * o), 2 * (n * o + t * r),
  2 * (n * r + t * o), 1 - 2 * (n * n + o * o), 2 * (r * o - t * n),
  2 * (n * o - t * r), 2 * (r * o + t * n), 1 - 2 * (n * n + r * r)];
}
const lb = (e, t, n) => ra(Po([0, 0, 1], n), ra(Po([0, 1, 0], t), Po([1, 0, 0], e))); // lb：欧拉(rad)→quat，Qz·Qy·Qx
const Et = (e, t) => [ // Et：3×3 乘向量
  e[0] * t[0] + e[1] * t[1] + e[2] * t[2],
  e[3] * t[0] + e[4] * t[1] + e[5] * t[2],
  e[6] * t[0] + e[7] * t[1] + e[8] * t[2]];

// ---------- 弹簧（半隐式欧拉，120Hz 子步） ----------
const To = e => ({ x: e, v: 0, t: e }); // To
const Eo = (e, t, n, r) => { // Eo：v+=(-2ζωv-ω²(x-t))dt
  e.v += (-2 * n * t * e.v - t * t * (e.x - e.t)) * r; e.x += e.v * r;
  (!Number.isFinite(e.x) || !Number.isFinite(e.v)) && (e.x = e.t, e.v = 0);
};
const Jw = 1 / 120, Bf = e => Math.max(1, Math.ceil(e / Jw)); // Jw / Bf

// ============================================================
// 眼睛描述符几何（xb/Gf/Pr/ec/oa/Nb/Ob/Lb/rl/Fb/zb/Db/ol）
// 描述符：{off:[x,y], tilt(rad), wid, lidY, oval:[rx,ry], ovalMix, pts(21×2), path(18), fillRing}
// ============================================================

// xb：二次贝塞尔 p0/p1/p2 → 3 段三次贝塞尔的扁平数组（每段 6：锚点2 + 出柄2 + 入柄2）
function xb({ p0: e, p1: t, p2: n, isArc: r }, KB) {
  const [o, s] = e, [i, a] = t, [c, u] = n, l = new Array(KB).fill(0);
  const d = (y, w) => { l[y * 6] = w[0], l[y * 6 + 1] = w[1]; },
    f = (y, w) => { l[y * 6 + 2] = w[0] - l[y * 6], l[y * 6 + 3] = w[1] - l[y * 6 + 1]; },
    h = (y, w) => { l[y * 6 + 4] = w[0] - l[y * 6], l[y * 6 + 5] = w[1] - l[y * 6 + 1]; };
  if (r) { // 圆弧拟合：过三点作圆 → 两段三次贝塞尔
    const y = 2 * (o * (a - u) + i * (u - s) + c * (s - a));
    if (Math.abs(y) > 1e-9) {
      const S = o * o + s * s, b = i * i + a * a, v = c * c + u * u,
        T = (S * (a - u) + b * (u - s) + v * (s - a)) / y, A = (S * (c - i) + b * (o - c) + v * (i - o)) / y,
        F = Math.hypot(o - T, s - A), N = Math.atan2(s - A, o - T), R2 = Math.atan2(u - A, c - T),
        B2 = Math.atan2(a - A, i - T), E = TAU, I = (R2 - N + E) % E,
        O = (B2 - N + E) % E <= I ? I : I - E, H = K => [T + F * Math.cos(K), A + F * Math.sin(K)],
        L = K => [-Math.sin(K), Math.cos(K)], j = O / 2, J = 4 / 3 * Math.tan(j / 4) * F, fe = [N, N + j, N + O];
      for (let K = 0; K < 3; K++) {
        const te = H(fe[K]), Z = L(fe[K]);
        d(K, te), K > 0 && f(K, [te[0] - J * Z[0], te[1] - J * Z[1]]), K < 2 && h(K, [te[0] + J * Z[0], te[1] + J * Z[1]]);
      }
      return l;
    }
    const w = [(o + c) / 2, (s + u) / 2]; // 退化（共线）：二次曲线中点细分
    return d(0, [o, s]), d(1, w), d(2, [c, u]), h(0, [o + (w[0] - o) / 3, s + (w[1] - s) / 3]),
      f(1, [w[0] - (w[0] - o) / 3, w[1] - (w[1] - s) / 3]), h(1, [w[0] + (c - w[0]) / 3, w[1] + (u - w[1]) / 3]),
      f(2, [c - (c - w[0]) / 3, u - (u - w[1]) / 3]), l;
  }
  const p = [(o + i) / 2, (s + a) / 2], g = [(i + c) / 2, (a + u) / 2], m = [(p[0] + g[0]) / 2, (p[1] + g[1]) / 2];
  return d(0, [o, s]), d(1, m), d(2, [c, u]), h(0, [o + 2 / 3 * (p[0] - o), s + 2 / 3 * (p[1] - o)]),
    f(1, [m[0] - 2 / 3 * (p[0] - m[0]), m[1] - 2 / 3 * (p[1] - m[1])]),
    h(1, [m[0] + 2 / 3 * (g[0] - m[0]), m[1] + 2 / 3 * (g[1] - m[1])]),
    f(2, [c + 2 / 3 * (g[0] - c), u + 2 / 3 * (g[1] - u)]), l;
}
const uo = (e, t) => [e[t * 6], e[t * 6 + 1]]; // uo
const lo = (e, t, n) => { const r = n ? 4 : 2; return [e[t * 6] + e[t * 6 + r], e[t * 6 + 1] + e[t * 6 + r + 1]]; }; // lo
// Gf：path 扁平数组 → 脊线采样点（yb=21 点）
function Gf(e, YB) {
  const t = YB + 1 >> 1, n = [], r = (o, s, i, a, c) => {
    for (let u = c; u < t; u++) {
      const l = u / (t - 1), d = 1 - l, f = d * d * d, h = 3 * d * d * l, p = 3 * d * l * l, g = l * l * l;
      n.push([f * o[0] + h * s[0] + p * i[0] + g * a[0], f * o[1] + h * s[1] + p * i[1] + g * a[1]]);
    }
  };
  return r(uo(e, 0), lo(e, 0, !0), lo(e, 1, !1), uo(e, 1), 0), r(uo(e, 1), lo(e, 1, !0), lo(e, 2, !1), uo(e, 2), 1), n;
}
// Pr/ec/oa/Nb：构建/重建眼睛描述符
const Pr = (e, t, n, r, o, G) => { const s = xb(r, G.kb); return { off: e, tilt: t, wid: n, lidY: 1, oval: o, ovalMix: 0, pts: Gf(s, G.yb), path: s, fillRing: null }; };
function ec(e, t, n, r, o, G) {
  const s = Math.max(0, (t - e) / 2), i = n * DEG, a = Math.sin(i) * s, c = Math.cos(i) * s;
  return Pr(r, o, e / 2, { p0: [-a, -c], p1: [0, 0], p2: [a, c], isArc: !1 }, [0, 0], G);
}
const oa = (e, t, n, r, G) => ec(Math.max(e, 1e-4), Math.max(t, e), 0, r, n, G); // oa
const Nb = (e, t, n, r, G) => t >= e ? oa(e, t, 0, [n, r], G) : oa(t, e, Math.PI / 2, [n, r], G); // Nb

const jt = e => e.oval[0] > 1e-4 && e.oval[1] > 1e-4; // jt：椭圆眼
function ts(e) { // ts：弧脊眼（脊线偏离弦 > max(.012, wid*.2)）
  if (jt(e) || e.pts.length < 3) return !1;
  const t = e.pts[0], n = e.pts[e.pts.length - 1], r = n[0] - t[0], o = n[1] - t[1], s = r * r + o * o;
  if (s < 1e-8) return !1;
  let i = 0;
  for (const a of e.pts) {
    const c = ((a[0] - t[0]) * r + (a[1] - t[1]) * o) / s, u = t[0] + c * r, l = t[1] + c * o, d = Math.hypot(a[0] - u, a[1] - l);
    d > i && (i = d);
  }
  return i > Math.max(.012, e.wid * .2);
}
const Zn = (e, t, n) => e + (t - e) * n; // Zn
const Ao = (e, t, n) => [Zn(e[0], t[0], n), Zn(e[1], t[1], n)]; // Ao
function nl(e, t, n) { // nl：脊线点列重采样取值
  if (e.length === 0) return [0, 0];
  if (e.length === 1 || n <= 1) return e[0];
  const r = t / (n - 1) * (e.length - 1), o = Math.min(Math.floor(r), e.length - 2);
  return Ao(e[o], e[o + 1], r - o);
}
// _b：spine 路径插值
function _b(e, t, n, G) {
  const r = { off: Ao(e.off, t.off, n), tilt: Zn(e.tilt, t.tilt, n), wid: Zn(e.wid, t.wid, n), lidY: Zn(e.lidY, t.lidY, n), oval: Ao(e.oval, t.oval, n), ovalMix: 0, fillRing: null };
  if (e.path && t.path && e.path.length === t.path.length) {
    const i = t.path, a = e.path.map((c, u) => Zn(c, i[u], n));
    return { ...r, path: a, pts: Gf(a, G.yb) };
  }
  const o = Math.max(e.pts.length, t.pts.length, 2), s = [];
  for (let i = 0; i < o; i++) s.push(Ao(nl(e.pts, i, o), nl(t.pts, i, o), n));
  return { ...r, path: null, pts: s };
}
// ns：眼睛→椭圆参数 {cx,cy,ang,halfLen,halfW}
function ns(e) {
  if (jt(e)) {
    const [o, s] = e.oval;
    return { cx: e.off[0], cy: e.off[1], ang: o >= s ? Math.PI / 2 : 0, halfLen: Math.max(o, s), halfW: Math.min(o, s) };
  }
  const t = e.wid;
  if (e.pts.length < 2) return { cx: e.off[0], cy: e.off[1], ang: e.tilt, halfLen: t, halfW: t };
  const n = e.pts[0], r = e.pts[e.pts.length - 1];
  return { cx: e.off[0] + (n[0] + r[0]) / 2, cy: e.off[1] + (n[1] + r[1]) / 2, ang: Math.atan2(r[0] - n[0], r[1] - n[1]) + e.tilt, halfLen: Math.hypot(r[0] - n[0], r[1] - n[1]) / 2 + t, halfW: t };
}
function Wf(e, t) { // Wf：角度差 wrap 到 ±π/2
  let n = t.ang - e.ang;
  for (; n > Math.PI / 2;) n -= Math.PI;
  for (; n < -Math.PI / 2;) n += Math.PI;
  return n;
}
function Cb(e, t, n) { // Cb：oval fillRing（圆→椭圆 48 点环）
  const o = Math.max(0, e - t), s = le(n, 0, 1), i = [];
  for (let a = 0; a < 48; a++) {
    const c = a / 48 * TAU, u = Math.cos(c), l = Math.sin(c), d = t * u, f = e * l, h = t / Math.max(Math.abs(u), 1e-6);
    let p;
    if (h * Math.abs(l) <= o + 1e-6 && Number.isFinite(h)) p = h;
    else { const w = (l >= 0 ? 1 : -1) * o * l, S = Math.max(0, w * w - o * o + t * t); p = w + Math.sqrt(S); }
    const g = p * u, m = p * l;
    i.push([g + (d - g) * s, m + (f - m) * s]);
  }
  return i;
}
const wt = e => ({ ...e, ovalMix: 0 }); // wt
const nt = (e, t) => [t(e[0], 0), t(e[1], 1)]; // nt
// Rb：oval 过渡路径
function Rb(e, t, n, G) {
  if (n <= 1e-4) return wt(e);
  if (n >= .995) return wt(t);
  const r = ns(e), o = ns(t), s = Wf(r, o), i = jt(t), a = i ? 1 - (1 - n) ** 3 : n * n * n,
    c = r.ang + s * n, u = Math.max(r.halfLen + (o.halfLen - r.halfLen) * n, 1e-4),
    l = Math.max(r.halfW + (o.halfW - r.halfW) * n, 1e-4), d = jt(e) ? 1 : 0, f = d + ((i ? 1 : 0) - d) * a,
    h = oa(2 * l, 2 * u, c, [r.cx + (o.cx - r.cx) * n, r.cy + (o.cy - r.cy) * n], G), p = f > 1e-4;
  return { ...h, oval: p ? [l, u] : h.oval, ovalMix: p ? f : 0, fillRing: Cb(u, l, f) };
}
// $b：stadium 过渡路径
function $b(e, t, n, G) {
  if (n >= 1 - 1e-4) return wt(t);
  const r = ns(e), o = ns(t), s = r.ang + Wf(r, o) * n, i = Math.max(1e-4, r.halfW + (o.halfW - r.halfW) * n),
    a = Math.max(0, r.halfLen - r.halfW) * (1 - n) + Math.max(0, o.halfLen - o.halfW) * n,
    c = [r.cx + (o.cx - r.cx) * n, r.cy + (o.cy - r.cy) * n];
  return ec(2 * i, 2 * (a + i), s / DEG, c, 0, G);
}
// Ob/Lb：包围盒
function Ob(e) {
  const t = jt(e);
  if (!(e.wid > 0) && !t) return null;
  const n = e.lidY, r = e.tilt / DEG;
  if (t) return { width: 2 * e.oval[0], height: 2 * e.oval[1] * n, tilt: r, cx: e.off[0], cy: e.off[1] };
  if (e.pts.length < 2) return null;
  const o = e.pts[0], s = e.pts[e.pts.length - 1], i = s[0] - o[0], a = s[1] - o[1], c = Math.hypot(i, a), u = 2 * e.wid;
  return { width: u, height: (c + u) * n, tilt: Math.atan2(i, a) / DEG + r, cx: e.off[0] + (o[0] + s[0]) / 2, cy: e.off[1] + (o[1] + s[1]) / 2 * n };
}
function Lb(e, XR) {
  const t = Ob(e);
  if (t == null) return { w: XR, h: .57, cx: e.off[0], cy: e.off[1] };
  const n = t.tilt * DEG, r = Math.abs(Math.cos(n)), o = Math.abs(Math.sin(n));
  return { w: t.width * r + t.height * o, h: t.width * o + t.height * r, cx: t.cx, cy: t.cy };
}
// rl：lid 量 t 挤压眼睛（眨眼/lids track 的最终施加）
function rl(e, t, G) {
  if (t <= 0) return e;
  const n = Math.min(1, t), r = Lb(e, G.xr), o = Math.max(r.w, 1e-4), s = Math.max(r.h, o), i = o * G.Ab;
  return Nb(o, s + (i - s) * n, r.cx, r.cy, G);
}
const Fb = e => ({ ...e, wid: 0, oval: [0, 0] }); // Fb：全闭眼
function zb(e, G) { // zb：眼睛纵向范围（lid 支点）
  let t, n;
  if (jt(e)) t = -e.oval[1], n = e.oval[1];
  else {
    let r = 1e9, o = -1e9;
    for (const s of e.pts) s[1] < r && (r = s[1]), s[1] > o && (o = s[1]);
    t = r - e.wid, n = o + e.wid;
  }
  return t + (1 - G.Pb) * (n - t);
}
function Db(e) { // Db：脊线旋转归一（弦变竖直，角度并入 tilt）
  if (e.pts.length < 2) return e;
  const t = e.pts[0], n = e.pts[e.pts.length - 1], r = n[0] - t[0], o = n[1] - t[1];
  if (Math.abs(o) < Math.abs(r)) return e;
  const s = Math.atan2(r, o);
  if (Math.abs(s) < 1e-5) return e;
  const i = Math.cos(s), a = Math.sin(s);
  return { ...e, tilt: e.tilt + s, pts: e.pts.map(c => [c[0] * i - c[1] * a, c[0] * a + c[1] * i]) };
}
function ol(e, t, G) { // ol：lidMorph 的闭合量施加（lidY 压缩 + off 偏移）
  if (t === 0) return e;
  const n = Db(e), r = Math.max(G.Eb, 1 - t), o = zb(n, G) * (1 - r), s = Math.cos(-n.tilt), i = Math.sin(-n.tilt);
  return { ...n, off: [n.off[0] - i * o, n.off[1] + s * o], lidY: n.lidY * r };
}

// ============================================================
// 表情机 Bb（Face）：眨眼 / morph(.28s) / lidMorph(.35s) / inspect 加权
// ============================================================
const sl = e => e === "inspecting" ? 1 : 0; // sl

function createFace(G) { // Bb
  const bn = G.expressions, bb = G.blinkBlocking, wb = G.expressionAliases, gb = G.expressionNames;
  const Lr = e => bb.has(e); // Lr
  const Sb = e => gb.has(e); // Sb
  const Mb = e => { const t = e.trim().toLowerCase(), n = wb.get(t) ?? t; return Sb(n) ? n : "neutral"; }; // Mb
  const ii = (e, dur) => { // ii：相位窗 {u1,u2}
    const t = Math.min(.28, (e ? G.ob : G.rb) / Math.max(dur, .05));
    return { u1: (1 - t) * .42, u2: (1 - t) * .42 + t };
  };
  const ib = e => { // ib：睁开过冲曲线（si=1.06）
    const t = le(e, 0, 1);
    if (t < .7) { const n = t / .7; return (1 - (1 - n) * (1 - n)) * G.si; }
    return G.si + (1 - G.si) * Jo((t - .7) / .3);
  };
  const ab = (e, { u1: t, u2: n }) => e < t ? Jo(e / t) : e <= n ? 1 : 1 - Jo((e - n) / Math.max(1e-6, 1 - n)); // ab
  const il = r => Qa(le(r.t / r.dur, 0, 1), G.tbEase); // il：morph 进度曲线 tb
  let e = "neutral", t = nt(bn.neutral, wt), n = 0, r = null;
  const o = () => { // eyes()
    if (r == null) return t;
    if (r.kind === "blink") return r.from;
    if (r.kind === "morph") {
      const m = il(r), { from: y, to: w, path: S } = r;
      return S === "oval" ? nt(y, (b, v) => Rb(b, w[v], m, G)) : S === "spine" ? nt(y, (b, v) => _b(b, w[v], m, G)) : nt(y, (b, v) => $b(b, w[v], m, G));
    }
    const f = Math.min(r.t / r.dur, 1), { u1: h, u2: p } = ii(!1, r.dur);
    if (f < h) return nt(r.from, m => ol(m, Jo(f / h), G));
    if (f <= p) return nt(r.to, Fb);
    const g = ib((f - p) / Math.max(1e-6, 1 - p));
    return nt(r.to, m => ol(m, 1 - g, G));
  };
  const s = () => { // inspectWeight()
    if (r == null) return n;
    if (r.kind === "blink") return r.fromInspect;
    const f = r.fromInspect, h = sl(r.toName);
    if (r.kind === "morph") return f + (h - f) * il(r);
    const p = Math.min(r.t / r.dur, 1), { u1: g, u2: m } = ii(!1, r.dur);
    return p <= g ? f : p < m ? 0 : h;
  };
  const i = f => { // morph
    const h = nt(o(), wt), p = bn[f], g = h.some(ts) || p.some(ts) || e === "sleepy" || f === "sleepy";
    r = { kind: "morph", path: !(h.some(ts) || p.some(ts)) && (h.some(jt) || p.some(jt)) ? "oval" : g ? "spine" : "stadium", fromInspect: s(), toName: f, from: h, to: p, t: 0, dur: G.nb, isHeld: !1 };
    e = f;
  };
  const a = f => { // lidMorph
    r = { kind: "lidMorph", fromInspect: s(), toName: f, from: nt(o(), wt), to: bn[f], t: 0, dur: G.ta, isHeld: !1 };
    e = f;
  };
  const c = () => { // blink
    r != null && !r.isHeld || (r = { kind: "blink", fromInspect: n, toName: e, from: nt(t, wt), to: bn[e], t: 0, dur: G.na, isHeld: !1 });
  };
  const u = f => { // play(expression event)
    f.name === e && (r == null || r.toName === f.name) || (f.isThroughBlink && !Lr(f.name) && !Lr(e) ? a(f.name) : i(f.name));
  };
  const l = (f, h) => { // settle
    h >= f.dur ? (t = nt(f.to, wt), n = sl(f.toName), r = null) : r = h < 0 ? null : { ...f, t: h };
  };
  const d = f => { r != null && (r = { ...r, isHeld: f }); };
  return {
    get name() { return e; },
    get isMorphing() { return r != null && r.kind !== "blink" && !r.isHeld; },
    eyes: o, inspectWeight: s,
    blinkAmount() {
      if (r?.kind !== "blink" || r.isHeld) return null;
      const f = Math.min(r.t / r.dur, 1);
      return le(ab(f, ii(!0, r.dur)), 0, 1);
    },
    morph: i, lidMorph: a, blink: c, play: u,
    step(f) { r != null && !r.isHeld && l(r, r.t + f); },
    release() { d(!1); },
    seek(f, h) {
      e = "neutral", t = nt(bn.neutral, wt), n = 0, r = null;
      let p = 0;
      const g = m => { r != null && l(r, m - p); };
      for (const m of f) {
        if (m.t > h + 1e-9) break;
        g(m.t), u(m), p = m.t;
      }
      g(h), d(!0);
    },
    Mb,
  };
}

// ============================================================
// 环境 morph 行为器 cx：amount/swap/spin 弹簧 + shot 重触发
// ============================================================
function createMorphBehavior(G, e = {}) { // cx
  const t = e.isReducedMotion ?? !1, n = tc(e.seed ?? 2654435769),
    r = To(0), o = To(1), s = To(0);
  let i = null, a = null, c = null, u = null, l = !1, d = 0, f = 0, h = 1, p = !1, g = 0, m = 0, y = 0, w = 0, S = 0;
  const sx = G.morphShotSet, ix = G.morphShotSeconds, ax = 1.5, rx = .1, nx = Math.PI;
  const nc = e2 => ix[e2] ?? 2.5;
  const b = () => {
    const v = i == null ? null : G.stateMorphMap[i], T = y;
    i !== a && (a = i, i != null && (y = g, l = !1));
    let A = v != null;
    i != null && sx.has(i) && (!l && g - y > nc(i) ? (l = !0, d = g) : l && g - d > ax && (l = !1, y = g), A = !l),
      r.t = A ? 1 : 0,
      v != null && v !== c && (c != null && r.x > .02 ? (u = c, w = m, S = T, o.x = t ? 1 : 0) : (u = null, o.x = 1), o.v = 0, o.t = 1, c = v, m = g),
      v == null && r.x < .004 && (c = null, u = null),
      o.x > .996 && (u = null),
      A !== p && (A && !t && (h = n() < .5 ? 1 : -1), t || (f += nx * h, s.t = f), p = A);
  };
  return {
    get target() { return i; },
    set(v) { i = v; },
    advance(v) {
      const T = v > 0 ? Math.min(v, rx) : 0;
      g += T, b();
      const A = Bf(T), F = T / A;
      for (let N = 0; N < A; N++) Eo(r, 14, 1, F), Eo(o, 11, 1, F), Eo(s, 14, 1, F);
      t && (o.x = 1, s.x = s.t, r.x = r.t);
    },
    settle() { b(); for (const v of [r, o, s]) v.x = v.t, v.v = 0; b(); },
    snapshot() {
      return {
        amount: le(r.x, 0, 1), spin: s.x, kind: c, outgoing: u, swap: le(o.x, 0, 1),
        clock: { stateTime: g - m, shotTime: g - y }, outgoingClock: { stateTime: g - w, shotTime: g - S },
        isReducedMotion: t,
        isSettled: Math.abs(r.x - r.t) < .001 && Math.abs(s.t - s.x) < .01 && o.x > .996,
      };
    },
  };
}

// ============================================================
// clip 规范化 kx / 求值 vt / rest 帧 ul / 相似判定 wx / bridge bx
// ============================================================
const mx = ({ t: e, v: t, ease: n }, nr) => ({ t: e, v: typeof t == "string" ? [] : t, ease: n?.length === 4 ? n : nr }); // mx
const gx = (e, G) => [{ t: e, v: [0], ease: G.nr }, { t: e + G.na * .45, v: [1], ease: G.nr }, { t: e + G.na, v: [0], ease: G.nr }]; // gx：blink 事件→lids 关键帧
function kx(e, G) { // kx
  const t = new Map;
  for (const [i, a] of Object.entries(e.tracks)) {
    const c = G.trackAliases.get(i);
    c !== void 0 && t.set(c, a);
  }
  const n = i => (t.get(i) ?? []).map(kf => mx(kf, G.nr)), r = n("lids"), o = [];
  let s = !1;
  for (const i of t.get("expression") ?? []) {
    if (i.v === "blink") { s = !0, r.push(...gx(i.t, G)); continue; }
    o.push({ t: i.t, name: typeof i.v == "string" ? G.Mb(i.v) : "neutral", isThroughBlink: i.cut === !1 });
  }
  return s && r.sort((i, a) => i.t - a.t), {
    duration: e.duration, body: G.bodyAlias(e.body ?? "sphere"), squashAnchor: e.squashAnchor ?? 0,
    restTime: e.workArea ? e.workArea.start : 0,
    inspect: { bias: Number.isFinite(e.inspect?.bias) ? le(e.inspect.bias, -1, 1) : void 0, isFollowingTurn: e.inspect?.follow },
    position: n("position"), rotation: n("rotation"), squash: n("squash"), zoom: n("zoom"), lids: r, expression: o,
  };
}
function vt(e, t) { // vt：track 求值
  if (e.length === 0) return null;
  if (t <= e[0].t) return e[0].v;
  const n = e[e.length - 1];
  if (t >= n.t) return n.v;
  let r = 0;
  for (; r < e.length - 2 && e[r + 1].t <= t;) r++;
  const o = e[r], s = e[r + 1], i = (t - o.t) / Math.max(s.t - o.t, 1e-9), a = Qa(i, o.ease);
  return o.v.map((c, u) => c + (s.v[u] - c) * a);
}
function dl(e, t) { let n = "neutral"; for (const r of e) { if (r.t > t + 1e-9) break; n = r.name; } return n; } // dl
function ul(e, G) { // ul：rest 帧
  const t = e.restTime, n = vt(e.rotation, t), r = vt(e.position, t), o = vt(e.squash, t), s = vt(e.zoom, t), i = vt(e.lids, t);
  let a = "neutral", c = !1;
  for (const u of e.expression) c || (a = u.name, c = !0), u.t <= t + 1e-9 && (a = u.name);
  return {
    rot: n ? [n[0], n[1], n[2]] : [0, 0, 0], pos: r ? [r[0], r[1]] : [0, 0],
    scl: o ? [o[0], o[1]] : [1, 1], zoom: s ? s[0] : G.$n,
    lids: i ? le(i[0], 0, 1) : 0, expr: a, squashAnchor: e.squashAnchor,
  };
}
const ai = (e, t) => e + 360 * Math.round((t - e) / 360); // ai
const ci = (e, t) => Math.abs(((e - t) % 360 + 540) % 360 - 180); // ci
function wx(e, t) { // wx：rest 帧相似判定
  return ci(e.rot[0], t.rot[0]) < 4 && ci(e.rot[1], t.rot[1]) < 4 && ci(e.rot[2], t.rot[2]) < 4
    && Math.abs(e.pos[0] - t.pos[0]) < .015 && Math.abs(e.pos[1] - t.pos[1]) < .015
    && Math.abs(e.scl[0] - t.scl[0]) < .02 && Math.abs(e.scl[1] - t.scl[1]) < .02
    && Math.abs(e.zoom - t.zoom) < .02 && Math.abs(e.lids - t.lids) < .05;
}
function bx(e, t, G) { // bx：bridge clip（.35s，ease dx→nr）
  const n = (o, s) => [{ t: 0, v: o, ease: G.dxEase }, { t: G.ta, v: s, ease: G.nr }],
    r = [ai(t.rot[0], e.rot[0]), ai(t.rot[1], e.rot[1]), ai(t.rot[2], e.rot[2])];
  return {
    duration: G.ta, body: null, squashAnchor: e.squashAnchor, restTime: 0, inspect: {},
    position: n(e.pos, t.pos), rotation: n(e.rot, r), squash: n(e.scl, t.scl),
    zoom: n([e.zoom], [t.zoom]), lids: e.lids === 0 && t.lids === 0 ? [] : n([e.lids], [t.lids]), expression: [],
  };
}

// ============================================================
// 注视 al/ex + look xx + poke Xb/Uf
// ============================================================
function al(e, t, n, G) { // al：注视向量→头部旋转+微平移
  const r = e !== "sphere", o = G.gazeShapeMul[e] ?? 1;
  return {
    rx: -(r ? 19 : 14) * o * n, ry: (r ? 26 : 18) * o * t,
    px: (r ? .07 : .03) * t, py: (r ? .055 : .024) * n,
  };
}
const ex = (e, t, n = 2, G) => { // ex：屏幕坐标→±1 注视向量（Jb=2）
  const r = Math.max(e.width, 1) * n, o = s => le(s, -1, 1);
  return [o((t.x - (e.left + e.width / 2)) / r), o(-(t.y - (e.top + e.height / 2)) / r)];
};
const XX = { // xx：look 预设
  left: { rot: [0, -20, 0], pos: [-.1, 0] }, right: { rot: [0, 20, 0], pos: [.1, 0] },
  up: { rot: [-20, 0, 0], pos: [0, .1] }, down: { rot: [20, 0, 0], pos: [0, -.1] }, center: { rot: [0, 0, 0], pos: [0, 0] },
};
function Uf({ poke: e, turns: t }) { // Uf：poke 时长
  switch (e) { case "spin": return .9 + .4 * (t - 1); case "bounce": return .62; case "nod": return .5; }
}
function Xb(e) { // Xb：poke 冲量合成 {pitch,yaw,lift,squash}
  let t = 0, n = 0, r = 0, o = 1, s = 1;
  for (const i of e) {
    const a = Math.min(1, i.t / Uf(i));
    switch (i.poke) {
      case "spin": n += 180 * i.turns * (1 - Math.cos(Math.PI * a)); break;
      case "nod": t += 16 * fo(a, 0, 1); break;
      case "bounce": {
        const c = fo(a, 0, .18) + fo(a, .82, 1), u = fo(a, .18, .82);
        r += .3 * Math.sin(Math.PI * le((a - .14) / .72, 0, 1)), o *= 1 + .08 * c - .04 * u, s *= 1 - .1 * c + .06 * u;
        break;
      }
    }
  }
  return { pitch: t, yaw: n, lift: r, squash: [o, s] };
}

// ============================================================
// 运动运行时 Yf
// ============================================================
function createRuntime(G, e = {}) {
  const t = le(e.zoomMul || 1, .2, 3), n = createFace(G);
  let r = e.body ?? "sphere", o = e.body !== void 0, s = [];
  const i = To(1), a = createMorphBehavior(G, { isReducedMotion: e.isReducedMotion });
  let c = null, u = [...G.baseEulerDeg], l = [0, 0], d = [1, 1], f = 0, h = G.$n * t,
    p = { bias: -1, isFollowingTurn: !0 }, g = null,
    m = { isHeld: !1, isAlways: e.isGazeAlways ?? !1, x: 0, y: 0, cx: 0, cy: 0, hold: 0 },
    y = G.restClip, w = 0, S = !1, b = !0, v = !1, T = null, A = null, F = null,
    N = 0, R = 0, B = null, E = null, I = !1, _ = [];
  const O = () => { // 采样当前 clip 各 track
    const $ = vt(y.position, w); l = $ ? [$[0], $[1]] : [0, 0];
    const q = vt(y.rotation, w); u = q ? [q[0], q[1], q[2]] : [0, 0, 0];
    const U = vt(y.squash, w); d = U ? [U[0], U[1]] : [1, 1];
    const P = vt(y.zoom, w); P && (h = le(P[0], .25, 2.5) * t);
  }, H = $ => { (n.blinkAmount() ?? fe()) > 0 ? E = $ : ($(), K()); },
    L = ($, q) => { if (B == null) for (const U of y.expression) U.t <= $ || U.t > q || H(() => n.play(U)); },
    j = $ => { w = $, g = null, E = null, O(), n.seek(y.expression, $), B != null && n.seek([{ t: 0, name: B, isThroughBlink: !1 }], 0); },
    J = () => { const $ = vt(y.lids, w); return $ ? le($[0], 0, 1) : 0; },
    fe = () => I ? 0 : J(),
    K = () => { !G.Tb(n.name) || n.isMorphing ? I = !0 : I && J() === 0 && (I = !1); },
    te = () => ({ rot: u, pos: l, scl: d, zoom: h / t, lids: fe(), expr: n.name, squashAnchor: f }),
    Z = $ => { S = !1, y = $, w = 0, f = $.squashAnchor, $.body != null && !o && (r = $.body), p = { bias: $.inspect.bias ?? p.bias, isFollowingTurn: $.inspect.isFollowingTurn ?? p.isFollowingTurn }; },
    D = $ => {
      if (A = null, Z($.clip), T = { clip: $.clip, name: $.name }, b = !0, !$.isPlaying) { j(0), $.isRest && (m = { ...m, hold: 0 }); return; }
      S = !0, $.phase > 0 && j($.phase * $.clip.duration), n.release(), $.phase <= 0 && L(-1e-9, 0);
    },
    Gx = $ => { const q = te(), U = ul($.clip, G); A = $, Z(bx(q, U, G)), b = !1, S = !0, B == null && q.expr !== U.expr && H(() => n.morph(U.expr)); },
    Y = () => A != null || T == null || wx(te(), ul(T.clip, G)) ? !1 : (Gx({ ...T, isPlaying: !0, phase: 0, isRest: !1 }), !0),
    Q = $ => {
      const q = w; let U = q + $;
      if (U >= y.duration) {
        if (L(q, y.duration), b) {
          if (R += 1, Y()) return;
          U = U - y.duration, U >= y.duration && (U = 0), L(-1e-9, U), w = U;
        } else w = y.duration, S = !1, A != null && D(A);
      } else L(q, U), w = U;
      g = null, O();
    },
    ne = ($, q) => { const U = $ + (q - $) * G.Yb; return Math.abs(q - U) < G.Ax ? q : U; },
    se = () => {
      if (v || !m.isHeld && m.hold === 0 || (m = { ...m, cx: ne(m.cx, m.x), cy: ne(m.cy, m.y), hold: ne(m.hold, m.isHeld ? 1 : 0) }, S)) return;
      O();
      const $ = al(r, m.cx, m.cy, G), { hold: q } = m;
      u = [u[0] + ($.rx - u[0]) * q, u[1] + ($.ry - u[1]) * q, u[2] * (1 - q)],
        l = [l[0] + ($.px - l[0]) * q, l[1] + ($.py - l[1]) * q];
    },
    ee = $ => { // look 补间
      if (g == null) return;
      const q = g.t + $, U = Math.min(q / G.Sx, 1), P = Qa(U, G.vxEase), { fromRot: C2, toRot: z, fromPos: W, toPos: V } = g;
      u = [C2[0] + (z[0] - C2[0]) * P, C2[1] + (z[1] - C2[1]) * P, C2[2] + (z[2] - C2[2]) * P],
        l = [W[0] + (V[0] - W[0]) * P, W[1] + (V[1] - W[1]) * P],
        U >= 1 ? (u = z, l = V, g = null) : g = { ...g, t: q };
    },
    me = () => { // 身体交叉淡化权重
      if (s.length === 0) return [{ body: r, weight: 1 }];
      const $ = Qo(le(i.x, 0, 1)), q = new Map;
      for (const C2 of s) q.set(C2.body, (q.get(C2.body) ?? 0) + C2.weight * (1 - $));
      q.set(r, (q.get(r) ?? 0) + $);
      const U = [...q].filter(([, C2]) => C2 > G.Ex), P = U.reduce((C2, [, z]) => C2 + z, 0);
      return U.map(([C2, z]) => ({ body: C2, weight: z / P }));
    },
    de = $ => { $ !== r && (s = me(), r = $, i.x = 0, i.v = 0, i.t = 1); },
    xe = $ => {
      if (s.length === 0) return;
      const q = Bf($);
      for (let U = 0; U < q; U++) Eo(i, G.Tx, 1, $ / q);
      Math.abs(i.x - 1) < .001 && Math.abs(i.v) < .01 && (i.x = 1, i.v = 0, s = []);
    },
    Pe = () => n.blinkAmount() ?? fe(),
    be = ($, q) => { // 眼睛描述符（inspect 加权 + 眨眼挤压）
      const U = jb(n.eyes(), q, p, $, G), P = Pe();
      return P <= 1e-4 ? U : [rl(U[0], P, G), rl(U[1], P, G)];
    };
  return {
    get isPlaying() { return S; },
    get time() { return w; },
    get duration() { return y.duration; },
    get loopCount() { return R; },
    get face() { return n.name; },
    get isSettled() {
      const $ = v || m.hold === (m.isHeld ? 1 : 0) && (!m.isHeld || m.cx === m.x && m.cy === m.y);
      return !S && _.length === 0 && s.length === 0 && g == null && E == null && !n.isMorphing && n.blinkAmount() == null && a.snapshot().isSettled && $;
    },
    load($, { isPlaying: q = !0, transition: U = "bridge", phase: P = 0 } = {}) {
      const C2 = $.name || T?.name || "recipe",
        z = { clip: kx($, G), name: C2, isPlaying: q, phase: le(P, 0, 1) % 1, isRest: !1 };
      U === "bridge" && T != null && (A != null || T.name !== C2) ? Gx(z) : D(z);
    },
    play() { v = !1, S = !0; },
    pause() { v = !0, S = !1; },
    stop() { S = !1, j(0); },
    rest() {
      v = !1;
      const $ = { clip: G.restClip, name: "rest", isPlaying: !1, phase: 0, isRest: !0 };
      if (A == null && (T == null || T.name === "rest")) { T == null && D($); return; }
      Gx($);
    },
    seek: j,
    setBody($, { isInstant: q = !1 } = {}) {
      if (o = !0, !q) { de($); return; }
      r = $, s = [], i.x = 1, i.v = 0;
    },
    setMorph($, { isInstant: q = !1 } = {}) { a.set($), q && a.settle(); },
    setExpression($, { isThroughBlink: q = !1 } = {}) {
      H(() => { q && !G.Lr($) && !G.Lr(n.name) ? n.lidMorph($) : n.morph($); });
    },
    holdFace($) {
      $ !== B && (B = $, H(() => {
        const q = B ?? (A == null ? dl(y.expression, w) : dl(A.clip.expression, 0));
        q !== n.name && n.morph(q);
      }));
    },
    poke($, { turns: q = 1 } = {}) { _ = [..._, { poke: $, t: 0, turns: Math.max(1, Math.round(q)) }]; },
    blink() { n.blink(); },
    setInspect({ bias: $, isFollowingTurn: q }) {
      p = { bias: $ === void 0 ? p.bias : le($, -1, 1), isFollowingTurn: q ?? p.isFollowingTurn };
    },
    setGaze($) {
      if ($ == null) { m = { ...m, isHeld: !1 }; return; }
      const q = le($[0] || 0, -1, 1), U = le($[1] || 0, -1, 1);
      m = m.hold === 0 ? { ...m, isHeld: !0, x: q, y: U, cx: q, cy: U } : { ...m, isHeld: !0, x: q, y: U };
    },
    setGazeAlways($) { m = { ...m, isAlways: $ }; },
    look($) { const q = XX[$]; g = { t: 0, fromRot: u, toRot: q.rot, fromPos: l, toPos: q.pos }; },
    setGlow($) { F = $; },
    advance($) {
      se();
      const q = Math.min($, G.Mx), U = 1 - a.snapshot().amount;
      if (S && Q(q * U), ee(q), n.step(q), E != null && (n.blinkAmount() ?? fe()) === 0) {
        const C2 = E; E = null, C2();
      }
      K(), xe(q), _ = _.map(C2 => ({ ...C2, t: C2.t + q })).filter(C2 => C2.t < Uf(C2)), a.advance(q);
      const P = a.snapshot();
      P.amount > 0 || !P.isSettled ? c ??= [ui(u[0]), ui(u[1]), ui(u[2])] : c = null, N += $;
    },
    frame() {
      const $ = m.isAlways && S && !v ? al(r, m.cx, m.cy, G) : null, q = G.Zb * m.hold, U = Xb(_),
        P = [u[0] + ($ ? $.rx * q : 0) + U.pitch, u[1] + ($ ? $.ry * q : 0) + U.yaw, u[2]],
        C2 = [l[0] + ($ ? $.px * q : 0), l[1] + ($ ? $.py * q : 0) + U.lift],
        z = [d[0] * U.squash[0], d[1] * U.squash[1]],
        W = n.inspectWeight(), V = a.snapshot(), X = 1 - V.amount,
        ie = V.spin % TAU / DEG, he = c ?? [0, 0, 0], pe = ue => he[ue] + (P[ue] - he[ue]) * X, ge = pe(1);
      return {
        body: r, quat: lb(pe(0) * DEG, (ge + ie) * DEG, pe(2) * DEG), zoom: h,
        offset: X === 1 ? C2 : [C2[0] * X, C2[1] * X],
        squash: X === 1 ? z : [1 + (z[0] - 1) * X, 1 + (z[1] - 1) * X],
        squashAnchor: f, eyes: V.amount >= G.Px ? null : be(ge, W),
        glow: F && { ...F, midT: .5 + .5 * Math.sin(N * 1e3 / 860) },
        inspectWeight: W, bodies: me(), morph: V.kind === null && V.isSettled ? null : V,
      };
    },
  };
}
const ui = e => 360 * Math.round(e / 360); // ui

// ============================================================
// 状态机 Nx
// ============================================================
function createStateMachine(G, e, t, n = {}) { // Nx(runtime, initialState, opts)
  const r = tc(n.seed ?? 1), o = new Map;
  let s = n.isCompact ?? !1, i = n.isResting ?? !1, a = !1, c = i, u = t, l = G.states[t], d = 0, f = 0, h = e.loopCount, p = null;
  const g = () => s && l.compactClips != null ? l.compactClips : l.clips,
    m = () => l.next != null && l.holdSeconds == null,
    y = () => {
      const v = g(), T = o.get(v) ?? [];
      return T.length === 0 && T.push(...Lx(v, r, p)), o.set(v, T), T.shift();
    },
    w = () => {
      const v = m() ? g()[f] : y();
      if (h = e.loopCount, v === void 0 || v === p) return;
      const T = c || m(), clip = G.clipByName(v);
      e.load(clip, { phase: T ? 0 : n.firstPhase ?? r() }), c = !0, p = v, h = e.loopCount;
    },
    S = () => { e.holdFace(l.face ?? (a ? "surprised" : null)); },
    b = v => { u = v, l = G.states[v], d = 0, f = 0, e.setMorph(l.morph ?? null), S(), i || w(); };
  return i && e.rest(), b(t), {
    get state() { return u; },
    get clip() { return p; },
    setState(v) { v !== u && G.states[v] && b(v); },
    setCompact(v) { s = v; },
    setEmphasis(v) { v !== a && (a = v, S()); },
    setResting(v) {
      if (v !== i) {
        if (i = v, !i) { w(); return; }
        e.rest(), p = null;
      }
    },
    advance(v) {
      if (i) return;
      d += v;
      const T = l.next;
      if (T != null && l.holdSeconds != null && d >= l.holdSeconds) { b(T); return; }
      if (e.loopCount !== h) {
        if (T != null && l.holdSeconds == null && (f += 1, f >= g().length)) { b(T); return; }
        w();
      }
    },
  };
}

// jb：inspect 加权（眼睛大小随 yaw 偏向）
function jb(e, t, n, r, G) {
  if (t < .001) return e;
  const o = n.isFollowingTurn ? le(r / G.Ib, -1, 1) : n.bias,
    [s, i] = G.expressions.inspecting, a = Math.max(1e-4, s.wid), c = Math.max(1e-4, i.wid), u = (1 + o) / 2,
    l = (d, f) => {
      const h = 1 + (f - 1) * t;
      return { ...wt(d), wid: d.wid * h, pts: d.pts.map(p => [p[0] * h, p[1] * h]) };
    };
  return [l(e[0], Math.pow(c / a, u)), l(e[1], Math.pow(a / c, u))];
}

// ============================================================
// 眼睛 SDF 轮廓追踪（sT/aT/iT/cT + UM marching squares）
// ============================================================
const BM = 60, HM = 256, VM = 24, GM = 2e4, WM = .2;
const JM = .02, eT = 16, tT = .015, nT = 400, rT = 512, ls = 5;
const kn = new Map; // oT 缓存（LRU）
const uT = (e, t, n) => Jo(le((n - e) / (t - e), 0, 1)); // uT
function sT(e) { // sT：眼睛描述符→SDF 场描述
  const [t, n] = e.oval,
    o = t > 1e-5 && n > 1e-5 ? e.ovalMix > 1e-4 ? Math.min(1, e.ovalMix) : uT(0, .08, Math.min(t, n)) : 0,
    s = Math.max(0, e.pts.length - 1), i = new Float64Array(s * ls);
  for (let a = 0; a < s; a++) {
    const [c, u] = e.pts[a], l = e.pts[a + 1][0] - c, d = e.pts[a + 1][1] - u, f = l * l + d * d;
    i.set([c, u, l, d, f > 0 ? 1 / f : 0], a * ls);
  }
  return { segments: i, halfWidth: e.wid > 0 ? e.wid : -1, rx: t, ry: n, ellipseMix: o };
}
function aT(e, t, n) { // aT：脊线折线距离
  let r = 1e6;
  for (let o = 0; o < e.length; o += ls) {
    const s = t - e[o], i = n - e[o + 1], a = e[o + 2], c = e[o + 3],
      u = (s * a + i * c) * e[o + 4], l = u < 0 ? 0 : u > 1 ? 1 : u, d = s - a * l, f = i - c * l, h = d * d + f * f;
    h < r && (r = h);
  }
  return Math.sqrt(r);
}
function iT(e, t, n) { // iT：混合 SDF（stadium↔ellipse）
  const r = aT(e.segments, t, n) - e.halfWidth;
  if (e.ellipseMix === 0) return r;
  const o = t / e.rx, s = n / e.ry, i = (Math.sqrt(o * o + s * s) - 1) * Math.min(e.rx, e.ry);
  return r * (1 - e.ellipseMix) + i * e.ellipseMix;
}
function cT(e, t) { // cT：等值线追踪入口
  let n = 1 / 0, r = 1 / 0, o = -1 / 0, s = -1 / 0, i = 1 / 0;
  const { segments: a, halfWidth: c } = e;
  if (c > 0 && e.ellipseMix < 1 && a.length > 0) {
    for (let d = 0; d < a.length; d += ls)
      for (const [f, h] of [[a[d], a[d + 1]], [a[d] + a[d + 2], a[d + 1] + a[d + 3]]])
        n = Math.min(n, f - c), r = Math.min(r, h - c), o = Math.max(o, f + c), s = Math.max(s, h + c);
    i = c;
  }
  if (e.ellipseMix > 0 && (n = Math.min(n, -e.rx), r = Math.min(r, -e.ry), o = Math.max(o, e.rx), s = Math.max(s, e.ry), i = Math.min(i, e.rx, e.ry)), !(o > n && s > r)) return [];
  const u = Math.max(Math.min(tT, i / 3), Math.max(o - n, s - r) / nT),
    l = { x0: n - 2 * u, y0: r - 2 * u, step: u, nx: Math.ceil((o - n) / u) + 4, ny: Math.ceil((s - r) / u) + 4 };
  return UM((d, f) => iT(e, d, f), l, { deviation: t, edge: Math.sqrt(4 * t) });
}
function oT(e, t) { // oT：带 LRU 缓存的轮廓提取
  const n = Math.min(eT, Math.max(0, Math.ceil(Math.log2(Math.max(t, 1))))),
    r = `${n}|${e.wid}|${e.oval.join()}|${e.ovalMix}|${e.pts.join()}`,
    o = kn.get(r);
  if (o !== void 0) return kn.delete(r), kn.set(r, o), o;
  const s = cT(sT(e), JM / 2 ** n);
  if (kn.set(r, s), kn.size > rT) { const i = kn.keys().next(); i.done !== !0 && kn.delete(i.value); }
  return s;
}
// UM：marching squares + 自适应细分 + 多边形简化
function UM(e, t, n) {
  const r = { field: e, tolerance: n, root: n.deviation * .001, reach: t.step * Math.hypot(t.nx, t.ny) }, o = [];
  for (const s of KM(r, t)) { const i = ZM(XM(r, s), n); i.length >= 3 && o.push(i); }
  return o;
}
function KM(e, t) { // KM：网格采样 + 边交叉图 + 环追踪
  const { field: n } = e, { x0: r, y0: o, step: s, nx: i, ny: a } = t, c = i + 1, u = new Float64Array(c * (a + 1));
  for (let b = 0; b <= a; b++) for (let v = 0; v <= i; v++) u[b * c + v] = n(r + v * s, o + b * s);
  const l = 2 * c * (a + 1), d = new Int32Array(l).fill(-1), f = new Map,
    h = b => {
      const v = f.get(b);
      if (v !== void 0) return v;
      const T = b >> 1, A = b & 1 ? T + c : T + 1, F = r + T % c * s, N = o + Math.floor(T / c) * s,
        R = r + A % c * s, B = o + Math.floor(A / c) * s, E = Ah(e, F, N, u[T], R, B, u[A]),
        I = [F + (R - F) * E, N + (B - N) * E];
      return f.set(b, I), I;
    },
    p = [0, 0, 0, 0], g = [0, 0, 0, 0], m = [], y = [];
  for (let b = 0; b < a; b++) for (let v = 0; v < i; v++) {
    const T = b * c + v;
    p[0] = T, p[1] = T + 1, p[2] = T + 1 + c, p[3] = T + c, g[0] = 2 * T, g[1] = 2 * (T + 1) + 1, g[2] = 2 * (T + c), g[3] = 2 * T + 1, m.length = 0, y.length = 0;
    for (let A = 0; A < 4; A++) {
      const F = u[p[A]] < 0, N = u[p[A + 1 & 3]] < 0;
      F !== N && (m.push(g[A]), y.push(F));
    }
    if (m.length === 2) { const A = y[0] ? 0 : 1; d[m[A]] = m[1 - A]; }
    else if (m.length === 4) {
      const A = n(r + (v + .5) * s, o + (b + .5) * s) < 0;
      for (let F = 0; F < 4; F++) y[F] && (d[m[F]] = m[F + (A ? 1 : 3) & 3]);
    }
  }
  const w = [], S = new Uint8Array(l);
  for (let b = 0; b < l; b++) {
    if (d[b] < 0 || S[b]) continue;
    const v = [];
    let T = b;
    for (; T >= 0 && !S[T];) S[T] = 1, v.push(h(T)), T = d[T];
    T === b && w.push(v);
  }
  return w;
}
function Ah(e, t, n, r, o, s, i) { // Ah：Brent-Dekker 求根
  let a = 0, c = r, u = 1, l = i, d = 0, f = 0;
  for (let h = 0; h < BM; h++) {
    f = (a * l - u * c) / (l - c);
    const p = e.field(t + (o - t) * f, n + (s - n) * f);
    if (Math.abs(p) <= e.root || u - a <= 1e-15) break;
    p < 0 == l < 0 ? (u = f, l = p, d === -1 && (c /= 2), d = -1) : (a = f, c = p, d === 1 && (l /= 2), d = 1);
  }
  return f;
}
function XM(e, t) { // XM：细分到容差
  const n = [];
  for (let r = 0; r < t.length; r++) {
    const o = t[r], s = t[(r + 1) % t.length];
    o[0] === s[0] && o[1] === s[1] || (n.push(o), fa(e, o, s, 0, n));
  }
  return n;
}
function fa(e, t, n, r, o) { // fa：自适应中点细分（带曲率守卫 YM）
  const s = n[0] - t[0], i = n[1] - t[1], a = Math.sqrt(s * s + i * i);
  if (a === 0 || r >= VM || o.length >= GM) return;
  const c = (t[0] + n[0]) / 2, u = (t[1] + n[1]) / 2, l = e.field(c, u);
  if (!Number.isFinite(l)) return;
  const d = l > 0 ? 1 : -1, f = -i / a * d, h = s / a * d, p = Ih(e, c, u, l, f, h);
  if (p === null || p <= e.tolerance.deviation / 2 && a <= e.tolerance.edge) return;
  const g = l > 0 ? YM(e, c, u, l, f, h, p) : [c + f * p, u + h * p];
  fa(e, t, g, r + 1, o), o.push(g), fa(e, g, n, r + 1, o);
}
function YM(e, t, n, r, o, s, i) { // YM：曲率大时沿梯度修正中点
  const a = [t + o * i, n + s * i], c = i * .001,
    u = e.field(t + c, n) - e.field(t - c, n), l = e.field(t, n + c) - e.field(t, n - c),
    d = Math.sqrt(u * u + l * l);
  if (d === 0) return a;
  const f = u * s - l * o < 0 ? -1 : 1, h = -l / d * f, p = u / d * f;
  if (h * o + p * s < WM) return a;
  const g = Ih(e, t, n, r, h, p);
  return g === null || g * (h * o + p * s) <= i ? a : [t + h * g, n + p * g];
}
function Ih(e, t, n, r, o, s) { // Ih：沿法线行进求交
  if (r === 0) return 0;
  let i = 0, a = r;
  for (let c = 0; c < HM; c++) {
    const u = i + Math.max(Math.abs(a), e.root);
    if (u > e.reach) return null;
    const l = t + o * u, d = n + s * u, f = e.field(l, d);
    if (f < 0 != r < 0) return i + (u - i) * Ah(e, t + o * i, n + s * i, a, l, d, f);
    i = u, a = f;
  }
  return null;
}
function ZM(e, t) { // ZM：Douglas-Peucker 式简化
  const n = e.length;
  if (n < 4) return e;
  const r = new Uint8Array(n);
  let o = 0, s = -1;
  for (let a = 1; a < n; a++) { const c = ud(e[0], e[a]); c > s && (s = c, o = a); }
  r[0] = 1, r[o] = 1;
  const i = (a, c) => {
    if (c - a < 2) return;
    const u = e[a], l = e[c % n];
    let d = -1, f = a;
    for (let p = a + 1; p < c; p++) { const g = QM(e[p], u, l); g > d && (d = g, f = p); }
    const h = d > t.deviation / 2;
    !h && Math.sqrt(ud(u, l)) <= t.edge || (h || (f = a + c >> 1), r[f] = 1, i(a, f), i(f, c));
  };
  return i(0, o), i(o, n), e.filter((a, c) => r[c] === 1);
}

// ============================================================
// 球面映射 ST/RM + squash 裁剪 $M + cutout OM + 路径 ha/pa
// ============================================================
function ST(e, t, n, r, o) { // ST：眼睛描述符→球面 path 环
  const s = oT(e, o * Math.max(1, e.lidY));
  if (s.length === 0) return [];
  const i = Et(r, t.M), a = Et(r, t.C), c = Et(r, t.T),
    u = Math.atan2(i[1], i[0]), l = Math.cos(e.tilt), d = Math.sin(e.tilt), [f, h] = e.off,
    p = ([m, y]) => { // 罗德里格斯：2D 脊线坐标 → 单位球面 3D
      const w = y * e.lidY, S = f + l * m + d * w, b = h - d * m + l * w, v = Math.sqrt(S * S + b * b),
        T = v > 1e-12 ? Math.sin(v) / v : 1, A = Math.cos(v);
      return [A * i[0] + T * (S * a[0] + b * c[0]), A * i[1] + T * (S * a[1] + b * c[1]), A * i[2] + T * (S * a[2] + b * c[2])];
    },
    g = [];
  for (const m of s) { const y = m.map(p); n && y.reverse(); const w = RM(y, u); w !== null && g.push(w); }
  return g;
}
function sd(e, t) { // sd：z=0 交点（归一到单位圆）
  const n = e[2] / (e[2] - t[2]), r = e[0] + (t[0] - e[0]) * n, o = e[1] + (t[1] - e[1]) * n, s = Math.sqrt(r * r + o * o);
  return [r / s, o / s];
}
const CM = [1, 1];
function id(e, t, n) { // id：地平线弧
  const r = cd(Math.atan2(t[1], t[0]) - n) - cd(Math.atan2(e[1], e[0]) - n);
  return { kind: "arc", to: t, radii: CM, sweep: r };
}
function RM(e, t) { // RM：前半球 z>0 裁剪
  const n = e.length;
  let r = -1;
  for (let a = 0; a < n && r < 0; a++) e[a][2] <= 0 && e[(a + 1) % n][2] > 0 && (r = a);
  if (r < 0) return n === 0 || e[0][2] <= 0 ? null : e.map(([a, c]) => ({ kind: "line", to: [a, c] }));
  const o = [];
  let s = [1, 0], i = null;
  for (let a = 0; a < n; a++) {
    const c = e[(r + a) % n], u = e[(r + a + 1) % n], l = c[2] > 0, d = u[2] > 0;
    if (l && d) o.push({ kind: "line", to: [u[0], u[1]] });
    else if (l) i = sd(c, u), o.push({ kind: "line", to: i });
    else if (d) {
      const f = sd(c, u);
      i === null ? s = f : o.push(id(i, f, t)), o.push({ kind: "line", to: [u[0], u[1]] });
    }
  }
  return i !== null && o.push(id(i, s, t)), o;
}
function xT(e, kT) { // xT：弧线按 kT 步长细分为点
  const t = [];
  let n = e[e.length - 1]?.to ?? [0, 0];
  for (const r of e) {
    if (r.kind === "arc") {
      const o = Math.atan2(n[1], n[0]), s = Math.max(1, Math.ceil(Math.abs(r.sweep) / kT));
      for (let i = 1; i < s; i++) t.push(Ph(r.radii, o + r.sweep * i / s));
    }
    t.push(r.to), n = r.to;
  }
  return t;
}
function Ph(e, t) { // Ph：椭圆上一点
  const n = Math.cos(t), r = Math.sin(t), o = 1 / Math.sqrt(n * n / (e[0] * e[0]) + r * r / (e[1] * e[1]));
  return [o * n, o * r];
}
function zr(e, t) { // zr：椭圆 path（两段半弧）
  return [{ kind: "arc", to: [-e[0], 0], radii: e, sweep: t * Math.PI }, { kind: "arc", to: [e[0], 0], radii: e, sweep: t * Math.PI }];
}
// —— squash<1 时把眼睛环裁剪到身体椭圆（$M/LM/NM/FM） ——
function NM(e, t, n, r) { // NM：线段×椭圆交点参数
  const o = t[0] - e[0], s = t[1] - e[1], i = n * o * o + r * s * s, a = n * e[0] * o + r * e[1] * s,
    c = n * e[0] * e[0] + r * e[1] * e[1] - 1, u = a * a - i * c;
  if (i === 0 || u <= 0) return [];
  const l = Math.sqrt(u), d = -(a + (a < 0 ? -l : l));
  return [d / i, c / d].filter(f => f > 0 && f < 1).sort((f, h) => f - h);
}
function FM(e, t, n, r, o) { // FM：圆弧×椭圆交点参数
  if (r === o || n === 0) return [];
  const s = (1 / (e * e) - o) / (r - o);
  if (!(s > 0 && s < 1)) return [];
  const i = Math.acos(Math.sqrt(s)), a = [];
  for (const c of [i, -i, Math.PI - i, Math.PI + i]) {
    const l = (n > 0 ? Dr(c - t) : Dr(t - c)) / Math.abs(n);
    l > 0 && l < 1 && a.push(l);
  }
  return a.sort((c, u) => c - u);
}
function LM(e, t) { // LM：按椭圆内外拆分 path 段
  const n = 1 / (t[0] * t[0]), r = 1 / (t[1] * t[1]), o = a => n * a[0] * a[0] + r * a[1] * a[1] - 1, s = [];
  let i = e[e.length - 1].to;
  for (const a of e) {
    if (a.kind === "line") {
      const c = NM(i, a.to, n, r);
      let u = i;
      for (let l = 0; l <= c.length; l++) {
        const d = l === 0 ? 0 : c[l - 1], f = l === c.length ? 1 : c[l], h = l === c.length ? a.to : ad(i, a.to, f);
        s.push({ from: u, segment: { kind: "line", to: h }, sweep: Math.atan2(u[0] * h[1] - u[1] * h[0], u[0] * h[0] + u[1] * h[1]), isInside: o(ad(i, a.to, (d + f) / 2)) < 0 }), u = h;
      }
    } else {
      const c = a.radii[0], u = Math.atan2(i[1], i[0]), l = FM(c, u, a.sweep, n, r);
      let d = i;
      for (let f = 0; f <= l.length; f++) {
        const h = f === 0 ? 0 : l[f - 1], p = f === l.length ? 1 : l[f], g = u + a.sweep * p,
          m = f === l.length ? a.to : [c * Math.cos(g), c * Math.sin(g)], y = u + a.sweep * (h + p) / 2, w = a.sweep * (p - h);
        s.push({ from: d, segment: { kind: "arc", to: m, radii: a.radii, sweep: w }, sweep: w, isInside: o([c * Math.cos(y), c * Math.sin(y)]) < 0 }), d = m;
      }
    }
    i = a.to;
  }
  return s;
}
function $M(e, t) { // $M：path 环 → 椭圆内部分（外部以椭圆弧连接）
  const n = LM(e, t), r = n.length;
  if (n.every(c => c.isInside)) return e;
  let o = -1;
  for (let c = 0; c < r && o < 0; c++) n[c].isInside && !n[(c + r - 1) % r].isInside && (o = c);
  if (o < 0) { const c = n.reduce((u, l) => u + l.sweep, 0); return Math.abs(c) > Math.PI ? zr(t, Math.sign(c)) : null; }
  const s = [];
  let i = null, a = 0;
  for (let c = 0; c < r; c++) {
    const u = n[(o + c) % r];
    u.isInside ? (i !== null && s.push({ kind: "arc", to: u.from, radii: t, sweep: a }), i = null, s.push(u.segment))
      : (i === null && (i = u.from, a = 0), a += u.sweep);
  }
  return i !== null && s.push({ kind: "arc", to: n[o].from, radii: t, sweep: a }), s;
}
// —— cutout：把眼睛地平线弧替换进身体轮廓（OM/zM/DM/jM/qM） ——
function zM(e, t) { // zM：反转子环
  const n = [e, ...t.map(o => o.to)],
    r = t.map((o, s) => o.kind === "line" ? { kind: "line", to: n[s] } : { ...o, to: n[s], sweep: -o.sweep }).reverse();
  return { from: n[n.length - 1], to: e, segments: r };
}
function DM(e, t, n, k) { // DM：身体椭圆上的补弧（方向必须与眼链对咬：h.to → h.from）
  const r = n.map(s => ({ point: s, angle: Dr(Math.atan2(s[1], s[0])) })).sort((s, i) => s.angle - i.angle), o = [];
  for (let s = 0; s < r.length; s++) {
    const i = r[s], a = r[(s + 1) % r.length], c = s + 1 < r.length ? a.angle - i.angle : a.angle + TAU - i.angle;
    if (c <= 0) continue;
    const u = i.angle + c / 2;
    if (t.reduce((l, d) => l + jM(d, u), 0) !== 0) continue;
    // 升序起点是眼弧 from（负 sweep 眼弧会这样）时反向发射，否则 qM 接不成环 → 闪白
    k && !k.has(`${i.point[0]} ${i.point[1]}`) && k.has(`${a.point[0]} ${a.point[1]}`)
      ? o.push({ from: a.point, to: i.point, segments: [{ kind: "arc", to: i.point, radii: e, sweep: -c }] })
      : o.push({ from: i.point, to: a.point, segments: [{ kind: "arc", to: a.point, radii: e, sweep: c }] });
  }
  return o;
}
function jM(e, t) { // jM：角是否在弧内
  const n = Math.atan2(e.from[1], e.from[0]);
  return (e.sweep > 0 ? Dr(t - n) : Dr(n - t)) < Math.abs(e.sweep) ? Math.sign(e.sweep) : 0;
}
function qM(e) { // qM：链式拼接子环
  const t = s => `${s[0]} ${s[1]}`, n = new Map;
  for (const s of e) { const i = n.get(t(s.from)); i === void 0 ? n.set(t(s.from), [s]) : i.push(s); }
  const r = new Set, o = [];
  for (const s of e) {
    const i = [];
    let a = s;
    for (; a !== void 0 && !r.has(a);) r.add(a), i.push(...a.segments), a = n.get(t(a.to))?.find(c => !r.has(c));
    i.length > 0 && o.push(i);
  }
  return o;
}
function OM(e, t) { // OM：身体轮廓抠掉眼睛
  const n = a => a.kind === "arc" && a.radii[0] === e[0] && a.radii[1] === e[1], r = [], o = [], s = [], i = [], k = new Set;
  for (const a of t) {
    const c = a.findIndex(n);
    if (c < 0) { r.push(a); continue; }
    let u = a[c].to, l = [], d = u;
    for (let f = 1; f <= a.length; f++) {
      const h = a[(c + f) % a.length];
      n(h) ? (s.push({ from: d, sweep: h.sweep }), i.push(d, h.to), k.add(`${h.to[0]} ${h.to[1]}`), l.length > 0 && o.push(zM(u, l)), l = [], u = h.to) : l.push(h), d = h.to;
    }
  }
  return s.length === 0 ? [zr(e, 1), ...r] : [...qM([...o, ...DM(e, s, i, k)]), ...r];
}
// —— path 序列化（ha/pa，kT=π/48 弧细分由调用方 xT 处理或 pa 按 _h 劈开） ——
const _h = Math.PI * .999;
function ha(e, t, n) { // ha：path 环 → SVG d
  let r = e[e.length - 1].to, o = `M${t(r)}`;
  for (const s of e) o += s.kind === "line" ? `L${t(s.to)}` : pa(r, s, t, n), r = s.to;
  return `${o}Z`;
}
function pa(e, t, n, r) { // pa：弧 → SVG A（>π 劈半）
  if (t.sweep === 0) return "";
  if (Math.abs(t.sweep) > _h) {
    const s = t.sweep / 2, i = Ph(t.radii, Math.atan2(e[1], e[0]) + s);
    return pa(e, { ...t, to: i, sweep: s }, n, r) + pa(i, { ...t, sweep: s }, n, r);
  }
  return `A${`${qt(t.radii[0] * r)} ${qt(t.radii[1] * r)}`} 0 0 ${t.sweep > 0 ? 0 : 1} ${n(t.to)}`;
}
const qt = e => String(Math.round(e * 100) / 100); // qt
const od = e => String(Math.round(e * 100) / 100); // od
const Se = (e, t = 2) => { const n = 10 ** t; return String(Math.round(e * n) / n); }; // Se

// ============================================================
// sphere 身体（bT/wT）+ glow（TT/AT）
// ============================================================
const yT = 192, kT = Math.PI / 48;
function Ch(e, t, G) { // Ch：frame→眼睛 path 环（单位球面）
  if (e.eyes === null) return [];
  const n = ir(e.quat), r = [Math.abs(e.squash[0]), Math.abs(e.squash[1])], o = r[0] < 1 || r[1] < 1, s = [];
  return e.eyes.forEach((i, a) => {
    for (const c of ST(i, G.eyeBasis[a], G.eyeMirror[a], n, t)) {
      const u = o ? $M(c, r) : c;
      u !== null && s.push(u);
    }
  }), s;
}
function wT(e, t, n, G) { // wT：sphere → {size, body, eyes, glow}（弧线路径）
  const o = e.zoom * n / 2, [s, i] = e.squash;
  if (o === 0 || s === 0 || i === 0) return { size: n, body: "", eyes: "", glow: null };
  const a = [Math.abs(s), Math.abs(i)], c = n / 2 + o * e.offset[0], u = n / 2 - o * (e.squashAnchor * (1 - i) + e.offset[1]),
    l = h => `${qt(c + h[0] * o)} ${qt(u - h[1] * o)}`,
    d = h => h.map(p => ha(p, l, Math.abs(o))).join(""),
    f = Ch(e, Math.abs(o), G);
  return {
    size: n,
    body: d(t.cutout ? OM(a, f) : [zr(a, 1)]),
    eyes: t.cutout ? "" : d(f),
    glow: e.glow === null ? null : TT(e.glow, a, l, Math.abs(o)),
    center: [c, u], radius: Math.abs(o),
  };
}
const ld = 48, dd = 11, gr = .055;
const hd = (e, t, n) => [e[0] + (t[0] - e[0]) * n, e[1] + (t[1] - e[1]) * n, e[2] + (t[2] - e[2]) * n]; // hd
function Nr(e) { // Nr：rgb 数组→hex
  const t = n => Math.round(le(n, 0, 1) * 255).toString(16).padStart(2, "0");
  return `#${t(e[0])}${t(e[1])}${t(e[2])}`;
}
function AT(e, t, n) { // AT：glow 渐变色（inner→mid→rim 双 smoothstep + 边缘压暗）
  const r = ma(.12, t, n), o = ma(t, .93, n), s = .9 + .1 * Math.max(0, 1 - n * n) ** .225,
    i = a => { const c = e.inner[a] + (e.mid[a] - e.inner[a]) * r; return (c + (e.rim[a] - c) * o) * s; };
  return [i(0), i(1), i(2)];
}
function pd(e, t, n) { return `matrix(${qt(e[0] * n)} 0 0 ${qt(e[1] * n)} ${t([0, 0])})`; } // pd
function TT(e, t, n, r) { // TT：body 49 stops 径向渐变 + halo 环
  const o = .42 + .16 * e.midT, s = [];
  for (let u = 0; u <= ld; u++) { const l = 1 - (1 - u / ld) ** 2; s.push({ offset: l, color: Nr(AT(e, o, l)), opacity: 1 }); }
  const i = { transform: pd(t, n, r), focus: 0, stops: s };
  if (!(e.halo > 0)) return { body: i, halo: null };
  const a = [];
  for (let u = 0; u <= dd; u++) {
    const l = gr * u / dd, d = Math.min(1, e.halo * (1 - ma(0, gr, l)));
    a.push({ offset: (1 + l) / (1 + gr), color: Nr(e.rim), opacity: d });
  }
  const c = [t[0] * (1 + gr), t[1] * (1 + gr)];
  return { body: i, halo: { d: ha(zr(c, 1), n, r) + ha(zr(t, 1), n, r), gradient: { transform: pd(c, n, r), focus: 0, stops: a } } };
}

// ============================================================
// morph 覆盖层：12 生成器 + yE 合成器 + 身体轮廓混合
// ============================================================
function Lh(e, t, n, r, G) { // Lh：dots 的 lift/pop/tone
  const o = Bt(e.stateTime * 1e3 / G.FT + .119), s = Math.abs(o - t / 3), i = Math.min(s, 1 - s),
    a = r ? 1 : Math.exp(-(i * i) / (2 * .15 * .15)), c = r ? 0 : 1;
  return { lift: a * G.NT * n * c, pop: 1 + c * (G.$T + G.OT * a - 1), tone: 1 - c * .5 * (1 - a) };
}
const ZT = e => .42 + .29 * Math.sin(e * .0021) * Math.sin(e * .0034) + .29 * Math.sin(e * .0013 + 1.7); // ZT
const QT = (e, t) => ZT(e) * (.55 + .45 * Math.sin(e * .012 - Math.abs(t) * 1.05)); // QT
const JT = e => -Math.PI * 1.25 + tc(e)() * Math.PI * 1.5; // JT
function eE(e) { // eE：ball 弹跳高度
  const r = 1082.2060353798126, o = 40, s = Math.sqrt(2 * o / r);
  if (e < s) return .5 * r * e * e;
  const i = Bt((e - s) / .62);
  return o - 208 * i * (1 - i);
}
function pc(e, G) { // pc：pencil 书写轨迹
  const t = Bt(e / G.ds);
  if (t < G.Mr) {
    const r = t / G.Mr, o = r * r * (3 - 2 * r), s = le(r / .08, 0, 1) * le((1 - r) / .08, 0, 1);
    return { x: -54 + 118 * o, y: 26, wig: Math.sin(r * 24) * 3.2 * s, rot: 17 + Math.sin(e * 6e-4) * 1 };
  }
  const n = Qo((t - G.Mr) / (1 - G.Mr));
  return { x: 64 - 118 * n, y: 26 - 20 * Math.sin(n * Math.PI), wig: 0, rot: 17 - 2 * Math.sin(n * Math.PI) + Math.sin(e * 6e-4) * 1 };
}
const Nh = (e, G) => { const t = pc(e, G); return [G.x + t.x, G.x + t.y + t.wig + 19]; }; // Nh
function makeTrail(G) { // tE：pencil 墨迹采样点缓存
  const e = [];
  for (let t = 0; t < G.Co; t++) {
    const n = Nh(t, G), r = e[e.length - 1];
    (r === void 0 || Math.hypot(n[0] - r.point[0], n[1] - r.point[1]) > G.zT) && e.push({ at: t, point: n });
  }
  return e;
}
function nE(e, G, tE) { // nE：最近 64 点墨迹
  const t = Bt(e / G.ds) * G.ds, n = Math.min(t, G.Co), r = tE.filter(a => a.at <= n),
    o = r.length > 0 ? r[r.length - 1].at : n, s = n > o ? [Nh(n, G)] : [],
    i = [...r.map(a => a.point), ...s].slice(-64);
  return t < G.Co ? i : i.slice(Math.floor((t - G.Co) / 1e3 * G.DT));
}
function rE(e) { // rE：Catmull-Rom → 三次贝塞尔 path
  const t = e.length;
  let n = `M${e[0][0].toFixed(1)} ${e[0][1].toFixed(1)}`;
  if (t === 2) return n + `L${e[1][0].toFixed(1)} ${e[1][1].toFixed(1)}`;
  for (let r = 0; r < t - 1; r++) {
    const o = e[Math.max(r - 1, 0)], s = e[r], i = e[r + 1], a = e[Math.min(r + 2, t - 1)],
      c = s[0] + (i[0] - o[0]) / 6, u = s[1] + (i[1] - o[1]) / 6, l = i[0] - (a[0] - s[0]) / 6, d = i[1] - (a[1] - s[1]) / 6;
    n += `C${c.toFixed(1)} ${u.toFixed(1)} ${l.toFixed(1)} ${d.toFixed(1)} ${i[0].toFixed(1)} ${i[1].toFixed(1)}`;
  }
  return n;
}
const Ht = (e, t, n, r, o) => ({ type: "disc", key: e, cx: t, cy: n, r, opacity: o }); // Ht
const _s = (e, t, n, r, X) => ({ type: "ring", key: e, cx: X, cy: X, r: t, width: n, opacity: r }); // _s（cx/cy 由调用处给 x）
const Oh = (e, t, n, r) => ({ type: "shape", key: e, d: t, transform: n, opacity: r }); // Oh
const XT = (e, t, n, r) => ({ type: "stroke", key: e, d: t, width: n, opacity: r }); // XT

function makeMorphGenerators(G) { // gE 一族（x=设计画布中心 114.2705）
  const x = G.x;
  const oE = (e, t, n) => { // dots
    const r = [x - G.yd, x + G.yd], o = [];
    for (let s = 0; s < 2; s++) {
      const i = le((e - s * .12) / (1 - s * .12), 0, 1);
      if (i <= .004) continue;
      const a = Ye(i), c = Es(i), u = Lh(t, s === 0 ? 0 : 2, e, n, G);
      o.push(Ht(`dots.${s}`, x + (r[s] - x) * c, x - u.lift, G.RT * a * u.pop * G.LT, a * u.tone));
    }
    return o;
  };
  const sE = (e, t) => { // orbit
    const n = Ye(e), r = 52 * Es(e), o = 12, s = t.stateTime * 1e3 * .0017;
    return Array.from({ length: 5 }, (i, a) => {
      const c = s + a * TAU / 5, u = Math.cos(c), l = .5 + .5 * le(u, 0, 1);
      return Ht(`orbit.${a}`, x + r * Math.sin(c), x - r * .42 * Math.cos(c), Math.max(o * l * n, .3), le((u + .4) / .6, .18, 1) * n);
    });
  };
  const iE = (e, t, n) => { // radar
    const r = Ye(e), o = 1300, s = 104;
    return Array.from({ length: 3 }, (i, a) => {
      const c = Bt(t.stateTime * 1e3 / o + a / 3);
      return { type: "ring", key: `radar.${a}`, cx: x, cy: x, r: n + (s - n) * c, width: 3.4 * (1 - c * .55), opacity: r * (1 - c) * .9 };
    });
  };
  const aE = (e, t) => { // progress
    const n = Ye(e), r = 62 * Es(e), o = le(t.shotTime * 1e3 / G.jT, 0, 1), s = le(o / .85, 0, 1),
      i = { type: "ring", key: "progress.track", cx: x, cy: x, r, width: 5, opacity: n * .16 };
    return s <= 0 ? [i] : [i, { type: "ring", key: "progress.arc", cx: x, cy: x, r, width: 5, opacity: n, arc: { fraction: s, startDeg: -90 } }];
  };
  const cE = (e, t) => { // gather
    const n = Ye(e), r = [];
    for (let o = 0; o < 5; o++) {
      const s = le((t.shotTime * 1e3 / G.qT - o * .09) / .62, 0, 1);
      if (s >= 1) continue;
      const i = 1 - Math.pow(1 - s, 3), a = o * 2.4 + s * 2.2, c = 96 * (1 - i);
      r.push(Ht(`gather.${o}`, x + c * Math.cos(a), x + c * Math.sin(a) * .8, 9 * (.5 + .5 * i) * n, n * le(s * 5, 0, 1) * (1 - i * .25)));
    }
    return r;
  };
  const uE = (e, t) => { // wave
    const n = t.stateTime * 1e3, r = 44, o = [];
    for (const s of G.BT) {
      const i = le((e - Math.abs(s) * .1) / (1 - Math.abs(s) * .1), 0, 1);
      if (i <= .004) continue;
      const a = Es(i), c = QT(n, s), u = (7 + 9 * le(c, .08, 1)) * Ye(i), l = 6 * le(c, 0, 1) * i;
      o.push(Ht(`wave.${s}`, x + s * r * a, x - l, u, i));
    }
    return o;
  };
  const lE = (e, t) => { // send
    const n = Ye(e), r = Bt(t.stateTime * 1e3 / G.Rh), o = le((r - .18) / .55, 0, 1), s = o * o * (.4 + .6 * o),
      i = .74, a = -.62, c = [];
    if (o > 0 && o < 1) { const f = 108 * s; c.push(Ht("send.packet", x + i * f, x + a * f, 10 * (1 - s * .55) * n, n * (1 - s * s))); }
    const u = le((r - .26) / .55, 0, 1), l = u * u * (.4 + .6 * u);
    if (o > 0 && u > 0 && u < 1) { const f = 108 * l; c.push(Ht("send.streak", x + i * f, x + a * f, 5 * (1 - l * .6) * n, n * .3 * (1 - l))); }
    const d = le((r - .18) / .3, 0, 1);
    return d > 0 && d < 1 && c.push({ type: "ring", key: "send.launch", cx: x, cy: x, r: 20 + 34 * Ye(d), width: 2.8 * (1 - d), opacity: n * (1 - d) * .8 }), c;
  };
  const dE = (e, t) => { // receive
    const n = Ye(e), r = t.stateTime * 1e3, o = JT(Math.floor(r / G.ga)), s = Bt(r / G.ga),
      i = le(s / .6, 0, 1), a = 1 - Math.pow(1 - i, 3), c = Math.cos(o), u = Math.sin(o), l = 108 * (1 - a), d = [];
    if (i < 1) {
      const h = 18 * Math.sin(i * Math.PI) * (1 - a * .7);
      d.push(Ht("receive.packet", x + c * l - u * h, x + u * l + c * h, 3.5 + 6.5 * a, n * le(i * 3.5, 0, 1) * (.3 + .7 * a)));
    }
    const f = le((s - .58) / .32, 0, 1);
    return f > 0 && f < 1 && d.push({ type: "ring", key: "receive.absorb", cx: x, cy: x, r: 20 + 26 * Ye(f), width: 2.8 * (1 - f), opacity: n * (1 - f) * .8 }), d;
  };
  const fE = (e, t) => { // dock
    const n = Ye(e), r = t.stateTime * 1e3, o = 42, s = 1.1, i = [];
    for (let a = 0; a < 2; a++) {
      const c = le((t.stateTime - (.2 + a * 1.3)) / .9, 0, 1);
      if (c <= 0) continue;
      const u = 1 - Math.pow(1 - c, 3), l = r * .001 * s + a * Math.PI, d = x + o * Math.sin(l),
        f = x + o * .5 * Math.cos(l) + Math.sin(r * .003 + a) * 2, h = x - 120 + a * 30, p = x + 95;
      i.push(Ht(`dock.${a}`, h + (d - h) * u, p + (f - p) * u, (7 + 3 * u) * n, n * le(c * 4, 0, 1)));
    }
    return i;
  };
  const hE = (e, t, n, tE) => { // pencil
    const r = t.stateTime * 1e3, o = pc(r, G), s2 = (o.rot - 90) * DEG, i = 68,
      a = Math.cos(s2) * i, c = Math.sin(s2) * i, u = x + (o.x + a) * e, l = x + (o.y + o.wig * .15 + c) * e,
      d = [Oh("pencil.shaft", G.UT, `translate(${u.toFixed(1)} ${l.toFixed(1)}) rotate(${(o.rot * e).toFixed(1)}) scale(${Ye(e).toFixed(3)}) translate(${-x} ${-x})`, le(e * 1.6 - .3, 0, 1))],
      f = nE(r, G, tE);
    return f.length >= 2 && d.push(XT("pencil.ink", rE(f), 6, le(e * 1.2, 0, 1))), d;
  };
  const pE = (e, t) => { // bang
    const n = t.stateTime, r = Ye(le(e * 1.1, 0, 1)), o = Math.exp(-(n % 2.2) * 5.5), s = Math.sin(n * 42) * 2.2 * o;
    return [Oh("bang.bar", G.KT, `translate(0 ${(-26 - (1 - r) * 70).toFixed(1)}) rotate(${s.toFixed(2)} ${x} ${(x - 74).toFixed(1)}) translate(${x} ${x}) scale(${le(e * 1.2, 0, 1).toFixed(3)}) translate(${-x} ${-x})`, le(e * 1.5 - .2, 0, 1))];
  };
  const mE = (e, t) => { // standby
    const n = .5 + .5 * Math.sin(t.stateTime * 1e3 * .0016);
    return [Ht("standby.halo", x, x, 26 + 7 * n, Ye(e) * (.06 + .1 * n))];
  };
  return (e, t, n, r, o, tE) => { // gE
    switch (e) {
      case "dots": return oE(t, n, o);
      case "orbit": return sE(t, n);
      case "radar": return iE(t, n, r);
      case "progress": return aE(t, n);
      case "gather": return cE(t, n);
      case "wave": return uE(t, n);
      case "send": return lE(t, n);
      case "receive": return dE(t, n);
      case "dock": return fE(t, n);
      case "ball": return [];
      case "pencil": return hE(t, n, o, tE);
      case "bang": return pE(t, n);
      case "standby": return mE(t, n);
    }
  };
}

// ============================================================
// yE：morph 合成器（amount/swap → core 变换 + parts + zoom）
// ============================================================
const YT = { lift: 0, pop: 1, tone: 1 }; // YT：无 dots 时的中性 lift/pop/tone
const Kx = (e, t, n) => e.map(([r, o], s) => [r + (t[s][0] - r) * n, o + (t[s][1] - o) * n]); // Kx：点列插值
// Mi：morph 身体环。pencil 的身体环 VT 依赖一套未移植的形状几何 DSL（nh/HT），
// 回退为 96 边形圆环 $h（其余 pencil 动画：轨迹/墨迹/旋转均完整）。
const Mi = (e, G) => G.$h;
function yE(e, t, G, gE, tE) { // yE（t=显示尺寸，仅用于小尺寸 zoom 阻尼）
  const { kind: n, isReducedMotion: r } = e, o = le(e.amount, 0, 1), s = le(e.swap, 0, 1),
    i = s < .999 ? e.outgoing : null,
    a = j => j === n ? o * s : j === i ? o * (1 - s) : 0,
    c = j => j === n ? e.clock : e.outgoingClock,
    u = le(o / G._T, 0, 1),
    d = n === "pencil" || i === "pencil" ? s >= .999 ? Mi(n, G) : Kx(Mi(i, G), Mi(n, G), Qo(s)) : G.$h,
    f = n ? G.Si[n] * s + (i ? G.Si[i] : G.Si[n]) * (1 - s) : 19,
    h = a("dots"), p = n === "dots" || i === "dots",
    g = p ? Lh(c("dots"), 1, o, r, G) : YT;
  let m = p ? 1 + (g.pop - 1) * (h / Math.max(o, .001)) : 1;
  const y = a("receive");
  if (y > .004) {
    const j = Bt(c("receive").stateTime * 1e3 / G.ga), J = le((j - .58) / .34, 0, 1);
    m *= 1 + .11 * Math.sin(J * Math.PI) * y;
  }
  const w = a("send");
  if (w > .004) {
    const j = Bt(c("send").stateTime * 1e3 / G.Rh), J = j < .18 ? -.06 * Math.sin(j / .18 * Math.PI) : 0,
      fe = j >= .18 && j < .42 ? .05 * Math.sin((j - .18) / .24 * Math.PI) : 0;
    m *= 1 + (J + fe) * w;
  }
  const S = a("bang");
  S > .004 && (m *= 1 + .04 * Math.exp(-(c("bang").stateTime % 2.2) * 5.5) * S);
  let b = 0, v = 0, T = 0;
  const A = a("pencil");
  if (A > .004) {
    const j = pc(c("pencil").stateTime * 1e3, G);
    b += j.x * A, v += (j.y + j.wig * .5) * A, T += j.rot * A;
  }
  S > .004 && (v += 58 * S);
  const F = a("ball");
  F > .004 && (v += eE(c("ball").stateTime) * F);
  const N = f / G.x * m, R = a("standby"),
    B = R > 0 ? (.28 + .2 * Math.sin(c("standby").stateTime * 1e3 * .0016)) * R : 0,
    E = {
      scale: 1 - o + N * o, dx: b * o, dy: -g.lift * h + v * o, rotation: T * o,
      opacity: (1 - (1 - g.tone) * h) * (1 - B), round: Qo(u), ring: d,
    },
    I = 1 - eb(le((t - 44) / 90, 0, 1)),
    _ = n == null ? 1 : G.gd[n], O = i ? G.gd[i] : _,
    H = 1 + (_ * s + O * (1 - s) - 1) * o * I, L = [];
  for (const j of [i, n]) {
    if (j == null) continue;
    const J = a(j);
    J > .004 && L.push(...gE(j, J, c(j), f, r, tE));
  }
  return { core: E, isFaceVisible: o < .5, zoom: H, parts: L.filter(j => j.opacity > 0) };
}

// ============================================================
// 身体轮廓 ⇄ morph 环混合（gM 射线求交 / kM 角度重采样 / Th 加权 / SM 圆度混合）
// ============================================================
const rd = 1e-9, dM = 1e-7, tn = 720; // rd/dM/tn
function hM(e) { return Array.from({ length: e }, (t, n) => n / e * TAU); } // hM
const kE = hM(192); // kE：基础角度采样
function yM(e, t, n) { // yM：椭圆参数采样（半径归一化）
  const [r, o] = t;
  return Array.from({ length: n }, (s, i) => {
    const a = i / n * TAU, c = Math.cos(a), u = Math.sin(a),
      l = r === 0 || o === 0 ? 0 : 1 / Math.hypot(c / r, u / o);
    return [e[0] + c * l, e[1] + u * l];
  });
}
function pM(e, t) { return e.flatMap(n => n.map(([r, o]) => us(t, r, o))); } // pM
function mM(e) { // mM：排序去重角度表
  const t = e.flat().sort((n, r) => n - r);
  return t.filter((n, r) => r === 0 || n - t[r - 1] > dM);
}
function us(e, t, n) { const r = Math.atan2(n - e[1], t - e[0]); return r < 0 ? r + TAU : r; } // us
function EM(e, t) { // EM：按角度分桶（tn=720 桶）收集轮廓边
  const n = Array.from({ length: tn }, () => []);
  for (const r of e) for (let o = 0; o < r.length; o++) {
    const s = r[o], i = r[(o + 1) % r.length], a = us(t, s[0], s[1]);
    let c = us(t, i[0], i[1]) - a;
    c > Math.PI && (c -= TAU), c < -Math.PI && (c += TAU);
    const u = Math.floor((c < 0 ? a + c : a) / TAU * tn) - 1,
      l = Math.floor((c < 0 ? a : a + c) / TAU * tn) + 1;
    for (let d = u; d <= l; d++) n[(d % tn + tn) % tn].push([s, i]);
  }
  return n;
}
function PM(e, [t, n], r) { // PM：射线 r 与桶内各边求最近交点距离
  const o = Math.cos(r), s = Math.sin(r);
  let i = Number.NaN;
  for (const [[a, c], [u, l]] of e[Math.floor(r / TAU * tn) % tn]) {
    const d = u - a, f = l - c, h = o * f - s * d;
    if (Math.abs(h) < 1e-12) continue;
    const p = a - t, g = c - n, m = (p * f - g * d) / h, y = (p * s - g * o) / h;
    m >= 0 && y >= -rd && y <= 1 + rd && !(m <= i) && (i = m);
  }
  return i;
}
function AM(e) { // AM：NaN 角度沿最近有效邻居线性插值
  const t = e.length, n = e.flatMap((r, o) => Number.isNaN(r) ? [] : [o]);
  return n.length === 0 ? e.map(() => 0) : e.map((r, o) => {
    if (!Number.isNaN(r)) return r;
    const s = n.find(c => c > o) ?? n[0] + t,
      i = [...n].reverse().find(c => c < o) ?? (n.at(-1) ?? 0) - t,
      a = (o - i) / (s - i);
    return e[(i + t) % t] * (1 - a) + e[s % t] * a;
  });
}
function gM(e, t, n) { // gM：轮廓点列 → 沿角度表 n 的射线距离轮廓
  const r = EM(e, t), o = AM(n.map(s => PM(r, t, s)));
  return n.map((s, i) => [t[0] + Math.cos(s) * o[i], t[1] + Math.sin(s) * o[i]]);
}
function IM(e, t) { // IM：按角度在 {angle,reach} 表上插值
  const n = e.length;
  if (n === 0) return 0;
  let r = e.findIndex(c => c.angle >= t);
  r < 0 && (r = 0);
  const o = e[r], s = e[(r - 1 + n) % n], i = (o.angle - s.angle + TAU) % TAU;
  if (i === 0) return o.reach;
  const a = (t - s.angle + TAU) % TAU / i;
  return s.reach + (o.reach - s.reach) * a;
}
function kM(e, t, n) { // kM：任意点环 → 沿角度表 n 的星形重采样
  const r = e.map(([o, s]) => ({ angle: us(t, o, s), reach: Math.hypot(o - t[0], s - t[1]) }))
    .sort((o, s) => o.angle - s.angle);
  return n.map(o => {
    const s = IM(r, o);
    return [t[0] + Math.cos(o) * s, t[1] + Math.sin(o) * s];
  });
}
function Th(e) { // Th：加权平均多个等长轮廓
  const t = e.reduce((r, o) => r + o.weight, 0), [n] = e;
  return n == null || t === 0 ? [] : n.outline.map((r, o) => {
    let s = 0, i = 0;
    for (const { outline: a, weight: c } of e) s += a[o][0] * c, i += a[o][1] * c;
    return [s / t, i / t];
  });
}
function SM(e, t, n) { return e.map(([r, o], s) => [r + (t[s][0] - r) * n, o + (t[s][1] - o) * n]); } // SM：向目标轮廓混合 round 比例
function ME(e, t, n, r, G) { // ME：morph ring（设计坐标）→ 画布坐标轮廓
  const o = n / G.x,
    s = e.core.ring.map(([i, a]) => [t[0] + (i - G.x) * o, t[1] + (a - G.x) * o]);
  return kM(s, t, r);
}
function TE(e, t, n, r, G) { // TE：morph core → head 组变换（$n/zoom 抵消外层缩放）
  const { core: o } = e, s = 1 - t, i = t > 0 ? (o.scale - s) / t : 0;
  return { translate: [o.dx * r, o.dy * r], rotation: o.rotation, scale: s + i * (G.$n / n) * t, opacity: o.opacity };
}
const da = e => e.length === 0 ? "" : `M${e.map(([t, n]) => `${od(t)} ${od(n)}`).join("L")}Z`; // da：点列 → SVG path

// ============================================================
// 渲染模型 builder（对应 Fh 分发：sphere → wT 弧线路径；morph → xE 点列路径）
// ============================================================
function bT(e, t, G) { // bT：sphere 帧 → {center, radius, body 点列, eyes 点列}
  const n = e.zoom * t / 2, [r, o] = e.squash,
    s = [t / 2 + n * e.offset[0], t / 2 - n * (e.squashAnchor * (1 - o) + e.offset[1])],
    i = Math.abs(n), a = ([c, u]) => [s[0] + c * n, s[1] - u * n];
  return {
    center: s, radius: i,
    body: [yM(s, [Math.abs(r) * i, Math.abs(o) * i], yT)],
    eyes: Ch(e, i, G).map(c => xT(c, kT).map(a)),
  };
}
// buildModel：frame → 渲染模型。非 sphere 身体回退为 sphere 几何（警告一次）；
// 多身体交叉淡化时各身体形状相同（均 sphere），眼睛取权重最大者（原版的 PE 环混合未移植）。
function buildModel(e, t, n, G, gE, tE, warnBody) {
  const r = t.inkPaint ?? Nr(t.ink), o = t.spotPaint ?? Nr(t.spot),
    s = e.morph == null && e.bodies.length === 1 && e.bodies[0].body === "sphere";
  if (s) {
    const i = wT(e, t, n, G);
    return {
      mode: "sphere", size: n, bodyD: i.body, eyesD: i.eyes, glow: i.glow,
      inkPaint: r, spotPaint: o, cutout: t.cutout,
    };
  }
  const i = e.bodies.map(({ body: c, weight: u }) => {
    c !== "sphere" && warnBody(c);
    return { shape: bT(e, n, G), weight: u };
  }).sort((c, u) => u.weight - c.weight);
  const a = i[0]?.shape.center ?? [n / 2, n / 2], u2 = i[0]?.shape.radius ?? 0,
    l = mM([kE, ...i.map(({ shape: c }) => pM(c.body, c.center))]),
    d = Th(i.map(({ shape: c, weight: u }) => ({ outline: gM(c.body, c.center, l), weight: u }))),
    f = e.morph == null ? null : yE(e.morph, n, G, gE, tE),
    h = G.$n * n / 2 / G.x;
  return {
    mode: "morph", size: n, center: a,
    bodyPts: f == null || f.core.round === 0 ? d : SM(d, ME(f, a, u2, l, G), f.core.round),
    eyesPts: i[0]?.shape.eyes ?? [],
    head: f == null || e.morph == null ? null : TE(f, e.morph.amount, e.zoom, h, G),
    parts: f?.parts ?? [], markScale: h, zoom: f?.zoom ?? 1,
    inkPaint: r, spotPaint: o, cutout: t.cutout,
  };
}

// ============================================================
// 程序化装饰图形（GT 圆头竖条 / WT 圆角感叹号）+ 设计画布常量
// ============================================================
const GT = (e, t, x) => { // GT(e=宽, t=高)：圆头竖条 path
  const n = e / 2, r = x - t / 2 + n, o = x + t / 2 - n;
  return `M${x - n} ${r}A${n} ${n} 0 0 1 ${x + n} ${r}L${x + n} ${o}A${n} ${n} 0 0 1 ${x - n} ${o}Z`;
};
const WT = (e, t, n, x) => { // WT(e=上宽, t=下宽, n=高)：感叹号条 path
  const r = e / 2, o = t / 2, s = x - n / 2, i = x + n / 2;
  return `M${x - r} ${s + r}A${r} ${r} 0 0 1 ${x + r} ${s + r}L${x + o} ${i - o}A${o} ${o} 0 0 1 ${x - o} ${i - o}Z`;
};

// ============================================================
// makeConfig：grok-recipes.json → 引擎常量配置 G
// ============================================================
function makeConfig(R) {
  const C = R.constants, M = C.morph, bn = R.expressions,
    bb = new Set(R.blinkBlockingExpressions),
    wb = new Map(Object.entries(R.expressionAliases)),
    gb = new Set(R.expressionNames),
    Kf = R.eyes.baseEulerDeg,
    shapeNames = R.shapes.names,
    lx = new Map(Object.entries(R.shapes.aliases)),
    Rx = new Map(R.clips.map(e => [e.name, e])),
    x = M.canvasCenter,
    $h = Array.from({ length: 96 }, (e, t) => { // $h：96 边形圆环（设计坐标，半径 x）
      const n = t / 96 * TAU;
      return [x + Math.cos(n) * x, x + Math.sin(n) * x];
    });
  return {
    expressions: bn, expressionNames: gb, expressionAliases: wb, blinkBlocking: bb,
    eyeBasis: R.eyes.basis, eyeMirror: R.eyes.mirror, baseEulerDeg: Kf,
    xr: R.eyes.defaultWidth, kb: R.eyes.pathSegments, yb: R.eyes.spineSamples,
    Eb: C.eyes.Eb, Pb: C.eyes.Pb, Ab: C.eyes.Ab, Ib: C.eyes.Ib,
    na: C.durations.blink, nb: C.durations.morph, ta: C.durations.lidMorph,
    rb: C.durations.blinkHold, ob: C.durations.blinkClose, si: C.durations.blinkOvershoot,
    nr: C.ease.nr, tbEase: C.ease.tb, dxEase: C.ease.dx, vxEase: C.ease.vx,
    $n: C.runtime.zoomDefault, Sx: C.runtime.lookDuration, Mx: C.runtime.maxAdvance,
    Tx: C.runtime.bodySpringFreq, Ex: C.runtime.bodyWeightEps, Px: C.runtime.morphHideEyes,
    Ax: C.runtime.gazeSnap, Yb: C.gaze.Yb, Zb: C.gaze.Zb, gazeShapeMul: C.gaze.Qb,
    stateMorphMap: M.stateMap, morphShotSet: new Set(["progress", "spawning"]),
    morphShotSeconds: { progress: 2.5, spawning: 2 }, // sx / ix
    trackAliases: new Map(Object.entries(R.aliases.tracks)),
    bodyAlias(e) { const t = lx.get(e) ?? e; return shapeNames.includes(t) ? t : "sphere"; }, // hx
    restClip: { // cl：rest 帧（仅 baseEulerDeg 旋转）
      duration: C.runtime.restClipDuration, body: null, squashAnchor: 0, restTime: 0,
      inspect: {}, position: [], rotation: [{ t: 0, v: Kf, ease: C.ease.nr }],
      squash: [], zoom: [], lids: [], expression: [],
    },
    clipByName(e) { // $x
      const t = Rx.get(e);
      if (t == null) throw new Error(`No motion recipe named ${e}`);
      return t;
    },
    Tb: e => !bb.has(e) && !bn[e].some(jt), // Tb：该表情是否允许被眨眼 lids 覆盖
    Lr: e => bb.has(e), // Lr
    Mb: e => { const t = e.trim().toLowerCase(), n = wb.get(t) ?? t; return gb.has(n) ? n : "neutral"; }, // Mb：表情名归一
    states: R.states,
    x, IT: M.markOffset, _T: M.weightsFull,
    FT: M.liftPeriodMs, NT: M.liftAmp, $T: M.zoomFloor, OT: M.zoomFloorAmt, LT: M.liftBoost,
    RT: M.discR, yd: M.dotsGap, jT: M.progressShotMs, qT: M.gatherShotMs, BT: M.waveOffsets,
    Rh: M.sendPeriodMs, ga: M.receivePeriodMs, ds: M.pencilPeriodMs, Mr: M.pencilDrawFrac,
    Co: M.pencilTrailMs, zT: M.trailMinStep, DT: M.trailSampleMsPerFrame,
    gd: M.kindZoom, Si: M.baseRadius,
    UT: GT(30, 88, x), KT: WT(30, 17, 96, x), $h,
  };
}

// ============================================================
// DOM 渲染器：固定骨架 + 属性级更新（无 innerHTML / 无节点重建）
// ============================================================
const SVG_NS = "http://www.w3.org/2000/svg";
function createRenderer(doc, uid, S, G) {
  const cache = new WeakMap;
  const setA = (n, k, v) => {
    let m = cache.get(n);
    m === void 0 && cache.set(n, m = {});
    if (m[k] === v) return;
    m[k] = v;
    v == null ? n.removeAttribute(k) : n.setAttribute(k, v);
  };
  const mk = (tag, attrs = {}, parent) => {
    const n = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return parent ? parent.appendChild(n) : n;
  };
  const svg = mk("svg", {
    id: uid, width: S, height: S, viewBox: `0 0 ${S} ${S}`,
    role: "img", "aria-hidden": "true",
    style: "display:block;overflow:visible",
  });
  const defs = mk("defs", {}, svg);
  // cutout 用 mask / 非 cutout 用 clipPath（morph 模式）
  const mask = mk("mask", { id: `${uid}-holes`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: S, height: S }, defs);
  mk("rect", { width: S, height: S, fill: "#ffffff" }, mask);
  const maskEyes = mk("path", { fill: "#000000" }, mask);
  const clip = mk("clipPath", { id: `${uid}-body` }, defs);
  const clipBody = mk("path", {}, clip);
  // glow 渐变（懒创建）
  let gBody = null, gBodyStops = null, gHalo = null, gHaloStops = null;
  const ensureBodyGrad = () => {
    if (gBody) return;
    gBody = mk("radialGradient", { id: `${uid}-gbody`, gradientUnits: "userSpaceOnUse", cx: 0, cy: 0, r: 1, fx: 0, fy: 0 }, defs);
    gBodyStops = Array.from({ length: ld + 1 }, () => mk("stop", {}, gBody));
  };
  const ensureHaloGrad = () => {
    if (gHalo) return;
    gHalo = mk("radialGradient", { id: `${uid}-ghalo`, gradientUnits: "userSpaceOnUse", cx: 0, cy: 0, r: 1, fx: 0, fy: 0 }, defs);
    gHaloStops = Array.from({ length: dd + 1 }, () => mk("stop", {}, gHalo));
  };
  const applyGrad = (grad, stops, spec) => {
    setA(grad, "gradientTransform", spec.transform);
    for (let i = 0; i < stops.length; i++) {
      const st = spec.stops[i];
      setA(stops[i], "offset", String(st.offset));
      setA(stops[i], "stop-color", st.color);
      setA(stops[i], "stop-opacity", String(st.opacity));
    }
  };
  const zoomG = mk("g", {}, svg);
  const partsG = mk("g", {}, zoomG);
  const headG = mk("g", {}, zoomG);
  const haloP = mk("path", { "fill-rule": "evenodd" }, headG);
  const bodyP = mk("path", { "fill-rule": "evenodd" }, headG);
  const eyesP = mk("path", {}, headG);
  // parts 节点池（按 key 复用）
  const pool = new Map;
  const renderParts = (parts, inkPaint) => {
    const seen = new Set;
    for (const p of parts) {
      seen.add(p.key);
      let rec = pool.get(p.key);
      const tag = p.type === "disc" || p.type === "ring" ? "circle" : "path";
      if (rec === void 0 || rec.type !== p.type) {
        rec?.node.remove();
        rec = { type: p.type, node: mk(tag) };
        pool.set(p.key, rec);
      }
      const n = partsG.appendChild(rec.node); // 维持数组顺序 = z-order
      if (p.type === "disc") {
        setA(n, "cx", Se(p.cx)); setA(n, "cy", Se(p.cy)); setA(n, "r", Se(p.r));
        setA(n, "fill", inkPaint);
        setA(n, "stroke", null); setA(n, "stroke-width", null);
        setA(n, "stroke-dasharray", null); setA(n, "transform", null); setA(n, "d", null);
      } else if (p.type === "ring") {
        setA(n, "cx", Se(p.cx)); setA(n, "cy", Se(p.cy)); setA(n, "r", Se(p.r));
        setA(n, "fill", "none"); setA(n, "stroke", inkPaint); setA(n, "stroke-width", Se(p.width));
        if (p.arc != null) {
          const C2 = 2 * Math.PI * p.r;
          setA(n, "stroke-dasharray", `${Se(C2 * p.arc.fraction)} ${Se(C2)}`);
          setA(n, "transform", `rotate(${Se(p.arc.startDeg)} ${Se(p.cx)} ${Se(p.cy)})`);
        } else setA(n, "stroke-dasharray", null), setA(n, "transform", null);
        setA(n, "d", null);
      } else if (p.type === "shape") {
        setA(n, "d", p.d); setA(n, "transform", p.transform ?? null); setA(n, "fill", inkPaint);
        setA(n, "stroke", null); setA(n, "stroke-width", null); setA(n, "stroke-dasharray", null);
        setA(n, "cx", null); setA(n, "cy", null); setA(n, "r", null);
      } else { // stroke
        setA(n, "d", p.d); setA(n, "fill", "none"); setA(n, "stroke", inkPaint);
        setA(n, "stroke-width", Se(p.width));
        setA(n, "stroke-linecap", "round"); setA(n, "stroke-linejoin", "round");
        setA(n, "transform", null); setA(n, "stroke-dasharray", null);
        setA(n, "cx", null); setA(n, "cy", null); setA(n, "r", null);
      }
      setA(n, "opacity", p.opacity < 1 ? Se(p.opacity, 3) : null);
    }
    for (const [k, rec] of pool) seen.has(k) || (rec.node.remove(), pool.delete(k));
  };
  const render = model => {
    if (model.mode === "sphere") {
      renderParts(EMPTY_PARTS, model.inkPaint);
      setA(partsG, "transform", null);
      setA(headG, "transform", null); setA(headG, "opacity", null);
      setA(zoomG, "transform", null);
      const glow = model.glow;
      if (glow?.halo != null) {
        ensureHaloGrad();
        applyGrad(gHalo, gHaloStops, glow.halo.gradient);
        setA(haloP, "d", glow.halo.d); setA(haloP, "fill", `url(#${uid}-ghalo)`);
      } else setA(haloP, "d", ""), setA(haloP, "fill", null);
      if (glow != null) {
        ensureBodyGrad();
        applyGrad(gBody, gBodyStops, glow.body);
        setA(bodyP, "fill", `url(#${uid}-gbody)`);
      } else setA(bodyP, "fill", model.inkPaint);
      setA(bodyP, "d", model.bodyD);
      setA(bodyP, "mask", null);
      setA(eyesP, "d", model.eyesD);
      setA(eyesP, "fill", model.eyesD === "" ? null : model.spotPaint);
      setA(eyesP, "clip-path", null);
      return;
    }
    // morph 模式（原版 xE 丢弃 glow）
    setA(haloP, "d", ""); setA(haloP, "fill", null);
    const bodyD = da(model.bodyPts), eyesD = model.eyesPts.map(da).join("");
    setA(bodyP, "d", bodyD); setA(bodyP, "fill", model.inkPaint);
    if (eyesD !== "" && model.cutout) {
      setA(maskEyes, "d", eyesD);
      setA(bodyP, "mask", `url(#${uid}-holes)`);
      setA(eyesP, "d", ""); setA(eyesP, "fill", null); setA(eyesP, "clip-path", null);
    } else if (eyesD !== "") {
      setA(bodyP, "mask", null);
      setA(clipBody, "d", bodyD);
      setA(eyesP, "d", eyesD); setA(eyesP, "fill", model.spotPaint);
      setA(eyesP, "clip-path", `url(#${uid}-body)`);
    } else {
      setA(bodyP, "mask", null);
      setA(eyesP, "d", ""); setA(eyesP, "fill", null); setA(eyesP, "clip-path", null);
    }
    const d = model.head;
    if (d == null) setA(headG, "transform", null), setA(headG, "opacity", null);
    else {
      const [cx, cy] = model.center;
      setA(headG, "transform",
        `translate(${Se(cx + d.translate[0])} ${Se(cy + d.translate[1])}) rotate(${Se(d.rotation)}) scale(${Se(d.scale, 5)}) translate(${Se(-cx)} ${Se(-cy)})`);
      setA(headG, "opacity", d.opacity < 1 ? Se(d.opacity, 3) : null);
    }
    if (model.parts.length === 0) renderParts(EMPTY_PARTS, model.inkPaint), setA(partsG, "transform", null);
    else {
      setA(partsG, "transform",
        `translate(${Se(model.size / 2)} ${Se(model.size / 2)}) scale(${Se(model.markScale, 5)}) translate(${-G.x} ${-G.x})`);
      renderParts(model.parts, model.inkPaint);
    }
    if (model.zoom === 1) setA(zoomG, "transform", null);
    else {
      const p = model.size / 2 + (G.IT - G.x) * model.markScale;
      setA(zoomG, "transform",
        `translate(${Se(p)} ${Se(p)}) scale(${Se(model.zoom, 5)}) translate(${Se(-p)} ${Se(-p)})`);
    }
  };
  return { svg, render };
}
const EMPTY_PARTS = [];

// ============================================================
// createGrokBot：宿主装配（rAF 循环 / 休眠唤醒 / 指针跟随 / 静态模式）
// ============================================================
const Ti = 48, OE = 60, LE = .1; // Ti：compact 阈值；OE/LE：静态 settle 步数/步长
function NE(e) { // NE：FNV-1a 字符串 hash
  let t = 2166136261;
  for (let n = 0; n < e.length; n++) t = Math.imul(t ^ e.charCodeAt(n), 16777619);
  return t >>> 0;
}
const FE = () => typeof window > "u" || typeof window.matchMedia != "function"
  ? !1 : window.matchMedia("(prefers-reduced-motion: reduce)").matches; // FE

let gpCounter = 0;
export function createGrokBot(container, opts = {}) {
  const doc = container.ownerDocument, win = doc.defaultView,
    uid = `gp${++gpCounter}`,
    size = opts.size ?? 320,
    theme = { ink: [0, 0, 0], spot: [0, 0, 0], cutout: !0, ...opts.theme },
    seedNum = typeof opts.seed == "string" ? NE(opts.seed) : opts.seed ?? 1,
    isStatic = (opts.staticMode ?? !1) || (opts.reducedMotion ?? FE()),
    maxFps = Math.max(1, opts.maxFps ?? 60),
    frozenAt = opts.frozenAt;

  let G = null, rt = null, nx = null, renderer = null, gE = null, trail = null,
    ready = !1, destroyed = !1, loadError = null;
  const pending = [];

  // ---------- rAF 循环 ----------
  let rafId = 0, lastT = 0, lastTick = 0, phase = 0, running = !1, inView = !0, io = null;
  const frameDur = 1e3 / maxFps;
  const tick = now => {
    rafId = 0;
    if (doc.hidden || !inView) { stopLoop(); return; }
    phase += Math.max(0, now - lastTick);
    lastTick = now;
    if (phase + .5 < frameDur) { rafId = win.requestAnimationFrame(tick); return; }
    phase %= frameDur;
    const dt = (now - lastT) / 1e3;
    lastT = now;
    const start = opts.onFrame ? win.performance.now() : 0;
    nx.advance(dt), rt.advance(dt);
    const advanceMs = opts.onFrame ? win.performance.now() - start : 0;
    renderFrame(dt * 1e3, advanceMs);
    if (!rt.isPlaying && rt.isSettled) { running = !1; return; }
    rafId = win.requestAnimationFrame(tick);
  };
  const wake = () => {
    if (running || doc.hidden || !inView || destroyed || !ready || isStatic || frozenAt != null) return;
    running = !0, lastTick = lastT = win.performance.now(), phase = frameDur;
    rafId = win.requestAnimationFrame(tick);
  };
  const stopLoop = () => {
    running = !1;
    rafId && (win.cancelAnimationFrame(rafId), rafId = 0);
  };
  const onVisibilityChange = () => doc.hidden ? stopLoop() : wake();
  const renderFrame = (intervalMs, advanceMs = 0) => {
    const begin = opts.onFrame ? win.performance.now() : 0;
    const model = buildModel(rt.frame(), theme, size, G, gE, trail, warnBody);
    const engineMs = opts.onFrame ? win.performance.now() - begin + advanceMs : 0;
    renderer.render(model);
    if (opts.onFrame) opts.onFrame({ intervalMs, engineMs, domMs: win.performance.now() - begin - (engineMs - advanceMs) });
  };
  const warnedBodies = new Set;
  const warnBody = b => {
    warnedBodies.has(b) || (warnedBodies.add(b),
      console.warn(`[grok-player] 非 sphere 身体 "${b}" 未移植，回退为 sphere 渲染`));
  };

  // ---------- 指针跟随 ----------
  let followOn = !1;
  const onPointerMove = e => {
    const rect = renderer.svg.getBoundingClientRect();
    rt.setGaze(ex(rect, { x: e.clientX, y: e.clientY }));
    wake();
  };
  const setFollow = v => {
    if (v === followOn) return;
    followOn = v;
    rt?.setGazeAlways(v);
    v ? win.addEventListener("pointermove", onPointerMove, { passive: !0 })
      : (win.removeEventListener("pointermove", onPointerMove), rt?.setGaze(null));
  };

  // ---------- 初始化 ----------
  const dataPromise = opts.data != null
    ? Promise.resolve(opts.data)
    : fetch(opts.recipesUrl ?? new URL("./grok-recipes.json", import.meta.url))
        .then(r => { if (!r.ok) throw new Error(`grok-recipes.json HTTP ${r.status}`); return r.json(); });
  const readyPromise = dataPromise.then(recipes => {
    if (destroyed) return;
    G = makeConfig(recipes);
    gE = makeMorphGenerators(G);
    trail = makeTrail(G);
    rt = createRuntime(G, { zoomMul: opts.zoomMul ?? 1, isGazeAlways: opts.follow ?? opts.gazeAlways ?? !1 });
    nx = createStateMachine(G, rt, opts.state ?? "idle", {
      seed: seedNum,
      isCompact: opts.compact ?? size < Ti,
      isResting: isStatic,
      firstPhase: opts.firstPhase,
    });
    opts.glow && rt.setGlow(opts.glow);
    renderer = createRenderer(doc, uid, size, G);
    container.appendChild(renderer.svg);
    ready = !0;
    if (frozenAt != null) { // 确定性采样：1/60 步进到指定时刻渲染单帧，不起 rAF
      const dt = 1 / 60;
      for (let t = 0; t < frozenAt - 1e-9; t += dt) nx.advance(dt), rt.advance(dt);
      renderFrame();
    } else if (isStatic) { // 静态（含 prefers-reduced-motion）：pause + seek(0) + 60×0.1 settle 一帧
      rt.pause(), rt.seek(0);
      for (let i = 0; i < OE; i++) rt.advance(LE);
      renderFrame();
    } else {
      renderFrame();
      if (typeof IntersectionObserver < "u") {
        io = new IntersectionObserver(entries => {
          inView = entries.at(-1)?.isIntersecting ?? !0;
          inView ? wake() : stopLoop();
        });
        io.observe(renderer.svg);
      }
      doc.addEventListener("visibilitychange", onVisibilityChange);
      wake();
    }
    // 修复：opts.follow 此前只透传了 isGazeAlways，从未挂 pointermove 监听
    if (opts.follow && !isStatic && frozenAt == null) setFollow(true);
    for (const f of pending) f();
    pending.length = 0;
  }).catch(err => { loadError = err; console.error("[grok-player] 数据加载失败:", err); });

  // whenReady：未 ready 时排队，ready 后直调；必须透传参数（修复 setState('thinking') 变 setState(undefined) 被静默丢弃）
  const whenReady = f => (...args) => { if (!destroyed) (ready ? f(...args) : pending.push(() => f(...args))); };
  const staticRefresh = () => { // 静态模式下 API 变更后重新 settle 一帧
    if (!ready) return;
    for (let i = 0; i < OE; i++) nx.advance(LE), rt.advance(LE);
    renderFrame();
  };
  const after = () => { isStatic || frozenAt != null ? staticRefresh() : wake(); };

  return {
    ready: readyPromise,
    get error() { return loadError; },
    get state() { return nx?.state ?? opts.state ?? "idle"; },
    get clip() { return nx?.clip ?? null; },
    get el() { return renderer?.svg ?? null; },
    setState: whenReady(v => { nx.setState(v); after(); }),
    setExpression: whenReady((name, o = {}) => { rt.setExpression(name, { isThroughBlink: o.throughBlink ?? !1 }); after(); }),
    blink: whenReady(() => { rt.blink(); after(); }),
    look: whenReady(dir => { rt.look(dir); after(); }),
    poke: whenReady((kind, turns = 1) => { isStatic || (rt.poke(kind, { turns }), after()); }),
    setGaze: whenReady(v => { isStatic || (rt.setGaze(v), after()); }),
    setFollow: whenReady(v => { setFollow(v); after(); }),
    setCompact: whenReady(v => { nx.setCompact(v); after(); }),
    setResting: whenReady(v => { nx.setResting(v); after(); }),
    setEmphasis: whenReady(v => { nx.setEmphasis(v); after(); }),
    setGlow: whenReady(g => { rt.setGlow(g); after(); }),
    // 教学用调试快照：当前状态 / clip / 播放头 / morph 弹簧实测值（解析页曲线可视化用）
    debugFrame() {
      if (!ready || !rt || !nx) return null;
      return { state: nx.state, clip: nx.clip, time: rt.time, duration: rt.duration, morph: rt.frame().morph };
    },
    // 逐帧步进（仅 frozenAt 确定性模式）：推进 n 帧（1/60s）并重渲染一帧
    step(n = 1) {
      if (!ready || destroyed || frozenAt == null) return;
      const dt = 1 / 60;
      for (let i = 0; i < n; i++) nx.advance(dt), rt.advance(dt);
      renderFrame();
    },
    destroy() {
      if (destroyed) return;
      destroyed = !0;
      stopLoop();
      io?.disconnect();
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      followOn && win.removeEventListener("pointermove", onPointerMove);
      pending.length = 0;
      renderer?.svg.remove();
    },
  };
}
export { makeConfig, createRuntime, createStateMachine, buildModel, makeMorphGenerators, makeTrail, createRenderer };
// 教学演示复用：原版球面眼睛数学（lb 欧拉→四元数 / ir 四元数→3×3 / Et 矩阵乘向量 /
// ST 眼睛描述符→球面裁剪环 / xT 弧线细分点列，kT 为其步长）
export { lb, ir, Et, ST, xT, kT };
