'use strict';
const S = window.SIM;
const $ = id => document.getElementById(id);
const LS_KEY = 'gsb-vib-state-v1';

// ---------- 全局状态 ----------
let config = normalize(S.DEFAULT_CONFIG());
let eng = null;
let playing = false;
let speed = 1;
let baseline = null;                 // 无控基线全程包络
let checkpoints = [];                // {name, snap, label}
let traces = null;                   // 当前轨迹的轻量历史（20Hz 采样）
const STRIDE = 5;
let branchCompare = null;            // 离线分支对比 {name, peak, driftEnv, accelEnv, dead}

function normalize(c) {
  c = JSON.parse(JSON.stringify(c));
  if (!c.isolated) c.isolated = S.DEVICE_STORIES.map(() => false);
  if (!c.events) c.events = [];
  if (!c.fmax) c.fmax = S.FMAX;
  c.events.forEach(e => { if (e.kind === 'fault' && e.device == null) e.device = 0; });
  return c;
}

const PRESETS = {
  classic: () => ({
    seed: 20260922, horizon: 60, objective: 'top', powerMode: 'grid', fmax: S.FMAX,
    isolated: [false, false, false, false, false, false],
    events: [
      { kind: 'quake', type: 'main', t: 6 },
      { kind: 'fault', device: 2, t: 14 },
      { kind: 'quake', type: 'after', t: 22 },
    ],
  }),
  blackout: () => ({
    seed: 7711, horizon: 70, objective: 'drift', powerMode: 'auto', fmax: S.FMAX,
    isolated: [false, false, false, false, false, false],
    events: [
      { kind: 'quake', type: 'main', t: 5 },
      { kind: 'grid', off: true, t: 8 },
      { kind: 'fault', device: 4, t: 17 },
      { kind: 'grid', off: false, t: 40 },
    ],
  }),
  swarm: () => ({
    seed: 909090, horizon: 80, objective: 'accel', powerMode: 'grid', fmax: S.FMAX,
    isolated: [false, false, false, false, false, false],
    events: [
      { kind: 'quake', type: 'main', t: 4 },
      { kind: 'fault', device: 0, t: 10 },
      { kind: 'quake', type: 'after', t: 13 },
      { kind: 'fault', device: 3, t: 16 },
      { kind: 'quake', type: 'after', t: 24 },
      { kind: 'quake', type: 'after', t: 38 },
    ],
  }),
};

// ---------- 引擎生命周期 ----------
function buildEngine() {
  eng = new S.Engine(config);
  traces = { t: [], top: [], acc: [], margin: [], batt: [], grid: [], forces: [] };
  recordTrace(true);
}
function rebuildBaseline() {
  baseline = runSummary(S.baselineConfig(config));
}
function runSummary(cfg) {
  const e = new S.Engine(cfg);
  let topAcc = 0;
  const drift = new Float64Array(S.N), acc = new Float64Array(S.N);
  let sat = 0, tot = 0, forceSum = 0;
  const ser = { t: [], top: [], acc: [], margin: [], batt: [] };
  while (e.k < e.stepsTotal - 1) {
    const sm = e.step();
    for (let i = 0; i < S.N; i++) {
      drift[i] = Math.max(drift[i], Math.abs(sm.drifts[i]));
      acc[i] = Math.max(acc[i], Math.abs(sm.accels[i]));
    }
    topAcc = Math.max(topAcc, Math.abs(sm.accels[S.N - 1]));
    for (const f of sm.forces) { forceSum += Math.abs(f); if (Math.abs(f) >= S.FMAX - 0.05) sat++; tot++; }
    if (e.k % STRIDE === 0) {
      ser.t.push(e.t); ser.top.push(sm.x[S.N - 1]); ser.acc.push(sm.accels[S.N - 1]);
      ser.margin.push(sm.margin); ser.batt.push(sm.batt);
    }
    if (e.dead) break;
  }
  return { top: e.peak.top, topAcc, drift, acc, ser, dead: e.dead, endT: e.k * S.DT,
           driftRatio: e.peak.drift / S.STORY_H, satPct: tot ? sat / tot : 0 };
}
function recordTrace(force) {
  if (!force && eng.k % STRIDE !== 0) return;
  const s = eng.last;
  traces.t.push(eng.t);
  traces.top.push(s.x[S.N - 1]);
  traces.acc.push(s.accels[S.N - 1]);
  let fm = 0; for (const f of s.forces) fm += Math.abs(f);
  traces.forces.push(fm);
  traces.margin.push(s.margin);
  traces.batt.push(s.batt);
  traces.grid.push(s.gridUp ? 1 : 0);
}

