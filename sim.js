'use strict';
// 高层建筑主动减振控制 —— 确定性推演内核（无 DOM 依赖，可在 Node 中测试）

// ---------------- 常量 ----------------
const N = 12;                 // 楼层数
const DT = 0.01;              // 积分步长 (s)
const STORY_H = 3.2;          // 层高 (m)
const MASS = 1.0;
const K = 2600.0;             // 层间刚度（一阶自振周期约 0.98s）
const FMAX = 5.0;            // 单台 AMD 最大出力（约 0.5g 等效楼层加速度）
const DEVICE_STORIES = [1, 3, 5, 7, 9, 11]; // 0 基索引，对应实际 2/4/6/8/10/12 层

const BATTERY_CAPACITY = 150.0;  // 电池能量（自动模式可支撑约 60s 停电）
const IDLE_POWER = 0.25;
const POWER_K = 0.11;           // 出力 -> 电功率

const DEFAULT_CONFIG = () => ({
  seed: 20260922,
  horizon: 60,
  objective: 'top',
  powerMode: 'grid',
  events: [
    { kind: 'quake', type: 'main', t: 6.0 },
    { kind: 'fault', device: 2, t: 14.0 },
    { kind: 'quake', type: 'after', t: 22.0 },
  ],
  isolated: [false, false, false, false, false, false],
});

const OBJECTIVES = {
  top:     { q: 3000, qa: 0,   drift: 0,   r: 0.02, label: '顶层位移最小' },
  accel:   { q: 20,   qa: 120, drift: 0,   r: 0.05, label: '舒适度（加速度）' },
  drift:   { q: 80,   qa: 30,  drift: 250, r: 0.05, label: '全楼层间位移角' },
  economy: { q: 60,   qa: 10,  drift: 40,  r: 2.0,  label: '节能（少出力）' },
};

// ---------------- 矩阵工具 ----------------
function zeros(n, m) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = new Float64Array(m || n); return a; }
function eye(n) { const a = zeros(n); for (let i = 0; i < n; i++) a[i][i] = 1; return a; }

function invert(A) {
  const n = A.length;
  const M = zeros(n, 2 * n);
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i][j] = A[i][j]; M[i][n + i] = 1; }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) throw new Error('singular');
    const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp;
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  const R = zeros(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) R[i][j] = M[i][n + j];
  return R;
}

function matMul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) {
    const a = A[i][p];
    if (a === 0) continue;
    const Brow = B[p];
    for (let j = 0; j < m; j++) C[i][j] += a * Brow[j];
  }
  return C;
}
function matTVec(A, v) { const n = A.length, m = A[0].length, r = new Float64Array(m); for (let i = 0; i < n; i++) { const vi = v[i]; const row = A[i]; for (let j = 0; j < m; j++) r[j] += vi * row[j]; } return r; }
function matVec(A, v) { const n = A.length, r = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; const row = A[i]; for (let j = 0; j < v.length; j++) s += row[j] * v[j]; r[i] = s; } return r; }
function addT(A, B, s) { const n = A.length, m = A[0].length; for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) A[i][j] += s * B[i][j]; }

// ---------------- 确定性随机数 ----------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------- 合成地震动（Clough-Penzien 滤波 + 包络） ----------------
function genQuake(steps, dt, spec, rng) {
  const wg = 2 * Math.PI * spec.fg, zg = spec.zg;
  const wf = 2 * Math.PI * spec.ff, zf = spec.zf;
  const y1 = new Float64Array(steps);
  let x1 = 0, x2 = 0, y2 = 0, z = 0;
  let peak = 0;
  const raw = new Float64Array(steps);
  const s2 = Math.sqrt(dt);
  for (let i = 0; i < steps; i++) {
    const w = gaussian(rng) * s2;
    x2 += (-wg * wg * x1 - 2 * zg * wg * x2) * dt + wg * wg * w;
    x1 += x2 * dt;
    z += (-wf * wf * y2 - 2 * zf * wf * z + 2 * zf * wf * x2 + wf * wf * x1) * dt;
    y2 += z * dt;
    y1[i] = x2 - y2;
    const ap = Math.abs(y1[i]);
    if (ap > peak) peak = ap;
  }
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    let env;
    if (t < spec.tr) env = (t / spec.tr) * (t / spec.tr);
    else if (t < spec.tr + spec.ts) env = 1;
    else { const x = (t - spec.tr - spec.ts) / spec.td; env = Math.exp(-2.3 * x); }
    raw[i] = y1[i] / peak * spec.pga * Math.max(env, 0);
  }
  return raw;
}

