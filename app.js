'use strict';

const FLOORS = 10;
const DT = 0.005;
const UI_STEP = 8;
const MASS = 120;
const STIFFNESS = 32000;
const STRUCTURAL_DAMPING = 430;
const PASSIVE_DAMPING = 760;
const DRIFT_LIMIT = 0.055;
const MID_FLOORS = [3, 4, 5, 6];
const TENDON_TOP = 9;
const TENDON_MID = 4;
const STORAGE_KEY = 'quake-control-deterministic-v1';

const EVENT_META = {
  main: { title: '主震 M7.2', short: '主震', duration: 12, acceleration: 3.72, icon: '震' },
  after: { title: '余震 M5.8', short: '余震', duration: 8, acceleration: 2.08, icon: '余' },
  fault: { title: '阻尼装置故障', short: '故障', duration: 0.08, acceleration: 0, icon: '故' }
};

const PROFILES = {
  balanced: { label: '均衡控制', damping: 1250, tendon: 4300, tendonMode: 'relative' },
  roof: { label: '压顶摆动', damping: 520, tendon: 7600, tendonMode: 'skyhook' },
  drift: { label: '层间保护', damping: 3200, tendon: 900, tendonMode: 'relative' },
  comfort: { label: '舒适优先', damping: 1350, tendon: 6000, tendonMode: 'skyhook' },
  passive: { label: '被动基线', damping: 0, tendon: 0, tendonMode: 'relative' }
};

function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededPhase(seed, salt) {
  const value = hashSeed(`${seed}:${salt}`);
  return (value % 100000) / 100000 * Math.PI * 2;
}

function faultFloorFor(seed) {
  return 1 + (hashSeed(`${seed}:fault-floor`) % FLOORS);
}

function makeDevices(seed) {
  return Array.from({ length: FLOORS }, (_, index) => ({
    floor: index + 1,
    isolated: false,
    fault: false,
    health: 100,
    heat: 0,
    phase: seededPhase(seed, `device-${index + 1}`)
  }));
}

function zeroArray(length) {
  return Array.from({ length }, () => 0);
}

function buildEvents(seed, order) {
  let start = 1.5;
  const faultFloor = faultFloorFor(seed);
  return order.map((kind, index) => {
    const meta = EVENT_META[kind];
    const event = {
      id: `${kind}-${index}`,
      kind,
      start,
      duration: meta.duration,
      fired: false,
      label: kind === 'fault' ? `${faultFloor}层阻尼装置故障` : meta.title,
      targetFloor: kind === 'fault' ? faultFloor : null
    };
    start += meta.duration + 2.2;
    return event;
  });
}

function freshRun(seed, baseline) {
  return {
    seed,
    x: zeroArray(FLOORS),
    v: zeroArray(FLOORS),
    relAcc: zeroArray(FLOORS),
    aAbs: zeroArray(FLOORS),
    groundX: 0,
    groundV: 0,
    groundAcc: 0,
    devices: makeDevices(seed),
    shear: zeroArray(FLOORS),
    drift: zeroArray(FLOORS),
    battery: baseline ? 100 : 100,
    powerMargin: baseline ? 100 : 100,
    powerScale: 1,
    hazard: 0,
    activeEnergy: 0,
    peaks: {
      roofDisp: 0,
      roofAcc: 0,
      maxDrift: 0,
      midDrift: 0,
      midShear: 0,
      baseShear: 0
    },
    records: []
  };
}

function eventGround(event, time, seed) {
  const tau = time - event.start;
  if (tau < 0 || tau > event.duration || event.kind === 'fault') return 0;
  const attack = event.kind === 'main' ? 0.13 : 0.18;
  const release = event.kind === 'main' ? 0.78 : 0.7;
  const envelope = Math.min(tau / (event.duration * attack), 1)
    * Math.max(0, 1 - Math.max(0, (tau / event.duration - attack)) / release);
  const phases = [0, 1, 2, 3].map((item) => seededPhase(seed, `${event.kind}-wave-${item}`));
  const wave = 0.42 * Math.sin(5.25 * tau + phases[0])
    + 0.29 * Math.sin(11.6 * tau + phases[1])
    + 0.19 * Math.sin(23.5 * tau + phases[2])
    + 0.10 * Math.sin(35.2 * tau + phases[3]);
  return EVENT_META[event.kind].acceleration * envelope * wave;
}

function groundAt(events, time, seed) {
  return events.reduce((sum, event) => sum + eventGround(event, time, seed), 0);
}

function hazardAt(events, time) {
  return events.reduce((max, event) => {
    const tau = time - event.start;
    if (tau < 0 || tau > event.duration || event.kind === 'fault') return max;
    const attack = event.kind === 'main' ? 0.13 : 0.18;
    const release = event.kind === 'main' ? 0.78 : 0.7;
    const envelope = Math.min(tau / (event.duration * attack), 1)
      * Math.max(0, 1 - Math.max(0, (tau / event.duration - attack)) / release);
    return Math.max(max, envelope * (event.kind === 'main' ? 1 : 0.58));
  }, 0);
}

function nextAftershock(events, time) {
  return events.find((event) => event.kind === 'after' && time < event.start + event.duration) || null;
}