// ---------- 左侧配置渲染 ----------
const EV_LABEL = { main: '主震（罕遇）', after: '余震', fault: '装置故障', gridoff: '市电中断', gridon: '市电恢复' };
function fmtEvent(e) {
  if (e.kind === 'quake') return e.type === 'main' ? '主震' : '余震';
  if (e.kind === 'fault') return `D${e.device + 1} 故障`;
  if (e.kind === 'grid') return e.off ? '市电中断' : '市电恢复';
  return '?';
}
function renderEventList() {
  const box = $('evList');
  box.innerHTML = '';
  const evs = config.events.slice().sort((a, b) => a.t - b.t);
  evs.forEach(ev => {
    const origIdx = config.events.indexOf(ev);
    const div = document.createElement('div');
    div.className = 'ev';
    const cls = ev.kind === 'quake' ? (ev.type === 'main' ? 'q' : 'q') : ev.kind === 'fault' ? 'f' : 'g';
    div.innerHTML = `<span class="pill" style="background:${cls === 'q' ? 'var(--purple)' : cls === 'f' ? 'var(--bad)' : 'var(--warn)'}"></span>
      <span class="t">${Number(ev.t).toFixed(1)}s</span><span class="k">${fmtEvent(ev)}</span>`;
    const del = document.createElement('button');
    del.className = 'sm danger'; del.textContent = '×';
    del.onclick = () => { config.events.splice(origIdx, 1); applyConfigChange(); };
    div.appendChild(del);
    box.appendChild(div);
  });
}
function renderDevices() {
  const box = $('devList');
  box.innerHTML = '';
  S.DEVICE_STORIES.forEach((story, d) => {
    const faulted = eng && eng.faulted[d];
    const iso = config.isolated[d];
    const div = document.createElement('div');
    div.className = 'dev' + (faulted ? ' fault' : '') + (iso ? ' iso' : '');
    div.innerHTML = `<span class="dot"></span><span class="nm">D${d + 1}</span>
      <span class="fl">${story + 1} 层</span>`;
    const state = document.createElement('span');
    state.className = 'tag';
    state.textContent = faulted ? '故障' : iso ? '已隔离' : '在线';
    state.style.color = faulted ? 'var(--bad)' : iso ? 'var(--dim)' : 'var(--ok)';
    div.appendChild(state);
    if (!faulted) {
      const btn = document.createElement('button');
      btn.className = 'sm';
      btn.textContent = iso ? '恢复' : '隔离';
      btn.onclick = () => { config.isolated[d] = !config.isolated[d]; syncAll(); };
      div.appendChild(btn);
    }
    box.appendChild(div);
  });
}
function renderSegs() {
  document.querySelectorAll('#objSeg button').forEach(b => b.classList.toggle('on', b.dataset.obj === config.objective));
  document.querySelectorAll('#pwrSeg button').forEach(b => b.classList.toggle('on', b.dataset.pwr === config.powerMode));
  $('objHint').textContent = {
    top: '强力压制一阶摆振，顶层位移最低；高模态控制力可能让顶部层间变形与底层受力上升。',
    accel: '优先压低楼层加速度（舒适度），但可能放宽顶部绝对位移。',
    drift: '在所有楼层均匀分配变形，避免薄弱层集中损伤，顶摆控制略弱。',
    economy: '提高出力代价、节省电力，地震峰值期间控制余量最小。',
  }[config.objective];
  $('seedInput').value = config.seed;
  $('horizonInput').value = config.horizon;
}

// 装置隔离/恢复：即时改变可用装置集合（确定性地从 0 重建）
function syncAll() {
  pause();
  buildEngine();
  rebuildBaseline();
  renderDevices();
  $('scrub').max = eng.stepsTotal - 1;
  $('scrub').value = 0;
  requestRender();
}

// ---------- 配置变更：保留已发生历史代价太高，统一从 0 重启情景 ----------
function applyConfigChange() {
  checkpoints = [];
  branchCompare = null;
  playing = false; $('btnPlay').textContent = '▶';
  config = normalize(config);
  buildEngine(); rebuildBaseline();
  renderEventList(); renderDevices(); renderSegs(); renderCpList();
  $('scrub').max = eng.stepsTotal - 1;
  requestRender();
}