const QUAKE_SPEC = {
  main:  { fg: 1.05, zg: 0.5, ff: 0.25, zf: 0.7, pga: 0.55, tr: 3.0, ts: 8.0, td: 6.0 },
  after: { fg: 2.1, zg: 0.5, ff: 0.4, zf: 0.7, pga: 0.30, tr: 1.5, ts: 4.0, td: 4.0 },
};

function buildGround(config) {
  const steps = Math.round(config.horizon / DT) + 1;
  const g = new Float64Array(steps);
  config.events.filter(e => e.kind === 'quake').forEach((e, idx) => {
    const rng = mulberry32((config.seed ^ hashStr(`${e.type}:${idx}:${e.t.toFixed(3)}`)) >>> 0);
    const spec = QUAKE_SPEC[e.type] || QUAKE_SPEC.after;
    const trace = genQuake(steps, DT, spec, rng);
    const off = Math.round(e.t / DT);
    for (let i = 0; i < steps && off + i < steps; i++) g[off + i] += trace[i];
  });
  return g;
}

// ---------------- 结构模型 ----------------
function buildStructure() {
  const Kst = zeros(N);
  for (let i = 0; i < N; i++) {
    Kst[i][i] = K + (i + 1 < N ? K : 0);
    if (i + 1 < N) { Kst[i][i + 1] = -K; Kst[i + 1][i] = -K; }
  }
  // Rayleigh 阻尼：1、3 阶振型阻尼比 3%
  const w = 2 * Math.sqrt(K / MASS) * Math.sin(Math.PI / (2 * (2 * N + 1)));
  const w3 = 2 * Math.sqrt(K / MASS) * Math.sin(3 * Math.PI / (2 * (2 * N + 1)));
  const zeta = 0.03;
  const a1 = 2 * zeta / (w + w3);
  const a0 = w * w3 * a1;
  const Cst = zeros(N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) Cst[i][j] = a1 * Kst[i][j];
  for (let i = 0; i < N; i++) Cst[i][i] += a0 * MASS;
  return { Kst, Cst, w1: w };
}

// 模态 LQR：对前 NM 个振型解耦，用可用装置做 6 输入 DARE，返回模态增益与装置映射
const NM = 6;
function modeShapes(S) {
  const phi = [];
  for (let m = 1; m <= NM; m++) {
    const p = new Float64Array(N);
    for (let i = 0; i < N; i++) p[i] = Math.sin(m * Math.PI * (i + 0.5) / (2 * N + 1));
    let nrm = 0; for (const v of p) nrm += v * v;
    for (let i = 0; i < N; i++) p[i] /= Math.sqrt(nrm);
    phi.push(p);
  }
  return phi;
}
function modalFreqs(S) {
  const w = [];
  for (let m = 1; m <= NM; m++) w.push(2 * Math.sqrt(K / MASS) * Math.sin(m * Math.PI / (2 * (2 * N + 1))));
  return w;
}