function forecastItems(events, time, armed) {
  const after = events.filter((event) => event.kind === 'after');
  return after.map((event) => {
    const active = time >= event.start && time <= event.start + event.duration;
    const arrived = time > event.start + event.duration;
    return {
      event,
      active,
      arrived,
      eta: Math.max(0, event.start - time),
      confidence: armed ? 0.86 : 0.42
    };
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pairSnapshot(live, baseline, trimRecords) {
  const a = clone(live);
  const b = clone(baseline);
  if (trimRecords) {
    a.records = [];
    b.records = [];
  }
  return { live: a, baseline: b };
}

function stepRun(run, ctx) {
  const { events, seed, mode, source, forecastArmed } = ctx;
  const time = ctx.time;
  const profile = mode === 'baseline' ? PROFILES.passive : PROFILES[ctx.objective];
  const groundAcc = groundAt(events, time, seed);
  const hazard = hazardAt(events, time);
  const forces = zeroArray(FLOORS);
  const activeDesired = zeroArray(FLOORS);
  const actualActive = zeroArray(FLOORS);
  const jam = zeroArray(FLOORS);
  const passiveCoeff = zeroArray(FLOORS);

  for (const device of run.devices) {
    const i = device.floor - 1;
    if (device.isolated) {
      passiveCoeff[i] = 0;
    } else if (device.fault) {
      passiveCoeff[i] = PASSIVE_DAMPING * 0.42;
      jam[i] = 145 * Math.sin(38 * time + device.phase);
    } else {
      passiveCoeff[i] = PASSIVE_DAMPING;
      if (mode === 'live' && profile.damping > 0) {
        const lowerV = i === 0 ? run.groundV : run.v[i - 1];
        const relV = run.v[i] - lowerV;
        const healthFactor = Math.max(0.35, device.health / 100);
        activeDesired[i] = -profile.damping * relV * healthFactor;
      }
    }
  }

  let tendonDesired = 0;
  if (mode === 'live' && profile.tendon > 0) {
    const tendonVelocity = profile.tendonMode === 'skyhook'
      ? run.v[TENDON_TOP]
      : run.v[TENDON_TOP] - run.v[TENDON_MID];
    tendonDesired = -profile.tendon * tendonVelocity;
  }

  let demand = 0;
  for (let i = 0; i < FLOORS; i += 1) {
    const lowerV = i === 0 ? run.groundV : run.v[i - 1];
    demand += Math.abs(activeDesired[i]) * Math.abs(run.v[i] - lowerV);
  }
  const tendonDemandVelocity = profile.tendonMode === 'skyhook'
    ? Math.abs(run.v[TENDON_TOP])
    : Math.abs(run.v[TENDON_TOP] - run.v[TENDON_MID]);
  demand += Math.abs(tendonDesired) * tendonDemandVelocity;
  demand = profile.damping + profile.tendon === 0 ? 0 : 4.5 + demand / 32;

  const gridCapacity = Math.max(62, 96 * (1 - 0.34 * hazard));
  const batteryCapacity = 72;
  let capacity = source === 'battery' ? batteryCapacity : gridCapacity;
  let scale = demand === 0 ? 1 : Math.min(1, capacity / demand);

  if (mode === 'baseline') {
    demand = 0;
    scale = 0;
    capacity = 100;
  } else if (source === 'battery') {
    run.battery = Math.max(0, run.battery - demand * DT * 0.42);
    if (run.battery <= 0) scale = 0;
  } else if (demand < gridCapacity) {
    const forecast = nextAftershock(events, time);
    const chargingPriority = forecastArmed && forecast && forecast.start - time < 6 ? 1.6 : 1;
    run.battery = Math.min(100, run.battery + Math.min(18, gridCapacity - demand) * DT * 0.18 * chargingPriority);
  }

  if (!forecastArmed && hazard > 0.2) scale *= 0.92;

  for (let i = 0; i < FLOORS; i += 1) {
    actualActive[i] = activeDesired[i] * scale;
    const lowerX = i === 0 ? run.groundX : run.x[i - 1];
    const lowerV = i === 0 ? run.groundV : run.v[i - 1];
    const relX = run.x[i] - lowerX;
    const relV = run.v[i] - lowerV;
    const forceOnUpper = -(STIFFNESS * relX + STRUCTURAL_DAMPING * relV)
      - passiveCoeff[i] * relV
      + actualActive[i]
      + jam[i];
    forces[i] += forceOnUpper;
    if (i > 0) forces[i - 1] -= forceOnUpper;
    run.drift[i] = relX;
    run.shear[i] = Math.abs(
      STIFFNESS * relX
      + (STRUCTURAL_DAMPING + passiveCoeff[i]) * relV
      + jam[i]
    );
  }

  const tendonForce = tendonDesired * scale;
  forces[TENDON_TOP] += tendonForce;
  forces[TENDON_MID] -= tendonForce;

  for (let i = 0; i < FLOORS; i += 1) {
    run.relAcc[i] = forces[i] / MASS - groundAcc;
    run.aAbs[i] = run.relAcc[i] + groundAcc;
    run.v[i] += run.relAcc[i] * DT;
    run.x[i] += run.v[i] * DT;
  }

  run.groundAcc = groundAcc;
  run.groundV += groundAcc * DT;
  run.groundX += run.groundV * DT;
  run.hazard = hazard;
  run.powerScale = mode === 'baseline' ? 1 : scale;
  run.powerMargin = mode === 'baseline' ? 100 : Math.max(0, Math.min(100, ((capacity - demand * scale) / capacity) * 100));
  run.activeEnergy += mode === 'baseline' ? 0 : demand * scale * DT;

  for (let i = 0; i < FLOORS; i += 1) {
    const device = run.devices[i];
    const actuatorLoad = (Math.abs(actualActive[i]) + (i === TENDON_TOP || i === TENDON_MID ? Math.abs(tendonForce) : 0)) / 1000;
    const mechanicalLoad = Math.abs(passiveCoeff[i] * (run.v[i] - (i === 0 ? run.groundV : run.v[i - 1]))) / 1000;
    device.heat = Math.max(0, device.heat + (actuatorLoad * 0.24 + mechanicalLoad * 0.018 - device.heat * 0.08) * DT);
    if (device.fault) device.health = Math.min(device.health, 48);
    else device.health = Math.max(0, 100 - device.heat * 0.18);
  }

  const roofDisp = Math.abs(run.x[FLOORS - 1] - run.groundX);
  const roofAcc = Math.abs(run.aAbs[FLOORS - 1]);
  const maxDrift = Math.max(...run.drift.map(Math.abs));
  const midDrift = Math.max(...MID_FLOORS.map((floor) => Math.abs(run.drift[floor - 1])));
  const midShear = Math.max(...MID_FLOORS.map((floor) => run.shear[floor - 1]));
  run.peaks.roofDisp = Math.max(run.peaks.roofDisp, roofDisp);
  run.peaks.roofAcc = Math.max(run.peaks.roofAcc, roofAcc);
  run.peaks.maxDrift = Math.max(run.peaks.maxDrift, maxDrift);
  run.peaks.midDrift = Math.max(run.peaks.midDrift, midDrift);
  run.peaks.midShear = Math.max(run.peaks.midShear, midShear);
  run.peaks.baseShear = Math.max(run.peaks.baseShear, run.shear[0]);
  run.records.push({
    t: time + DT,
    roof: run.x[FLOORS - 1] - run.groundX,
    roofAcc: run.aAbs[FLOORS - 1],
    drift: maxDrift,
    mid: midShear,
    base: run.shear[0],
    margin: run.powerMargin
  });
}

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 2) => Number(value).toFixed(digits);
const pct = (value, digits = 1) => `${value >= 0 ? '+' : ''}${fmt(value, digits)}%`;
const floorName = (floor) => `${floor}层`;

let state;
let timer = null;

function makeLog(kind, text, simTime) {
  return { kind, text, t: simTime === undefined ? (state ? state.step * DT : 0) : simTime };
}

function pushLog(kind, text, simTime) {
  state.logs.unshift(makeLog(kind, text, simTime));
  state.logs = state.logs.slice(0, 120);
}

function makeBranch(label, kind = 'manual') {
  state.branchCounter += 1;
  return {
    id: `branch-${state.branchCounter}`,
    label,
    kind,
    step: state.step,
    time: state.step * DT,
    snapshot: pairSnapshot(state.live, state.baseline, true),
    events: clone(state.events),
    settings: {
      objective: state.objective,
      source: state.source,
      forecastArmed: state.forecastArmed,
      autoPower: state.autoPower
    }
  };
}

function addBranch(branch, silent = false) {
  state.branches.push(branch);
  state.currentBranch = branch.id;
  if (!silent) pushLog('event', `建立关键节点：${branch.label}`, branch.time);
}

function restoreBranch(branch) {
  state.live = clone(branch.snapshot.live);
  state.baseline = clone(branch.snapshot.baseline);
  state.events = clone(branch.events);
  state.step = branch.step;
  state.objective = branch.settings.objective;
  state.source = branch.settings.source;
  state.forecastArmed = branch.settings.forecastArmed;
  state.autoPower = branch.settings.autoPower;
  state.currentBranch = branch.id;
}

function recordAction(type, payload, before) {
  state.actions.push({
    id: `action-${state.actions.length + 1}`,
    type,
    payload,
    atStep: state.step,
    before
  });
}

function guard(message) {
  $('guardMessage').className = 'risk-card bad';
  $('guardMessage').textContent = `操作已回滚：${message}`;
  pushLog('rollback', `操作失败并回滚：${message}`);
  persist();
  render();
}

function success(message) {
  $('guardMessage').className = 'risk-card good';
  $('guardMessage').textContent = message;
  pushLog('user', message);
}

function transaction(label, validate, apply, payload = {}, type = 'custom') {
  const before = pairSnapshot(state.live, state.baseline, true);
  const eventsBefore = clone(state.events);
  const settingsBefore = {
    objective: state.objective,
    source: state.source,
    forecastArmed: state.forecastArmed,
    autoPower: state.autoPower
  };
  const error = validate();
  if (error) {
    guard(error);
    return false;
  }
  apply();
  state.actions.push({
    id: `action-${state.actions.length + 1}`,
    type,
    payload,
    atStep: state.step,
    before,
    eventsBefore,
    settingsBefore,
    label
  });
  success(label);
  persist();
  render();
  return true;
}

function bothDevices() {
  return state.live.devices.map((device, index) => [device, state.baseline.devices[index]]);
}

function setDeviceIsolation(floor, isolated) {
  for (const [liveDevice, baselineDevice] of bothDevices()) {
    if (liveDevice.floor === floor) {
      liveDevice.isolated = isolated;
      baselineDevice.isolated = isolated;
    }
  }
}

function validateIsolation() {
  const floor = Number($('deviceFloorSelect').value);
  const device = state.live.devices[floor - 1];
  if (device.isolated) return `${floorName(floor)}装置已处于隔离状态。`;
  if (!device.fault && device.health > 70) return `${floorName(floor)}装置健康，隔离会过早损失减振冗余。`;
  const healthyRemaining = state.live.devices.filter((item) => !item.isolated && item.floor !== floor).length;
  if (healthyRemaining < 8) return '隔离后可用装置少于 8 个，不满足最低控制冗余。';
  return null;
}

function validateRestore() {
  const floor = Number($('deviceFloorSelect').value);
  const device = state.live.devices[floor - 1];
  if (!device.isolated) return `${floorName(floor)}装置未隔离。`;
  return null;
}

function validateObjective() {
  const objective = $('objectiveSelect').value;
  if (objective === 'roof' && state.source === 'battery' && state.live.battery < 20) {
    return '电池储量低于 20%，压顶策略的高功率主动 tendon 无法保证持续出力。';
  }
  if (objective !== 'passive' && state.source === 'battery' && state.live.battery < 5) {
    return '电池已耗尽，请先切回市电。';
  }
  return null;
}

function validateSource() {
  const source = state.source === 'grid' ? 'battery' : 'grid';
  if (source === 'battery' && state.live.battery < 8) {
    return '电池储量低于 8%，切换备用供电可能在余震中中断。';
  }
  return null;
}

function changeObjective() {
  const objective = $('objectiveSelect').value;
  transaction(
    `控制目标切换为「${PROFILES[objective].label}」`,
    validateObjective,
    () => { state.objective = objective; },
    { objective },
    'objective'
  );
}

function isolateDevice() {
  const floor = Number($('deviceFloorSelect').value);
  transaction(
    `隔离${floorName(floor)}故障装置`,
    validateIsolation,
    () => setDeviceIsolation(floor, true),
    { floor, isolated: true },
    'isolate'
  );
}

function restoreDevice() {
  const floor = Number($('deviceFloorSelect').value);
  transaction(
    `恢复${floorName(floor)}装置接入`,
    validateRestore,
    () => setDeviceIsolation(floor, false),
    { floor, isolated: false },
    'restore'
  );
}

function togglePower() {
  transaction(
    `供电切换为「${state.source === 'grid' ? '备用电池' : '市电'}」`,
    validateSource,
    () => { state.source = state.source === 'grid' ? 'battery' : 'grid'; },
    { source: state.source },
    'power'
  );
}

function rollbackLastAction() {
  const action = [...state.actions].reverse().find((item) => item.before || item.type === 'branch');
  if (!action) {
    guard('没有可回滚的用户操作。');
    return;
  }
  if (action.type !== 'branch') {
    state.live = clone(action.before.live);
    state.baseline = clone(action.before.baseline);
    if (action.eventsBefore) state.events = clone(action.eventsBefore);
    if (action.settingsBefore) Object.assign(state, action.settingsBefore);
    state.step = action.atStep;
  }
  state.actions = state.actions.filter((item) => item.id !== action.id);
  if (action.type === 'branch') {
    state.branches = state.branches.filter((branch) => branch.id !== action.payload.branchId);
    const previous = [...state.branches].reverse().find((branch) => branch.step <= action.atStep);
    if (previous) state.currentBranch = previous.id;
  }
  if (action.type === 'checkout') {
    state.branches = state.branches.filter((branch) => branch.kind !== 'checkpoint' || branch.step !== action.atStep);
  }
  pushLog('rollback', `回滚操作：${action.label}，回到 ${fmt(action.atStep * DT)}s`, action.atStep * DT);
  $('guardMessage').className = 'risk-card good';
  $('guardMessage').textContent = `已回滚：${action.label}`;
  persist();
  render();
}

function checkoutBranch(branchId) {
  const target = state.branches.find((branch) => branch.id === branchId);
  if (!target || target.id === state.currentBranch) return;
  const safety = makeBranch(`切换到「${target.label}」前的节点`, 'checkpoint');
  state.branches.push(safety);
  restoreBranch(target);
  state.actions.push({
    id: `action-${state.actions.length + 1}`,
    type: 'checkout',
    payload: { branchId: target.id },
    atStep: safety.step,
    before: clone(safety.snapshot),
    eventsBefore: clone(safety.events),
    settingsBefore: { ...safety.settings },
    label: `切换关键节点：${target.label}`
  });
  pushLog('event', `切换到关键节点：${target.label}`);
  $('guardMessage').className = 'risk-card good';
  $('guardMessage').textContent = `已进入关键节点：${target.label}`;
  persist();
  render();
}

function createManualBranch() {
  const branch = makeBranch(`手动节点 @${fmt(state.step * DT)}s`, 'manual');
  addBranch(branch);
  state.actions.push({
    id: `action-${state.actions.length + 1}`,
    type: 'branch',
    payload: { branchId: branch.id },
    atStep: state.step,
    label: branch.label
  });
  persist();
  render();
}

function triggerEvent(event) {
  if (event.kind === 'fault' && event.targetFloor) {
    for (const [liveDevice, baselineDevice] of bothDevices()) {
      if (liveDevice.floor === event.targetFloor && !liveDevice.isolated) {
        liveDevice.fault = true;
        liveDevice.health = 48;
        baselineDevice.fault = true;
        baselineDevice.health = 48;
      }
    }
  }
  event.fired = true;
  const label = event.kind === 'fault' ? `关键节点：${event.label}` : `关键节点：${event.label}开始`;
  const branch = makeBranch(label, 'event');
  branch.step = state.step;
  branch.time = state.step * DT;
  addBranch(branch, true);
  pushLog('event', event.kind === 'fault' ? `${event.label}，被动阻尼退化并出现周期性卡滞力` : `${event.label}开始`, state.step * DT);
}

function automaticPowerSwitch() {
  if (!state.autoPower || state.objective === 'passive') return;
  const forecasts = forecastItems(state.events, state.step * DT, state.forecastArmed);
  const imminent = forecasts.some((item) => !item.arrived && item.eta < 2.4 && item.confidence >= 0.75);
  if (imminent && state.source === 'grid' && state.live.hazard < 0.35) {
    state.source = 'battery';
    pushLog('event', '余震预测触发自动供电：切换到备用电池');
  }
  if (state.source === 'battery' && state.live.battery < 16 && state.live.hazard < 0.15) {
    state.source = 'grid';
    pushLog('event', '低储量自动保护：切回市电并为电池充电');
  }
}

function advance() {
  const events = state.events;
  for (const event of events) {
    if (!event.fired && state.step * DT >= event.start) triggerEvent(event);
  }
  automaticPowerSwitch();

  for (let sub = 0; sub < UI_STEP; sub += 1) {
    const time = (state.step + sub) * DT;
    stepRun(state.live, {
      events,
      seed: state.seed,
      time,
      objective: state.objective,
      source: state.source,
      forecastArmed: state.forecastArmed,
      mode: 'live'
    });
    stepRun(state.baseline, {
      events,
      seed: state.seed,
      time,
      objective: 'passive',
      source: 'grid',
      forecastArmed: false,
      mode: 'baseline'
    });
  }
  state.step += UI_STEP;

  for (const event of events) {
    if (event.kind !== 'fault' && event.fired && !event.announcedEnd && state.step * DT >= event.start + event.duration) {
      event.announcedEnd = true;
      pushLog('event', `${event.label}结束`, state.step * DT);
    }
  }

  persist();
  render();
}

function defaultScenario(seed) {
  const order = ['main', 'fault', 'after'];
  return {
    seed,
    order,
    events: buildEvents(seed, order),
    step: 0,
    objective: 'balanced',
    source: 'grid',
    forecastArmed: true,
    autoPower: false,
    live: freshRun(seed, false),
    baseline: freshRun(seed, true),
    branches: [],
    currentBranch: 'branch-1',
    branchCounter: 1,
    actions: [],
    logs: [makeLog('event', '确定性模型已初始化：所有主震、余震与故障均由种子参数复现', 0)]
  };
}

function resetScenario(initial = false) {
  stopPlayback();
  const seed = $('seedInput').value.trim() || 'GSB-20260922';
  state = defaultScenario(seed);
  const branch = makeBranch('初始关键节点', 'initial');
  state.branches = [branch];
  state.currentBranch = branch.id;
  if (!initial) pushLog('user', '重置并按当前种子重新生成时间线');
  persist();
  renderScenarioControls();
  render();
}

function rebuildScenario() {
  stopPlayback();
  const order = state.draftOrder || ['main', 'fault', 'after'];
  const seed = $('seedInput').value.trim() || state.seed;
  state = defaultScenario(seed);
  state.order = order;
  state.events = buildEvents(seed, order);
  const branch = makeBranch('场景重建关键节点', 'initial');
  state.branches = [branch];
  state.currentBranch = branch.id;
  pushLog('user', `按新顺序重建：${order.map((kind) => EVENT_META[kind].short).join(' → ')}`);
  persist();
  renderScenarioControls();
  render();
}

function moveDraftEvent(index, delta) {
  if (!state.draftOrder) state.draftOrder = state.order.slice();
  const target = index + delta;
  if (target < 0 || target >= state.draftOrder.length) return;
  const [item] = state.draftOrder.splice(index, 1);
  state.draftOrder.splice(target, 0, item);
  renderScenarioControls();
}

function persist() {
  try {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      state
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('无法写入本地推演状态', error);
  }
}

function loadPersisted() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const payload = JSON.parse(raw);
    if (!payload || payload.version !== 1 || !payload.state) return false;
    state = payload.state;
    state.draftOrder = null;
    return true;
  } catch (error) {
    return false;
  }
}