function wireControls() {
  $('seedInput').onchange = e => { config.seed = Number(e.target.value) || 1; applyConfigChange(); };
  $('horizonInput').onchange = e => { config.horizon = Math.max(20, Number(e.target.value) || 60); applyConfigChange(); };
  document.querySelectorAll('#objSeg button').forEach(b => b.onclick = () => { config.objective = b.dataset.obj; applyConfigChange(); });
  document.querySelectorAll('#pwrSeg button').forEach(b => b.onclick = () => { config.powerMode = b.dataset.pwr; applyConfigChange(); });
  document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { config = normalize(PRESETS[b.dataset.preset]()); applyConfigChange(); });

  $('addKind').onchange = e => { $('addDevWrap').style.display = e.target.value === 'fault' ? 'flex' : 'none'; };
  const devSel = $('addDev');
  S.DEVICE_STORIES.forEach((s, d) => { const o = document.createElement('option'); o.value = d; o.textContent = `D${d + 1}（${s + 1}层）`; devSel.appendChild(o); });
  $('btnAddEvent').onclick = () => {
    const kind = $('addKind').value, t = Number($('addTime').value);
    if (!(t >= 0) || t > config.horizon) { flashBanner('时刻超出情景范围', true); return; }
    let ev;
    if (kind === 'main' || kind === 'after') ev = { kind: 'quake', type: kind, t };
    else if (kind === 'fault') ev = { kind: 'fault', device: Number(devSel.value), t };
    else ev = { kind: 'grid', off: kind === 'gridoff', t };
    config.events.push(ev);
    applyConfigChange();
  };

  $('btnPlay').onclick = togglePlay;
  $('btnStep').onclick = () => {
    pause();
    const next = config.events.filter(e => e.t > eng.t + 0.02).sort((a, b) => a.t - b.t)[0];
    const target = next ? Math.round(next.t / S.DT) : Math.min(eng.stepsTotal - 1, eng.k + Math.round(0.5 / S.DT));
    seekTo(Math.min(target, eng.stepsTotal - 1));
    flashBanner(next ? '⏭ 单步推进到：' + fmtEvent(next) + ' @ ' + Number(next.t).toFixed(1) + 's' : '⏭ 单步推进 0.5s', false);
  };
  $('speed').onchange = e => { speed = Number(e.target.value); };
  $('scrub').oninput = e => {
    pause();
    const target = Number(e.target.value);
    seekTo(target);
    requestRender();
  };
  $('btnCheckpoint').onclick = addCheckpoint;
  $('btnRollback').onclick = rollbackLatest;
  $('btnRestart').onclick = () => { buildEngine(); renderDevices(); $('scrub').value = 0; checkpoints = []; renderCpList(); requestRender(); };
  $('btnCopyCode').onclick = copyCode;
  $('btnRestoreCode').onclick = restoreCode;
  $('btnSave').onclick = saveLocal;
}

function seekTo(targetK) {
  // 确定性快进到任意步（从零重放）
  buildEngine();
  recordTrace(true);
  while (eng.k < targetK && !eng.dead) { eng.step(); recordTrace(); }
  recordTrace(true);
  renderDevices();
  // seek 是用户主动跳转，不弹事件暂停横幅（但保留失败横幅）
  $('scrub').value = eng.k;
  if (eng.dead) {
    const msg = eng.failures.length ? eng.failures[eng.failures.length - 1].msg : '推演终止';
    flashBanner('⛔ ' + msg + ' — 可回滚到关键节点改变策略', true);
  } else {
    clearBanner();
  }
  requestRender();
}

// ---------- 播放循环 ----------
function togglePlay() {
  if (eng.dead || eng.k >= eng.stepsTotal - 1) return;
  playing = !playing;
  $('btnPlay').textContent = playing ? '⏸' : '▶';
  if (playing) loop();
}
function pause() { playing = false; $('btnPlay').textContent = '▶'; }
let lastWall = 0;
function loop(ts) {
  if (!playing) return;
  if (!lastWall) lastWall = ts || performance.now();
  const now = ts || performance.now();
  let dtWall = (now - lastWall) / 1000;
  lastWall = now;
  dtWall = Math.min(dtWall, 0.1);
  const steps = Math.max(1, Math.round(dtWall * speed / S.DT));
  let hitPause = false;
  for (let i = 0; i < steps; i++) {
    if (eng.dead || eng.k >= eng.stepsTotal - 1) { pause(); break; }
    eng.step(); recordTrace();
    if (eng.pausedReasons.length) { hitPause = true; break; }
  }
  if (hitPause) pause();
  renderDevices();
  afterAdvance(hitPause);
  if (playing) requestAnimationFrame(loop);
}
function advance() { eng.step(); recordTrace(); afterAdvance(false); }

function afterAdvance(showAlert) {
  $('scrub').value = eng.k;
  if (eng.dead) {
    const msg = eng.failures.length ? eng.failures[eng.failures.length - 1].msg : (eng.pausedReasons[0] || '推演终止');
    eng.pausedReasons.length = 0;
    flashBanner('⛔ ' + msg + ' — 可回滚到关键节点改变策略', true);
  } else if (eng.pausedReasons.length) {
    flashBanner('⏸ ' + eng.pausedReasons.shift(), false);
  } else {
    clearBanner();
  }
  if (eng.dead) pause();
  requestRender();
}

let bannerTimer = null;
function flashBanner(text, danger) {
  const b = $('banner');
  b.textContent = text;
  b.classList.add('show');
  b.classList.toggle('warnb', !danger);
  clearTimeout(bannerTimer);
  if (!danger) bannerTimer = setTimeout(clearBanner, 2600);
}
function clearBanner() { $('banner').classList.remove('show'); }