function makeController(activeMask, params, S) {
  const devIdx = [];
  activeMask.forEach((a, d) => { if (a) devIdx.push(d); });
  const nu = devIdx.length;
  if (!S._phi) { S._phi = modeShapes(S); S._wf = modalFreqs(S); }
  const phi = S._phi, wf = S._wf;

  // 模态目标权重
  const qm = new Float64Array(NM), rm = new Float64Array(NM);
  for (let m = 0; m < NM; m++) {
    const hi = m >= 4 ? 0.35 : 1.0;           // 高模态基础权重
    qm[m] = (params.q * (m === 0 ? 1.6 : 1.0) + params.drift) * hi;
    if (m === 0) qm[m] += params.qa * 0.15;   // 顶摆与一阶相关
    if (m <= 2) qm[m] += params.qa * (1.0 - 0.25 * m); // 加速度主要由低阶模态贡献
    rm[m] = params.r;
  }

  // 模态状态空间（逐模态）：dq=v, dv=-w^2 q -2z w v + (phi^T E) f
  const Bmap = zeros(NM, nu);                  // phi^T E
  devIdx.forEach((d, k) => {
    const s = DEVICE_STORIES[d];
    for (let m = 0; m < NM; m++) Bmap[m][k] = phi[m][s] - (s > 0 ? phi[m][s - 1] : 0);
  });
  const order = 2 * NM;
  const Am = eye(order);
  const Bm = zeros(order, nu);
  const zeta0 = 0.03;
  for (let m = 0; m < NM; m++) {
    const w = wf[m];
    Am[m][m] = 1 - 0.5 * DT * DT * w * w;
    Am[m][NM + m] = DT - DT * DT * zeta0 * w;
    Am[NM + m][m] = -DT * w * w;
    Am[NM + m][NM + m] = 1 - 2 * DT * zeta0 * w;
    for (let k = 0; k < nu; k++) { Bm[m][k] = 0.5 * DT * DT * Bmap[m][k]; Bm[NM + m][k] = DT * Bmap[m][k]; }
  }
  const Q = zeros(order);
  for (let m = 0; m < NM; m++) Q[m][m] = qm[m];
  const R = zeros(nu);
  for (let k = 0; k < nu; k++) R[k][k] = rm[k < NM ? k : 0];

  // DARE 值迭代
  const At = zeros(order, order); for (let i = 0; i < order; i++) for (let j = 0; j < order; j++) At[j][i] = Am[i][j];
  const Bt = zeros(nu, order); for (let i = 0; i < order; i++) for (let k = 0; k < nu; k++) Bt[k][i] = Bm[i][k];
  let P = Q.map(r => Float64Array.from(r));
  for (let it = 0; it < 4000; it++) {
    const AtPA = matMul(matMul(At, P), Am);
    const AtPB = matMul(matMul(At, P), Bm);
    const BtPA = matMul(matMul(Bt, P), Am);
    const Mm = matMul(matMul(Bt, P), Bm);
    for (let i = 0; i < nu; i++) Mm[i][i] += R[i][i];
    const Sx = matMul(matMul(AtPB, invert(Mm)), BtPA);
    const Pn = zeros(order);
    for (let i = 0; i < order; i++) for (let j = 0; j < order; j++) Pn[i][j] = Q[i][j] + AtPA[i][j] - Sx[i][j];
    let diff = 0, norm = 0;
    for (let i = 0; i < order; i++) for (let j = 0; j < order; j++) { const d = Pn[i][j] - P[i][j]; diff += d * d; norm += Pn[i][j] * Pn[i][j]; }
    P = Pn;
    if (diff < 1e-14 * (norm + 1)) break;
  }
  const Rb = matMul(matMul(Bt, P), Bm);
  for (let i = 0; i < nu; i++) Rb[i][i] += R[i][i];
  const Km = matMul(invert(Rb), matMul(matMul(Bt, P), Am)); // nu x 2NM：模态状态 -> 装置指令

  return { Km, devIdx, nu, phi, NM };
}