function exportRun() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    state,
    note: '导出文件包含确定性种子、事件、分支、操作和当前物理状态。'
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `quake-control-${state.seed}-step-${state.step}.json`;
  link.click();
  URL.revokeObjectURL(url);
  success('已导出可复现的推演文件');
}

function importRun(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      if (!payload.state || payload.version !== 1) throw new Error('版本不匹配');
      stopPlayback();
      state = payload.state;
      state.draftOrder = null;
      persist();
      pushLog('user', '导入推演文件并恢复状态');
      renderScenarioControls();
      render();
    } catch (error) {
      guard(`导入失败：${error.message}`);
    }
  };
  reader.readAsText(file);
}

function startPlayback() {
  if (timer) return;
  $('playBtn').textContent = '⏸ 暂停';
  $('runState').textContent = '运行';
  timer = window.setInterval(() => {
    const totalEnd = Math.max(...state.events.map((event) => event.start + event.duration));
    if (state.step * DT > totalEnd + 5) {
      stopPlayback();
      return;
    }
    advance();
  }, 40);
}

function stopPlayback() {
  if (timer) window.clearInterval(timer);
  timer = null;
  const button = $('playBtn');
  if (button) button.textContent = '▶ 播放';
  const runState = $('runState');
  if (runState) runState.textContent = '暂停';
}