// ---------- 关键节点 / 回滚 ----------
function addCheckpoint() {
  const name = `节点 ${checkpoints.length + 1} · t=${eng.t.toFixed(1)}s`;
  checkpoints.push({ name, snap: eng.snapshot() });
  renderCpList();
  flashBanner('⚑ 已记录关键节点（含完整状态与当时控制配置）', false);
}
function renderCpList() {
  const box = $('cpList'); box.innerHTML = '';
  if (!checkpoints.length) { box.innerHTML = '<div class="hint">尚无节点。</div>'; return; }
  checkpoints.forEach((cp, i) => {
    const div = document.createElement('div');
    div.className = 'branch';
    div.innerHTML = `<span style="color:var(--cyan)">⚑</span><span style="flex:1;color:var(--txt)">${cp.name}</span>`;
    const b1 = document.createElement('button'); b1.className = 'sm'; b1.textContent = '回滚';
    b1.onclick = () => rollbackTo(i);
    const b2 = document.createElement('button'); b2.className = 'sm'; b2.textContent = '试分支';
    b2.onclick = () => compareBranch(i);
    div.appendChild(b1); div.appendChild(b2);
    box.appendChild(div);
  });
}
function rollbackLatest() {
  if (!checkpoints.length) { flashBanner('还没有关键节点可回滚', false); return; }
  rollbackTo(checkpoints.length - 1);
}
function rollbackTo(i) {
  const cp = checkpoints[i];
  pause();
  // 回到该节点，并采用节点时的控制配置（目标/隔离/供电）
  eng.restore(JSON.parse(JSON.stringify(cp.snap)));
  config = normalize(eng.cfg);
  rebuildBaseline();
  renderEventList(); renderDevices(); renderSegs();
  $('scrub').max = eng.stepsTotal - 1;
  traces = { t: [], top: [], acc: [], margin: [], batt: [], grid: [], forces: [] };
  seekTo(eng.k);
  flashBanner(`↶ 已回滚到「${cp.name}」，可改变策略后重跑`, false);
}
function compareBranch(i) {
  // 从节点出发，用“层间均匀”策略离线推演，作为备选分支对比
  const cp = checkpoints[i];
  const e2 = new S.Engine(S.clone(cp.snap.cfg));
  e2.restore(JSON.parse(JSON.stringify(cp.snap)));
  const origObj = e2.cfg.objective;
  e2.cfg.objective = origObj === 'drift' ? 'top' : 'drift';
  let topAcc = 0; const drift = new Float64Array(S.N); const acc = new Float64Array(S.N);
  while (e2.k < e2.stepsTotal - 1) {
    const sm = e2.step();
    for (let j = 0; j < S.N; j++) { drift[j] = Math.max(drift[j], Math.abs(sm.drifts[j])); acc[j] = Math.max(acc[j], Math.abs(sm.accels[j])); }
    topAcc = Math.max(topAcc, Math.abs(sm.accels[S.N - 1]));
    if (e2.dead) break;
  }
  branchCompare = { from: cp.name, alt: e2.cfg.objective, top: e2.peak.top, topAcc, drift, acc, dead: e2.dead };
  requestRender();
  flashBanner(`已生成「${cp.name}」之后改用「${S.OBJECTIVES[e2.cfg.objective].label}」的离线分支对比`, false);
}

// ---------- 复现码 / 本地持久化 ----------
function currentCode() {
  return S.encodeRun(config, [{ k: eng ? eng.k : 0, obj: config.objective, pwr: config.powerMode, iso: config.isolated.slice() }]);
}
function copyCode() {
  const code = currentCode();
  $('codebox').textContent = code;
  navigator.clipboard?.writeText(code).then(() => flashBanner('复现码已复制（含种子、事件序列、配置）', false));
}
function restoreCode() {
  const code = prompt('粘贴复现码（G 开头）：');
  if (!code) return;
  try {
    const { config: c } = S.decodeRun(code.trim());
    config = normalize(c);
    applyConfigChange();
    flashBanner('已按复现码确定性重建情景', false);
  } catch (err) {
    flashBanner('复现码无效：' + err.message, true);
  }
}
function saveLocal() {
  localStorage.setItem(LS_KEY, JSON.stringify({ code: currentCode(), checkpoints: checkpoints.map(cp => ({ name: cp.name, snap: cp.snap })) }));
  flashBanner('已存入浏览器；下次打开本页自动恢复', false);
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const { config: c } = S.decodeRun(data.code);
    config = normalize(c);
    checkpoints = (data.checkpoints || []).map(cp => ({ name: cp.name, snap: cp.snap }));
    return true;
  } catch { return false; }
}

// ---------- Canvas 工具 ----------
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(2, Math.round(r.width * dpr));
  cv.height = Math.max(2, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}
function heatColor(ratio) {
  // ratio 相对 1/100 的比例
  const x = Math.min(1.4, ratio / 0.01);
  if (x < 0.35) return `rgba(63,185,80,${0.25 + x})`;
  if (x < 0.7) return `rgba(210,153,34,${0.4 + (x - 0.35)})`;
  return `rgba(248,81,73,${0.5 + Math.min(0.5, x - 0.7)})`;
}
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}
window.addEventListener('resize', requestRender);