// ---------------- 推演引擎 ----------------
class Engine {
  constructor(config) {
    this.cfg = clone(config);
    this.S = buildStructure();
    this.ground = buildGround(this.cfg);
    this.stepsTotal = this.ground.length;
    this.reset();
  }
  reset() {
    this.k = 0;
    this.t = 0;
    this.x = new Float64Array(N);
    this.v = new Float64Array(N);
    this.faulted = DEVICE_STORIES.map(() => false);
    this.battery = BATTERY_CAPACITY;
    this.gridUp = true;
    this.ctrlKey = null;
    this.ctrl = null;
    this.forces = new Float64Array(DEVICE_STORIES.length);
    this.powerMargin = 1;
    this.drawn = 0;
    this.failures = [];
    this.events = this.cfg.events.map(e => ({ ...e, fired: false }));
    this.pausedReasons = [];
    this.dead = false;
    this.peak = { top: 0, accel: 0, drift: 0, shear: 0 };
    this.driftEnv = new Float64Array(N);
    this.accelEnv = new Float64Array(N);
    this.last = this._sample(0, new Float64Array(N), this.battery / BATTERY_CAPACITY);
  }
  snapshot() {
    return {
      k: this.k, x: Array.from(this.x), v: Array.from(this.v),
      faulted: this.faulted.slice(), battery: this.battery, gridUp: this.gridUp,
      ctrlKey: this.ctrlKey, powerMargin: this.powerMargin,
      dead: this.dead, failures: JSON.parse(JSON.stringify(this.failures)),
      peak: { ...this.peak },
      driftEnv: Array.from(this.driftEnv), accelEnv: Array.from(this.accelEnv),
      events: JSON.parse(JSON.stringify(this.events)),
      cfg: JSON.parse(JSON.stringify(this.cfg)),
    };
  }
  restore(snap) {
    this.k = snap.k; this.t = this.k * DT;
    this.x = Float64Array.from(snap.x); this.v = Float64Array.from(snap.v);
    this.faulted = snap.faulted.slice(); this.battery = snap.battery;
    this.gridUp = snap.gridUp; this.ctrlKey = null; this.ctrl = null;
    this.powerMargin = snap.powerMargin; this.dead = snap.dead;
    this.failures = JSON.parse(JSON.stringify(snap.failures));
    this.peak = { ...snap.peak };
    this.driftEnv = Float64Array.from(snap.driftEnv);
    this.accelEnv = Float64Array.from(snap.accelEnv);
    this.events = JSON.parse(JSON.stringify(snap.events));
    this.cfg = JSON.parse(JSON.stringify(snap.cfg));
    this.ground = buildGround(this.cfg);
    this.stepsTotal = this.ground.length;
    this.forces = new Float64Array(DEVICE_STORIES.length);
    this.pausedReasons = [];
    this.last = this._sample(this.ground[this.k], new Float64Array(N), this.battery / BATTERY_CAPACITY);
  }
  activeMask() {
    return DEVICE_STORIES.map((_, d) => !this.faulted[d] && !this.cfg.isolated[d]);
  }
  _ensureController() {
    const key = this.cfg.objective + '|' + this.activeMask().map(a => a ? '1' : '0').join('');
    if (key === this.ctrlKey) return;
    this.ctrlKey = key;
    const mask = this.activeMask();
    this.ctrl = mask.some(a => a) ? makeController(mask, OBJECTIVES[this.cfg.objective], this.S) : null;
  }

  // 在时刻 t 的余震预测（确定性）
  forecast() {
    const rng = mulberry32((this.cfg.seed ^ hashStr('forecast:' + Math.round(this.t * 10))) >>> 0);
    const upcoming = this.events
      .filter(e => e.kind === 'quake' && !e.fired && e.t >= this.t - 1e-9)
      .sort((a, b) => a.t - b.t)
      .slice(0, 3)
      .map(e => {
        const pga = e.type === 'main' ? 0.34 : 0.18;
        return { dt: e.t - this.t, pga, band: pga * (0.75 + 0.5 * rng()), type: e.type };
      });
    // Omori 型背景概率：30s 窗内超过阈值的概率
    const dtSince = this._lastMainAge();
    const bg = Math.min(0.55, 0.9 / (1 + Math.pow(Math.max(dtSince, 0.05) / 12, 1.1)));
    return { upcoming, bg30: bg };
  }
  _lastMainAge() {
    let age = 1e9;
    for (const e of this.events) {
      if (e.kind !== 'quake' || e.type !== 'main') continue;
      age = Math.min(age, this.t - e.t); // 未发生时为负
    }
    if (age < -0.5) return 1e9;          // 主震尚未临近：背景风险近似 0
    return Math.max(age, 0.05);
  }