function togglePlayback() {
  if (timer) stopPlayback();
  else startPlayback();
}

function scaleCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(220, rect.height);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}


function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function heatColor(value) {
  const x = Math.max(0, Math.min(1, value));
  const hue = 160 - x * 160;
  const alpha = 0.16 + x * 0.58;
  return `hsla(${hue}, 88%, 60%, ${alpha})`;
}

function drawBuilding() {
  const canvas = $('buildingCanvas');
  const { ctx, width, height } = scaleCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  const groundY = height - 62;
  const floorH = Math.min(34, (groundY - 48) / FLOORS);
  const buildingW = Math.min(178, width * 0.26);
  const centerX = width * 0.43;
  const maxShift = buildingW * 0.23;
  const waveAmp = 4 + 18 * Math.min(1, Math.abs(state.live.groundAcc) / 4);

  ctx.save();
  ctx.strokeStyle = 'rgba(145,164,191,.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(26, groundY);
  ctx.lineTo(width - 26, groundY);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(66,211,255,.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 8) {
    const y = groundY + 20 + Math.sin(x * 0.07 - state.step * 0.45) * waveAmp * 0.22;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  for (let renderIndex = 0; renderIndex < FLOORS; renderIndex += 1) {
    const i = FLOORS - 1 - renderIndex;
    const y = groundY - 24 - renderIndex * floorH;
    const baselineShift = state.baseline.x[i] * maxShift / DRIFT_LIMIT;
    const shift = state.live.x[i] * maxShift / DRIFT_LIMIT;
    const drift = Math.abs(state.live.drift[i]) / DRIFT_LIMIT;
    const device = state.live.devices[i];

    ctx.strokeStyle = 'rgba(255,95,122,.28)';
    ctx.setLineDash([4, 5]);
    ctx.strokeRect(centerX - buildingW / 2 + baselineShift, y, buildingW, floorH - 5);
    ctx.setLineDash([]);

    ctx.fillStyle = heatColor(drift);
    ctx.strokeStyle = drift > 0.8 ? 'rgba(255,95,122,.85)' : 'rgba(145,164,191,.45)';
    ctx.lineWidth = drift > 0.8 ? 2 : 1;
    roundedRect(ctx, centerX - buildingW / 2 + shift, y, buildingW, floorH - 5, 7);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#eef5ff';
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.fillText(`${i + 1}F`, centerX - buildingW / 2 + 9, y + 17);

    ctx.fillStyle = 'rgba(238,245,255,.78)';
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.fillText(`${(Math.abs(state.live.drift[i]) * 1000).toFixed(1)} mm`, centerX + buildingW / 2 - 55, y + 17);

    const color = device.isolated ? '#ff5f7a' : device.fault ? '#ffc857' : '#35e6a2';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(centerX + buildingW / 2 - 16 + shift, y + (floorH - 5) / 2, device.isolated ? 5.2 : 4.2, 0, Math.PI * 2);
    ctx.fill();
  }

  const topY = groundY - 24 - (FLOORS - 1) * floorH + (floorH - 5) / 2;
  const midY = groundY - 24 - (TENDON_MID - 1) * floorH + (floorH - 5) / 2;
  const topShift = state.live.x[TENDON_TOP] * maxShift / DRIFT_LIMIT;
  const midShift = state.live.x[TENDON_MID] * maxShift / DRIFT_LIMIT;
  const tendonColor = state.objective === 'passive' ? 'rgba(145,164,191,.24)' : 'rgba(139,124,255,.72)';
  ctx.strokeStyle = tendonColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  ctx.moveTo(centerX - buildingW / 2 - 22 + midShift, midY);
  ctx.lineTo(centerX - buildingW / 2 - 22 + topShift, topY);
  ctx.moveTo(centerX + buildingW / 2 + 22 + midShift, midY);
  ctx.lineTo(centerX + buildingW / 2 + 22 + topShift, topY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(238,245,255,.75)';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillText('主动 tendon：顶部 ↔ 5层耦合', centerX - 86, 28);

  const hazardText = state.live.hazard > 0.08
    ? `地面加速度 ${state.live.groundAcc.toFixed(2)} m/s²`
    : '等待地震输入';
  ctx.fillStyle = '#91a4bf';
  ctx.fillText(hazardText, 26, height - 24);
  ctx.restore();
}

function delta(value, base) {
  if (!base || Math.abs(base) < 0.0001) return 0;
  return (value / base - 1) * 100;
}

function metricCard(label, value, change, unit, lowerBetter = true, hint = '') {
  const good = change <= 0;
  const visible = Math.abs(change) > 0.05;
  const cls = visible ? (good === lowerBetter ? 'better' : 'worse') : '';
  const changeText = visible ? pct(change) : '≈ 0%';
  return `<div class="metric-card">
    <span>${label}</span><strong>${value} ${unit}</strong>
    <em class="${cls}">相对被动基线 ${changeText}</em>${hint ? `<em> · ${hint}</em>` : ''}
  </div>`;
}

function drawChart() {
  const canvas = $('metricChart');
  const { ctx, width, height } = scaleCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const margin = { left: 44, right: 14, top: 26, bottom: 28 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const live = state.live.records.slice(-260);
  const baseline = state.baseline.records.slice(-260);
  if (live.length < 2) {
    ctx.fillStyle = '#91a4bf';
    ctx.font = '13px ui-sans-serif, system-ui';
    ctx.fillText('执行单步或播放后显示动态曲线', margin.left, height / 2);
    return;
  }

  ctx.strokeStyle = 'rgba(145,164,191,.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = margin.top + plotH * i / 4;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(width - margin.right, y);
    ctx.stroke();
  }

  function plot(records, key, scale, color, dashed = false, offset = 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dashed ? [5, 5] : []);
    ctx.beginPath();
    records.forEach((record, index) => {
      const x = margin.left + plotW * index / 259 + offset;
      const y = margin.top + plotH * (1 - Math.max(0, Math.min(1, record[key] / scale)));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  plot(baseline, 'roof', 0.24, 'rgba(255,95,122,.55)', true, -1);
  plot(live, 'roof', 0.24, '#42d3ff');
  plot(live, 'mid', 9000, '#8b7cff');
  plot(live, 'base', 22000, '#35e6a2');

  ctx.fillStyle = '#91a4bf';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillText('0', 18, margin.top + plotH);
  ctx.fillText('归一化幅值', 12, margin.top - 8);
  const t0 = live[0].t;
  const t1 = live[live.length - 1].t;
  ctx.fillText(`${t0.toFixed(1)}s`, margin.left, height - 8);
  ctx.fillText(`${t1.toFixed(1)}s`, width - 54, height - 8);

  const legends = [
    ['#42d3ff', '当前顶层位移'],
    ['rgba(255,95,122,.7)', '被动基线'],
    ['#8b7cff', '中层剪力'],
    ['#35e6a2', '基底剪力']
  ];
  legends.forEach(([color, label], index) => {
    const x = margin.left + index * 118;
    ctx.fillStyle = color;
    ctx.fillRect(x, 8, 18, 3);
    ctx.fillStyle = '#91a4bf';
    ctx.fillText(label, x + 24, 13);
  });
}

function renderMetrics() {
  const live = state.live.peaks;
  const base = state.baseline.peaks;
  const roofDelta = delta(live.roofDisp, base.roofDisp);
  const accDelta = delta(live.roofAcc, base.roofAcc);
  const driftDelta = delta(live.maxDrift, base.maxDrift);
  const midDelta = delta(live.midShear, base.midShear);

  $('roofDisp').textContent = `${(Math.abs(state.live.x[FLOORS - 1] - state.live.groundX) * 1000).toFixed(0)} mm`;
  $('roofAcc').textContent = `${Math.abs(state.live.aAbs[FLOORS - 1]).toFixed(2)} m/s²`;
  $('baseShear').textContent = `${(state.live.shear[0] / 1000).toFixed(1)} MN`;
  const midCostEl = $('midCost');
  midCostEl.textContent = midDelta > 0.5 ? `+${midDelta.toFixed(1)}%` : `${midDelta.toFixed(1)}%`;
  midCostEl.style.color = midDelta > 5 ? '#ff5f7a' : midDelta < -5 ? '#35e6a2' : '#eef5ff';

  $('tradeoffCards').innerHTML = [
    metricCard('顶部峰值位移', (live.roofDisp * 1000).toFixed(1), roofDelta, 'mm', true, '目标收益'),
    metricCard('顶部峰值加速度', live.roofAcc.toFixed(2), accDelta, 'm/s²', true, '舒适度'),
    metricCard('最大层间位移', (live.maxDrift * 1000).toFixed(1), driftDelta, 'mm', true),
    metricCard('中层峰值剪力', (live.midShear / 1000).toFixed(2), midDelta, 'MN', true, '可能代价')
  ].join('');
}

function renderPowerForecast() {
  const battery = state.live.battery;
  const margin = state.live.powerMargin;
  $('powerPct').textContent = `${margin.toFixed(0)}%`;
  $('batteryPct').textContent = `${battery.toFixed(0)}%`;
  $('powerBar').style.width = `${margin}%`;
  $('batteryBar').style.width = `${battery}%`;
  $('gridBtn').classList.toggle('active', state.source === 'grid');
  $('batteryBtn').classList.toggle('active', state.source === 'battery');
  $('gridBtn').textContent = state.source === 'grid' ? '市电（当前）' : '市电';
  $('batteryBtn').textContent = state.source === 'battery' ? '备用电池（当前）' : '备用电池';

  const items = forecastItems(state.events, state.step * DT, state.forecastArmed);
  $('forecastList').innerHTML = items.map((item) => {
    const stateText = item.arrived ? '已完成' : item.active ? '正在到达' : `${item.eta.toFixed(1)}s 后`;
    const confidence = state.forecastArmed ? `${(item.confidence * 100).toFixed(0)}% 置信` : '预测未接入调度';
    return `<div class="forecast-item">
      <div class="quake-badge">余</div>
      <div><b>${item.event.label}</b><small>${confidence} · ${item.event.duration}s 持续</small></div>
      <small>${stateText}</small>
    </div>`;
  }).join('') || '<div class="forecast-item"><div class="quake-badge">—</div><div><b>当前场景无余震</b><small>可在事件编排中加入余震</small></div></div>';
}

function renderControls() {
  $('objectiveSelect').value = state.objective;
  $('forecastArm').checked = state.forecastArmed;
  $('autoPower').checked = state.autoPower;
  const select = $('deviceFloorSelect');
  if (!select.options.length) {
    for (let floor = 1; floor <= FLOORS; floor += 1) {
      const option = document.createElement('option');
      option.value = String(floor);
      option.textContent = `${floor}层阻尼装置`;
      select.appendChild(option);
    }
  }
  for (let floor = 1; floor <= FLOORS; floor += 1) {
    const device = state.live.devices[floor - 1];
    const suffix = device.isolated ? ' · 已隔离' : device.fault ? ` · 故障 ${device.health.toFixed(0)}%` : ` · 健康 ${device.health.toFixed(0)}%`;
    select.options[floor - 1].textContent = `${floor}层阻尼装置${suffix}`;
  }
}

function renderBranches() {
  $('branchList').innerHTML = state.branches.slice(-8).reverse().map((branch) => {
    const active = branch.id === state.currentBranch ? 'active' : '';
    return `<div class="branch-item ${active}">
      <span>${branch.label}<br><small>${fmt(branch.time)}s</small></span>
      <button data-branch="${branch.id}" ${active ? 'disabled' : ''}>进入</button>
    </div>`;
  }).join('');
}

function renderLogs() {
  $('logList').innerHTML = state.logs.slice(0, 80).map((log) => (
    `<li class="${log.kind}"><time>${fmt(log.t)}s</time>${log.text}</li>`
  )).join('');
}

function renderScenarioControls() {
  const order = state.draftOrder || state.order;
  $('eventSequence').innerHTML = order.map((kind, index) => {
    const event = state.events.find((item) => item.kind === kind && state.events.filter((e) => e.kind === kind).indexOf(item) === order.slice(0, index + 1).filter((x) => x === kind).length - 1)
      || state.events.find((item) => item.kind === kind);
    const status = !event ? '' : state.step * DT < event.start ? '' : event.fired && state.step * DT < event.start + event.duration ? 'active' : 'done';
    return `<li class="event-row ${kind} ${status}">
      <div class="event-type">${EVENT_META[kind].icon}</div>
      <div><strong>${EVENT_META[kind].title}</strong><small>${event ? `${event.start.toFixed(1)}s 开始` : ''} · 位置 ${index + 1}</small></div>
      <div class="move-buttons">
        <button data-move="${index}" data-delta="-1" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button data-move="${index}" data-delta="1" ${index === order.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </li>`;
  }).join('');
}

function render() {
  $('simTime').textContent = `${fmt(state.step * DT)} s`;
  drawBuilding();
  drawChart();
  renderMetrics();
  renderPowerForecast();
  renderControls();
  renderBranches();
  renderLogs();
  renderScenarioControls();
}

function bindEvents() {
  $('playBtn').addEventListener('click', togglePlayback);
  $('stepBtn').addEventListener('click', advance);
  $('resetBtn').addEventListener('click', () => resetScenario(false));
  $('objectiveSelect').addEventListener('change', changeObjective);
  $('isolateBtn').addEventListener('click', isolateDevice);
  $('restoreBtn').addEventListener('click', restoreDevice);
  $('gridBtn').addEventListener('click', () => { if (state.source !== 'grid') togglePower(); });
  $('batteryBtn').addEventListener('click', () => { if (state.source !== 'battery') togglePower(); });
  $('forecastArm').addEventListener('change', () => {
    state.forecastArmed = $('forecastArm').checked;
    pushLog('user', `余震预测调度：${state.forecastArmed ? '接入' : '断开'}`);
    persist();
    render();
  });
  $('autoPower').addEventListener('change', () => {
    state.autoPower = $('autoPower').checked;
    pushLog('user', `风险自动供电：${state.autoPower ? '启用' : '关闭'}`);
    persist();
    render();
  });
  $('branchBtn').addEventListener('click', createManualBranch);
  $('rollbackBtn').addEventListener('click', rollbackLastAction);
  $('applyScenarioBtn').addEventListener('click', rebuildScenario);
  $('exportBtn').addEventListener('click', exportRun);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) importRun(file);
    event.target.value = '';
  });
  $('clearLogBtn').addEventListener('click', () => {
    state.logs = [];
    persist();
    render();
  });
  $('eventSequence').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-move]');
    if (!button) return;
    moveDraftEvent(Number(button.dataset.move), Number(button.dataset.delta));
  });
  $('branchList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-branch]');
    if (button) checkoutBranch(button.dataset.branch);
  });
  window.addEventListener('resize', render);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPlayback();
  });
}

function init() {
  const restored = loadPersisted();
  if (!restored) {
    const seed = $('seedInput').value.trim() || 'GSB-20260922';
    state = defaultScenario(seed);
    state.branches = [makeBranch('初始关键节点', 'initial')];
    state.currentBranch = state.branches[0].id;
    persist();
  } else {
    $('seedInput').value = state.seed;
    pushLog('event', '已从浏览器本地状态确定性恢复上次推演');
  }
  bindEvents();
  render();
}

if (typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', init);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FLOORS,
    DT,
    buildEvents,
    defaultScenario,
    freshRun,
    stepRun,
    groundAt,
    hashSeed
  };
}