// ---------- 建筑主动画 ----------
function drawBuilding() {
  const cv = $('viz');
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const s = eng.last;
  const n = S.N;
  const topPad = 64, bottomPad = 96;
  const floorH = Math.min(34, (h - topPad - bottomPad) / n);
  const buildH = floorH * n;
  const groundY = h - bottomPad;
  const cx = w * 0.42;
  const bw = 132;

  // 位移显示比例（用最大可能位移归一，保证可见且不过度）
  const maxX = Math.max(0.012, Math.max(...Array.from(s.x).map(Math.abs)), baseline ? baseline.top : 0.01);
  const pxScale = (w * 0.20) / (maxX * 1.15);
  const xPx = i => cx + s.x[i] * pxScale;

  // 地面
  ctx.strokeStyle = '#3a4657'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(20, groundY + 22); ctx.lineTo(w - 20, groundY + 22); ctx.stroke();
  // 地面运动箭头/波形
  const ag = s.ag;
  ctx.strokeStyle = ag >= 0 ? '#bc8cff' : '#39c5cf'; ctx.lineWidth = 2;
  ctx.beginPath();
  const waveW = 150, wcx = cx;
  for (let i = 0; i <= 60; i++) {
    const tt = i / 60;
    const g = eng.ground[Math.max(0, eng.k - Math.round(tt * 60))] || 0;
    const px = wcx + (tt - 0.5) * waveW;
    const py = groundY + 38 - g * 60 * (tt > 0.03 ? 1 : 0);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.fillStyle = '#8b97a7'; ctx.font = '11px sans-serif';
  ctx.fillText(`地面加速度 ${ag >= 0 ? '→' : '←'} ${(ag * 9.8).toFixed(2)} m/s²`, 24, groundY + 60);

  // 楼体：从顶到底绘制层
  for (let i = n - 1; i >= 0; i--) {
    const yTop = groundY - (i + 1) * floorH;
    const yBot = groundY - i * floorH;
    const xTop = xPx(i), xBot = i === 0 ? cx : xPx(i - 1);
    const drift = s.drifts[i];
    const ratio = Math.abs(drift) / S.STORY_H;

    // 层间填充（位移角热色）
    ctx.beginPath();
    ctx.moveTo(xTop - bw / 2, yTop); ctx.lineTo(xTop + bw / 2, yTop);
    ctx.lineTo(xBot + bw / 2, yBot); ctx.lineTo(xBot - bw / 2, yBot); ctx.closePath();
    ctx.fillStyle = heatColor(ratio);
    ctx.fill();
    ctx.strokeStyle = '#3d4a5e'; ctx.lineWidth = 1; ctx.stroke();

    // 楼板加粗
    ctx.strokeStyle = '#6b7a90'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xTop - bw / 2 - 6, yTop); ctx.lineTo(xTop + bw / 2 + 6, yTop); ctx.stroke();

    // 楼层标签
    ctx.fillStyle = '#aab6c5'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${i + 1}F`, cx - bw / 2 - 12, yTop + floorH * 0.62);

    // 位移角数值（超过 1/200 高亮）
    ctx.textAlign = 'left';
    const danger = ratio > 1 / 200;
    ctx.fillStyle = danger ? '#ff8075' : '#7e8b9c';
    ctx.fillText(ratio > 3e-6 ? `${(drift * 1000).toFixed(1)}mm` : '', cx + bw / 2 + 12, yTop + floorH * 0.62);
  }
  ctx.textAlign = 'start';

  // 装置与控制力
  S.DEVICE_STORIES.forEach((story, d) => {
    const y = groundY - (story + 0.5) * floorH;
    const xc = xPx(story);
    const faulted = s.faulted[d], iso = s.isolated[d];
    const f = s.forces[d];
    // 装置本体
    ctx.fillStyle = faulted ? '#5a2a28' : iso ? '#2a313c' : '#17334f';
    ctx.strokeStyle = faulted ? '#f85149' : iso ? '#5a6675' : '#4da3ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(xc - 10, y - 6, 20, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = faulted ? '#ff8075' : iso ? '#7e8b9c' : '#9cc4ff';
    ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`D${d + 1}`, xc, y + 3);
    if (faulted) { ctx.strokeStyle = '#f85149'; ctx.beginPath(); ctx.moveTo(xc - 8, y - 4); ctx.lineTo(xc + 8, y + 4); ctx.moveTo(xc + 8, y - 4); ctx.lineTo(xc - 8, y + 4); ctx.stroke(); }
    // 控制力箭头
    if (!faulted && !iso && Math.abs(f) > 0.05) {
      const len = (f / s2cap()) * 56;
      ctx.strokeStyle = '#39c5cf'; ctx.fillStyle = '#39c5cf'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xc, y); ctx.lineTo(xc + len, y); ctx.stroke();
      arrowHead(ctx, xc + len, y, f > 0 ? 0 : Math.PI);
    }
    ctx.textAlign = 'start';
  });

  // 顶部摆幅标注
  ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 12px sans-serif';
  ctx.fillText(`顶部水平位移 ${(s.x[n - 1] * 1000).toFixed(1)} mm`, 16, 26);
  ctx.fillStyle = '#8b97a7'; ctx.font = '11px sans-serif';
  ctx.fillText(`顶加速度 ${(s.accels[n - 1] * 9.8).toFixed(2)} m/s²`, 16, 44);

  // 图例
  const legends = [['#bc8cff', '地震输入'], ['#39c5cf', '控制力'], ['#f85149', '故障装置'], ['#d29922', '位移角警戒']];
  legends.forEach((l, i) => {
    ctx.fillStyle = l[0]; ctx.fillRect(w - 132 + (i % 2) * 70, 22 + Math.floor(i / 2) * 18, 9, 9);
    ctx.fillStyle = '#8b97a7'; ctx.font = '10px sans-serif';
    ctx.fillText(l[1], w - 120 + (i % 2) * 70, 31 + Math.floor(i / 2) * 18);
  });
}
function s2cap() { return config.fmax || S.FMAX; }
function arrowHead(ctx, x, y, ang) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 7 * Math.cos(ang - 0.4), y - 7 * Math.sin(ang - 0.4));
  ctx.lineTo(x - 7 * Math.cos(ang + 0.4), y - 7 * Math.sin(ang + 0.4));
  ctx.closePath(); ctx.fill();
}

// ---------- 指标面板 ----------
function pct(cur, base) {
  const d = (cur - base) / Math.max(1e-9, base);
  return d;
}
function deltaSpan(d, unit, digits, invert) {
  const p = d * 100;
  const good = invert ? p > 0 : p < 0;
  const cls = Math.abs(p) < 3 ? '' : good ? 'down' : 'up';
  const arrow = p > 0 ? '▲' : p < 0 ? '▼' : '＝';
  return { text: `${arrow} ${Math.abs(p).toFixed(digits || 0)}% vs 无控`, cls };
}
function renderMetrics() {
  const s = eng.last;
  const top = eng.peak.top;
  const acc = eng.peak.accel;
  const drift = eng.peak.drift;
  let force = 0, sat = 0;
  s.forces.forEach(f => { force += Math.abs(f); if (Math.abs(f) >= s2cap() - 0.02) sat++; });
  // 历史饱和率
  let satHist = 0, fHist = 0;
  for (let k = 0; k < traces.forces.length; k++) { fHist += traces.forces[k]; }
  $('mTop').textContent = `${(top * 1000).toFixed(1)} mm`;
  $('mAcc').textContent = `${(acc * 9.8).toFixed(2)} m/s²`;
  const ratio = drift / S.STORY_H;
  $('mDrift').textContent = ratio > 1e-6 ? `1/${Math.round(1 / ratio)}` : '–';
  $('mForce').textContent = `${force.toFixed(1)}`;
  if (baseline) {
    setPeakDelta('mTopD', top, baseline.top);
    setPeakDelta('mAccD', acc, baseline.topAcc);
    setPeakDelta('mDriftD', drift, baseline.driftRatio * S.STORY_H);
    const satPct = force > 0 ? Math.min(100, (sat / Math.max(1, s.forces.filter(f => Math.abs(f) > 0.02).length)) * 100) : 0;
    $('mForceD').textContent = `本步饱和 ${satPct.toFixed(0)}%`;
  }
}
function setPeakDelta(id, cur, base) {
  const el = $(id);
  if (base < 1e-6 || eng.k < 20) { el.textContent = '— 积累中'; el.className = 'd'; return; }
  const d = deltaSpan((cur - base) / base, '', 0);
  setDelta(id, d);
}
function setDelta(id, d) {
  const el = $(id); el.textContent = d.text; el.className = 'd ' + d.cls;
}

// ---------- 楼层热区 ----------
function renderHeat() {
  const box = $('heat'); box.innerHTML = '';
  const s = eng.last;
  for (let i = S.N - 1; i >= 0; i--) {
    const ratio = eng.driftEnv[i] / S.STORY_H;
    const acc = eng.accelEnv[i] * 9.8;
    const blRatio = baseline ? baseline.drift[i] / S.STORY_H : ratio;
    const worse = ratio > blRatio * 1.08;
    const name = document.createElement('span'); name.className = 'lab'; name.textContent = `${i + 1}F`;
    const bar = document.createElement('span'); bar.className = 'bar';
    const fill = document.createElement('i');
    const width = Math.min(100, ratio / 0.008 * 100);
    fill.style.width = width + '%';
    fill.style.background = heatColor(ratio);
    if (worse) fill.style.boxShadow = '0 0 6px var(--bad)';
    bar.appendChild(fill);
    const num = document.createElement('span'); num.className = 'num';
    num.textContent = ratio > 1e-6 ? `1/${Math.round(1 / ratio)}` : '–';
    num.style.color = worse ? 'var(--bad)' : 'var(--dim)';
    box.appendChild(name); box.appendChild(bar); box.appendChild(num);
  }
  // 代价文字
  const note = $('tradeoffNote');
  let worstNow = 0, worstBl = 0, wi = 0;
  for (let i = 0; i < S.N; i++) if (eng.driftEnv[i] > worstNow) { worstNow = eng.driftEnv[i]; wi = i; }
  for (let i = 0; i < S.N; i++) worstBl = Math.max(worstBl, baseline ? baseline.drift[i] : worstNow);
  const costBits = [], accBits = [];
  for (let i = 0; i < S.N; i++) {
    if (baseline && eng.driftEnv[i] > baseline.drift[i] * 1.1)
      costBits.push(`${i + 1}F×${(eng.driftEnv[i] / baseline.drift[i]).toFixed(2)}`);
    if (baseline && eng.accelEnv[i] > baseline.acc[i] * 1.2 && eng.accelEnv[i] > 0.15)
      accBits.push(`${i + 1}F×${(eng.accelEnv[i] / baseline.acc[i]).toFixed(2)}`);
  }
  let html = costBits.length
    ? `⚠ <b style="color:var(--bad)">层间变形超过无控</b>：${costBits.join('、')}。`
    : '✓ 各层位移角均未超过无控基线。';
  if (accBits.length)
    html += `<br><b style="color:var(--warn)">楼层加速度/受力超过无控</b>：${accBits.slice(0, 8).join('、')}。`;
  html += `<div style="margin-top:4px">压低顶摆可能把受力转移到中下部楼层与薄弱层，请同时关注两类代价。</div>`;
  note.innerHTML = html;
}

// ---------- 代价面板：当前策略 vs 基线 vs 分支 ----------
function renderCost() {
  const box = $('costPanel');
  if (!baseline) { box.innerHTML = ''; return; }
  const cur = {
    top: eng.peak.top, acc: eng.peak.accel,
    drift: eng.peak.drift / S.STORY_H,
  };
  const bl = { top: baseline.top, acc: baseline.topAcc, drift: baseline.driftRatio };
  const early = eng.k < 20;
  const row = (label, c, b, fmt) => {
    const d = (c - b) / Math.max(b, 1e-9) * 100;
    const cls = Math.abs(d) < 3 || early ? '' : d < 0 ? 'down' : 'up';
    return `<div class="row" style="justify-content:space-between;margin:2px 0">
      <span class="lab" style="color:var(--dim)">${label}</span>
      <span><b>${fmt(c)}</b> ${early ? '' : `<span class="${cls}">${d > 0 ? '+' : ''}${d.toFixed(0)}%</span>`}</span></div>`;
  };
  let html = row('顶部摆动', cur.top, bl.top, v => (v * 1000).toFixed(1) + 'mm');
  html += row('顶部加速度', cur.acc, bl.acc, v => (v * 9.8).toFixed(2));
  html += row('最大位移角', cur.drift, bl.drift, v => v > 1e-6 ? '1/' + Math.round(1 / v) : '–');
  // 最薄弱层位置
  let ci = 0, bi = 0;
  for (let i = 1; i < S.N; i++) { if (eng.driftEnv[i] > eng.driftEnv[ci]) ci = i; if (baseline.drift[i] > baseline.drift[bi]) bi = i; }
  html += `<div class="row" style="justify-content:space-between;margin:2px 0">
    <span class="lab" style="color:var(--dim)">最薄弱层</span>
    <span>${ci + 1}F <span style="color:var(--dim)">（无控 ${bi + 1}F）</span>${ci !== bi ? ' <span class="up">发生转移</span>' : ''}</span></div>`;
  if (branchCompare) {
    const alt = branchCompare;
    const dTop = (alt.top - cur.top) / Math.max(cur.top, 1e-9) * 100;
    const ad = alt.drift.reduce((m, v) => Math.max(m, v), 0) / S.STORY_H;
    const dd = (ad - cur.drift) / cur.drift * 100;
    html += `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)">
      <div style="color:var(--cyan);font-size:11px">分支：${alt.from} 后改用「${S.OBJECTIVES[alt.alt].label}」${alt.dead ? ' <span class="up">(失败)</span>' : ''}</div>
      <div class="row" style="justify-content:space-between"><span class="lab" style="color:var(--dim)">顶摆</span><span class="${dTop < 0 ? 'down' : 'up'}">${dTop > 0 ? '+' : ''}${dTop.toFixed(0)}%</span></div>
      <div class="row" style="justify-content:space-between"><span class="lab" style="color:var(--dim)">最大位移角</span><span class="${dd < 0 ? 'down' : 'up'}">${dd > 0 ? '+' : ''}${dd.toFixed(0)}%</span></div></div>`;
  }
  box.innerHTML = html;
}

// ---------- 余震预测 ----------
function renderForecast() {
  const box = $('forecast');
  const fc = eng.forecast();
  let html = '';
  if (fc.upcoming.length) {
    fc.upcoming.forEach(u => {
      const pgaG = (u.pga * 9.8).toFixed(2);
      const bandG = (u.band * 9.8).toFixed(2);
      const color = u.type === 'main' ? 'var(--purple)' : 'var(--cyan)';
      html += `<div class="fc"><span class="pill" style="background:${color}"></span>
        ${u.dt < 0.05 ? '正在发生' : u.dt.toFixed(1) + 's 后'} · ${u.type === 'main' ? '主震' : '余震'}
        <div style="color:var(--dim);font-size:11px;margin-top:2px">预测峰值 ${pgaG} m/s²，不确定带上界约 ${bandG} m/s²</div></div>`;
    });
  } else {
    html = '<div class="fc" style="color:var(--dim)">序列中暂无待发生地震事件。</div>';
  }
  html += `<div class="fc" style="font-size:11px">未来 30s 出现超阈值余震的背景概率：<b style="color:var(--warn)">${(fc.bg30 * 100).toFixed(0)}%</b>
    <div style="color:var(--dim)">（Omori 衰减模型，随主震后时间下降）</div></div>`;
  box.innerHTML = html;
}

// ---------- 时间轴 ----------
function renderTimeline() {
  $('tlprog').style.width = (eng.k / (eng.stepsTotal - 1) * 100) + '%';
  const bar = $('tlbar');
  bar.querySelectorAll('.tlmarker').forEach(e => e.remove());
  const evs = config.events;
  evs.forEach(ev => {
    const m = document.createElement('div');
    m.className = 'tlmarker ' + (ev.kind === 'quake' ? 'q' : ev.kind === 'fault' ? 'f' : 'g');
    m.style.left = (ev.t / config.horizon * 100) + '%';
    m.title = `${ev.t.toFixed(1)}s ${fmtEvent(ev)}`;
    bar.appendChild(m);
  });
  checkpoints.forEach(cp => {
    const t = cp.snap.k * S.DT;
    const m = document.createElement('div');
    m.className = 'tlmarker cp';
    m.style.left = (t / config.horizon * 100) + '%';
    m.title = cp.name;
    bar.appendChild(m);
  });
  $('clock').textContent = eng.t.toFixed(1) + 's';
}

// ---------- 曲线 ----------
function drawChart(cv, series, opts) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 34, r: 8, t: 6, b: 14 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const tMax = config.horizon;
  let ymax = 1e-9;
  series.forEach(sr => {
    if (sr.ind) { sr._m = 1e-9; sr.data.forEach(v => sr._m = Math.max(sr._m, Math.abs(v) * 1.15)); }
    else sr.data.forEach(v => ymax = Math.max(ymax, Math.abs(v) * 1.15));
  });
  const X = t => pad.l + (t / tMax) * iw;
  const Y = (v, m) => pad.t + ih / 2 - (v / (m || ymax)) * (ih / 2);
  // 网格
  ctx.strokeStyle = '#1d2530'; ctx.lineWidth = 1; ctx.fillStyle = '#6b7a90'; ctx.font = '9px sans-serif';
  for (let g = -1; g <= 1; g++) {
    const y = Y(g * (g === 0 ? 0 : 1), 1);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
  }
  if (opts.fmt) { ctx.fillText(opts.fmt(ymax), 2, pad.t + 8); ctx.fillText(opts.fmt(-ymax), 2, pad.t + ih - 2); }
  // 事件标记
  config.events.forEach(ev => {
    ctx.strokeStyle = ev.kind === 'quake' ? 'rgba(188,140,255,.35)' : ev.kind === 'fault' ? 'rgba(248,81,73,.35)' : 'rgba(210,153,34,.35)';
    ctx.beginPath(); ctx.moveTo(X(ev.t), pad.t); ctx.lineTo(X(ev.t), pad.t + ih); ctx.stroke();
  });
  // 序列
  series.forEach(sr => {
    ctx.strokeStyle = sr.color; ctx.lineWidth = sr.width || 1.4;
    ctx.setLineDash(sr.dash || []);
    ctx.beginPath();
    sr.data.forEach((v, i) => {
      const x = X(sr.t[i]), y = Y(v);
      const yy = Y(v, sr.ind ? sr._m : null);
      i === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    });
    ctx.stroke(); ctx.setLineDash([]);
  });
  // 时间游标
  ctx.strokeStyle = 'rgba(230,237,243,.5)';
  ctx.beginPath(); ctx.moveTo(X(eng.t), pad.t); ctx.lineTo(X(eng.t), pad.t + ih); ctx.stroke();
}
function drawCharts() {
  const bl = baseline ? baseline.ser : null;
  const respSeries = [
    { t: traces.t, data: traces.top, color: '#4da3ff' },
    bl ? { t: bl.t, data: bl.top, color: 'rgba(139,151,167,.7)', dash: [4, 3] } : null,
    { t: traces.t, data: traces.acc, color: '#bc8cff', width: 1, ind: true },
    bl ? { t: bl.t, data: bl.acc, color: 'rgba(188,140,255,.35)', dash: [2, 3], width: 1, ind: true } : null,
  ].filter(Boolean);
  drawChart($('chartResp'), respSeries, { fmt: v => (v * 1000).toFixed(0) + 'mm' });
  const pwrSeries = [
    { t: traces.t, data: traces.margin, color: '#3fb950' },
    { t: traces.t, data: traces.batt, color: '#d29922' },
    { t: traces.t, data: traces.grid.map(g => g * 0.98 + 0.01), color: '#4da3ff', dash: [2, 2], width: 1 },
  ];
  drawChart($('chartPower'), pwrSeries, { fmt: v => (v * 100).toFixed(0) + '%' });
}

function renderAll() {
  if (!eng) return;
  drawBuilding();
  drawCharts();
  renderMetrics();
  renderHeat();
  renderCost();
  renderForecast();
  renderTimeline();
  $('seedLabel').textContent = `种子 ${config.seed} · 策略：${S.OBJECTIVES[config.objective].label}`;
  $('codebox').textContent = currentCode();
}

// ---------- 启动 ----------
function init() {
  wireControls();
  if (!loadLocal()) config = normalize(S.DEFAULT_CONFIG());
  buildEngine();
  rebuildBaseline();
  $('scrub').max = eng.stepsTotal - 1;
  renderEventList(); renderDevices(); renderSegs(); renderCpList();
  requestRender();
}
init();