  _fireEvents() {
    for (const e of this.events) {
      if (e.fired || e.t > this.t + 1e-9) continue;
      e.fired = true;
      if (e.kind === 'fault') {
        this.faulted[e.device] = true;
        this.ctrlKey = null;
        this.pausedReasons.push(`D${e.device + 1} 号阻尼器故障`);
      }
      if (e.kind === 'grid') {
        this.gridUp = !e.off;
        this.pausedReasons.push(e.off ? '市电中断' : '市电恢复');
      }
    }
  }

  step() {
    if (this.dead || this.k >= this.stepsTotal - 1) return this.last;
    this._fireEvents();
    this._ensureController();
    const ag = this.ground[this.k];
    const fCap = this.cfg.fmax || FMAX;

    // 控制力
    this.forces.fill(0);
    let ctrlPwr = 0;
    if (this.ctrl) {
      const c = this.ctrl;
      const state = new Float64Array(2 * NM);
      for (let m = 0; m < NM; m++) {
        let qx = 0, qv = 0;
        const p = c.phi[m];
        for (let i = 0; i < N; i++) { qx += p[i] * this.x[i]; qv += p[i] * this.v[i]; }
        state[m] = qx; state[NM + m] = qv;
      }
      const u = matVec(c.Km, state);
      let satCount = 0;
      c.devIdx.forEach((d, k) => {
        let f = -u[k];
        if (f > fCap) { f = fCap; satCount++; }
        if (f < -fCap) { f = -fCap; satCount++; }
        this.forces[d] = f;
        ctrlPwr += IDLE_POWER + POWER_K * Math.abs(f);
      });
      if (satCount === c.nu && this.t > 1) this._satRun = (this._satRun || 0) + 1; else this._satRun = 0;
    }
    const activeN = this.activeMask().filter(Boolean).length;
    const demand = activeN * IDLE_POWER + ctrlPwr;

    // 供电
    let supply = 0;
    const useGrid = this.gridUp && this.cfg.powerMode !== 'battery';
    const useBatt = this.cfg.powerMode === 'battery' || (this.cfg.powerMode === 'auto' && !this.gridUp);
    if (useGrid) {
      supply = demand + 2;
    }
    if (useBatt) {
      supply = Math.min(demand, this.battery * 8);
      this.battery = Math.max(0, this.battery - demand * DT);
    } else if (useGrid) {
      this.battery = Math.min(BATTERY_CAPACITY, this.battery + 3.0 * DT);
    }
    const margin = demand > 0.01 ? Math.max(0, Math.min(1, supply / demand)) : 1;
    this.powerMargin = margin;
    const powered = margin > 0.35;
    if (!powered) { this.forces.fill(0); this.drawn++; }
    if (this.cfg.powerMode === 'grid' && !this.gridUp) {
      this._fail('市电中断且未切换备用供电，全部阻尼装置失电');
    }
    if (this.cfg.powerMode !== 'grid' && !this.gridUp && this.battery <= 0.01) {
      this._fail('备用电力耗尽，控制失效');
    }

    // 层间控制力向量
    const fc = new Float64Array(N);
    if (powered) DEVICE_STORIES.forEach((s, d) => {
      fc[s] += this.forces[d];
      if (s - 1 >= 0) fc[s - 1] -= this.forces[d];
    });

    // 相对地面运动方程：M a = -Kx - Cv - M*ag + fc
    const a = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let s = -ag;
      for (let j = 0; j < N; j++) s -= (this.S.Kst[i][j] * this.x[j] + this.S.Cst[i][j] * this.v[j]) / MASS;
      a[i] = s + fc[i] / MASS;
    }
    for (let i = 0; i < N; i++) {
      this.v[i] += a[i] * DT;
      this.x[i] += this.v[i] * DT;
    }

    this.k++;
    this.t = this.k * DT;
    this._fireEvents();

    // 响应包络 / 失效判据
    const drifts = new Float64Array(N);
    const accels = new Float64Array(N);
    const shears = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const lo = i === 0 ? 0 : this.x[i - 1];
      drifts[i] = this.x[i] - lo;
      accels[i] = a[i] + ag;
      const ad = Math.abs(drifts[i]);
      if (ad > this.driftEnv[i]) this.driftEnv[i] = ad;
      const aa = Math.abs(accels[i]);
      if (aa > this.accelEnv[i]) this.accelEnv[i] = aa;
    }
    for (let i = 0; i < N; i++) {
      let sh = 0;
      for (let j = i; j < N; j++) sh += this.S.Kst[j][j] * drifts[j] + (j + 1 < N ? -this.S.Kst[j][j + 1] * drifts[j + 1] : 0);
      shears[i] = sh;
    }
    this.peak.top = Math.max(this.peak.top, Math.abs(this.x[N - 1]));
    this.peak.accel = Math.max(this.peak.accel, Math.abs(accels[N - 1]));
    this.peak.drift = Math.max(this.peak.drift, ...Array.from(drifts).map(Math.abs));
    this.peak.shear = Math.max(this.peak.shear, ...Array.from(shears).map(Math.abs));

    if (this.peak.drift / STORY_H > 0.015) this._fail('层间位移角超过 1/67，结构进入严重损伤');
    this.last = this._sample(ag, drifts, this.battery / BATTERY_CAPACITY, accels, shears);
    return this.last;
  }

  _fail(msg) {
    if (this.dead) return;
    this.dead = true;
    this.failures.push({ t: this.t, msg });
    this.pausedReasons.push('推演终止：' + msg);
  }

  _sample(ag, drifts, battFrac, accels, shears) {
    accels = accels || new Float64Array(N);
    shears = shears || new Float64Array(N);
    return {
      k: this.k, t: this.t, ag,
      x: Float64Array.from(this.x), v: Float64Array.from(this.v),
      drifts: Float64Array.from(drifts),
      accels: Float64Array.from(accels),
      shears: Float64Array.from(shears),
      forces: Float64Array.from(this.forces),
      margin: this.powerMargin, batt: battFrac, gridUp: this.gridUp,
      faulted: this.faulted.slice(), isolated: this.cfg.isolated.slice(),
    };
  }
}

// ---------------- 全程模拟 / 基线 ----------------
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function runFull(config, onSample) {
  const eng = new Engine(config);
  const out = [];
  const stride = 5; // 100Hz -> 20Hz 采样供曲线
  while (eng.k < eng.stepsTotal - 1) {
    const s = eng.step();
    if (onSample && eng.k % stride === 0) onSample(s, eng);
    if (eng.dead) break;
  }
  return {
    dead: eng.dead,
    failures: eng.failures,
    peak: eng.peak,
    driftEnv: Float64Array.from(eng.driftEnv),
    accelEnv: Float64Array.from(eng.accelEnv),
    maxDriftIndex: argMax(eng.driftEnv),
    endK: eng.k,
  };
}
function argMax(a) { let m = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[m]) m = i; return m; }

// 无控基线（关闭所有装置 + 电网）
function baselineConfig(config) {
  const c = clone(config);
  c.isolated = DEVICE_STORIES.map(() => true);
  c.powerMode = 'grid';
  c.events = c.events.filter(e => e.kind !== 'grid'); // 无控基线不受供电影响
  return c;
}

// ---------------- 复现码 ----------------
function encodeRun(config, log) {
  const payload = { c: config, l: log || [] };
  return 'G' + b64(JSON.stringify(payload));
}
function decodeRun(code) {
  const json = unb64(code.replace(/^G/, ''));
  const p = JSON.parse(json);
  return { config: p.c, log: p.l || [] };
}
function b64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64url');
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64url').toString('utf8');
  return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
}

const EXPORTS = {
  N, DT, STORY_H, FMAX, DEVICE_STORIES, BATTERY_CAPACITY, OBJECTIVES, DEFAULT_CONFIG,
  Engine, runFull, baselineConfig, buildGround, buildStructure, makeController,
  clone, encodeRun, decodeRun, mulberry32, genQuake, QUAKE_SPEC,
};
if (typeof module !== 'undefined' && module.exports) module.exports = EXPORTS;
if (typeof window !== 'undefined') window.SIM = EXPORTS;
