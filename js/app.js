import { Engine, STATE, detectTarget, deviationPct, deviationCents } from './engine.js';
import { MotionSource, SimSource, CompassSource, Wakelock,
         requestMotionPermission, requestOrientationPermission,
         motionSupported, needsPermission, isSecure } from './sensors.js';
import { drawChart, drawPolar, devColour, fmtClock } from './charts.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIM = params.has('sim');
const BUILD = '__BUILD__';   // stamped at deploy time

let settings = store.loadSettings();
let cal = store.loadCalibration();

const targets = () => ([
  { id: '16', label: '16⅔', value: Number(settings.ref16) },
  { id: '33', label: '33⅓', value: 100 / 3 },
  { id: '45', label: '45', value: 45 },
  { id: '78', label: '78', value: Number(settings.ref78) },
]);

let manualTarget = null;          // null = auto-detect
let running = false;
let lastStats = null;
let displayRpm = 0;
let savedThisRun = false;

const engine = new Engine({
  settleSec: settings.settleSec,
  smoothN: settings.smoothN,
  scale: cal.scale,
});
const source = SIM
  ? new SimSource({
      rpm: Number(params.get('sim')) || 33.31,
      wow: Number(params.get('wow') ?? 0.25),
      noise: Number(params.get('noise') ?? 0.6),
    })
  : new MotionSource();
const wake = new Wakelock();

// ---------------------------------------------------------------- start / stop
async function start() {
  if (running) return stop();

  const perm = SIM ? 'granted' : await requestMotionPermission();
  if (perm !== 'granted') return permissionProblem(perm);

  savedThisRun = false;
  $('btnSave').disabled = true;
  engine.settleMs = settings.settleSec * 1000;
  engine.smoothN = settings.smoothN;
  engine.scale = cal.scale;
  engine.arm();
  source.start(onSample);
  running = true;
  $('btnStart').textContent = 'Stop';
  $('btnStart').classList.add('is-stop');
  if (settings.wakeLock) wake.on();
  setStatus('Waiting for the platter to turn…');
}

function stop(message) {
  running = false;
  source.stop();
  engine.freeze();
  engine.computeStats();
  wake.off();
  $('btnStart').textContent = 'Start';
  $('btnStart').classList.remove('is-stop');
  $('btnSave').disabled = !(engine.stats && engine.stats.samples > 30);
  setStatus(message || (engine.stats ? 'Stopped. Reading held.' : 'Stopped.'));
}

function permissionProblem(kind) {
  if (kind === 'insecure') {
    setStatus('Motion sensors need a secure (https) connection.');
  } else if (kind === 'unsupported') {
    setStatus('This browser exposes no gyroscope. On iPhone, use Safari.');
  } else {
    setStatus('Motion access was declined. Settings ▸ Apps ▸ Safari ▸ Motion & Orientation Access, then reload.');
  }
  toast('No sensor access');
}

function onSample(v, now) {
  const r = engine.push(v, now);
  if (r && r.done) zeroFinished(r);
}

// ---------------------------------------------------------------- zeroing
async function zero() {
  const perm = SIM ? 'granted' : await requestMotionPermission();
  if (perm !== 'granted') return permissionProblem(perm);
  const wasRunning = running;
  if (!wasRunning) source.start(onSample);
  engine._zeroTemp = !wasRunning;
  engine.beginZero();
  setStatus('Hold still — zeroing the gyroscope…');
  $('btnZero').disabled = true;
}

function zeroFinished(r) {
  $('btnZero').disabled = false;
  if (engine._zeroTemp) source.stop();
  engine._zeroTemp = false;
  const drift = Math.hypot(...r.bias);
  toast(`Zeroed · drift ${drift.toFixed(2)}°/s`);
  setStatus(`Sensor zeroed. Noise floor ${(r.noiseFloorRpm).toFixed(3)} RPM.`);
  updateSensorInfo();
}

// ---------------------------------------------------------------- saving
function save() {
  const s = engine.stats;
  if (!s) return;
  const t = currentTarget(s.avgRpm);
  store.addRun({
    id: `${Date.now()}`,
    at: Date.now(),
    target: t ? t.value : null,
    targetLabel: t ? t.label : '—',
    avgRpm: s.avgRpm,
    devPct: t ? deviationPct(s.avgRpm, t.value) : null,
    devCents: t ? deviationCents(s.avgRpm, t.value) : null,
    wfPeakPct: s.wfPeakPct,
    wfRmsPct: s.wfRmsPct,
    harmonicPct: s.harmonicPct,
    minRpm: s.minRpm,
    maxRpm: s.maxRpm,
    revolutions: s.revolutions,
    duration: s.duration,
    samples: s.samples,
    scale: engine.scale,
  });
  savedThisRun = true;
  $('btnSave').disabled = true;
  toast('Saved to history');
}

// ---------------------------------------------------------------- targets
function currentTarget(rpm) {
  if (manualTarget) return targets().find((t) => t.id === manualTarget) || null;
  if (!rpm) return null;
  return detectTarget(rpm, targets());
}

function buildTargets() {
  const el = $('targets');
  el.innerHTML = '';
  const all = [{ id: null, label: 'Auto' }, ...targets()];
  for (const t of all) {
    const b = document.createElement('button');
    b.className = 'chip' + (manualTarget === t.id ? ' is-on' : '');
    b.textContent = t.label;
    b.dataset.id = t.id ?? '';
    b.onclick = () => { manualTarget = t.id; buildTargets(); };
    el.appendChild(b);
  }
}

// ---------------------------------------------------------------- render loop
let frame = 0;
function render() {
  requestAnimationFrame(render);
  frame++;

  const st = engine.state;
  const live = engine.liveRpm;
  displayRpm += (live - displayRpm) * 0.18;           // a little damping, purely cosmetic

  if (frame % 15 === 0 && st === STATE.MEASURING) engine.computeStats();

  if (running && st === STATE.MEASURING && settings.autoStopSec > 0
      && engine.elapsed >= settings.autoStopSec) {
    stop(`Run complete — stopped automatically after ${fmtClock(settings.autoStopSec)}.`);
    toast('Run complete');
  }
  const s = engine.stats;
  lastStats = s;

  const shown = (st === STATE.FROZEN && s) ? s.avgRpm : (Math.abs(displayRpm) > 0.4 ? Math.abs(displayRpm) : 0);
  const target = currentTarget(s ? s.avgRpm : Math.abs(displayRpm));
  const headline = s ? s.avgRpm : Math.abs(displayRpm);

  $('rpmValue').textContent = shown ? shown.toFixed(2) : '--.--';

  const dev = target && headline ? deviationPct(headline, target.value) : null;
  const cls = dev === null ? '' : (Math.abs(dev) <= settings.thresholdPct ? 'is-good'
              : Math.abs(dev) <= settings.thresholdPct * 2.5 ? 'is-warn' : 'is-bad');
  $('rpmValue').className = 'rpm-value ' + cls;
  $('devPct').textContent = dev === null ? '--' : `${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%`;
  $('devCents').textContent = dev === null ? '— cents'
    : `${fmtSigned(deviationCents(headline, target.value), 1)} cents`;

  // meter needle
  const needle = $('meterNeedle');
  const frac = dev === null ? 0 : Math.max(-1, Math.min(1, dev / settings.scalePct));
  needle.style.left = `${50 + frac * 50}%`;
  needle.style.background = dev === null ? '#8d9aa7' : devColour(dev, settings.thresholdPct);

  // highlight the auto-detected chip
  for (const c of document.querySelectorAll('.chip')) {
    c.classList.toggle('is-auto-hit', !manualTarget && !!target && c.dataset.id === target.id);
  }

  // counter-rotation keeps the readout upright while the phone spins with the platter
  const wrap = $('spinWrap');
  const spinning = settings.counterRotate && (st === STATE.MEASURING || st === STATE.SETTLING)
    && Math.abs(engine.liveRpm) > 1;
  $('readout').classList.toggle('is-spinning', spinning);
  if (spinning) {
    const zDeg = engine.angleDeg * engine.axis[0];
    wrap.style.transform = `rotate(${zDeg.toFixed(1)}deg) scale(.74)`;
  } else if (wrap.style.transform) {
    wrap.style.transform = '';
  }

  if (frame % 6 === 0) { updateStats(s, target); paint(s); }
  if (frame % 30 === 0) updateStatusFromState(st);
}

function updateStats(s, target) {
  $('sTime').textContent = settings.autoStopSec
    ? `${fmtClock(engine.elapsed)} / ${fmtClock(settings.autoStopSec)}`
    : fmtClock(engine.elapsed);
  if (!s) {
    for (const id of ['sAvg', 'sDrift', 'sWfPeak', 'sWfRms', 'sRange', 'sHarm', 'sRevs']) $(id).textContent = '--';
    return;
  }
  $('sAvg').textContent = `${s.avgRpm.toFixed(3)} RPM`;
  $('sWfPeak').textContent = `${s.wfPeakPct.toFixed(3)}%`;
  $('sWfRms').textContent = `${s.wfRmsPct.toFixed(3)}%`;
  $('sRange').textContent = `${s.minRpm.toFixed(2)} / ${s.maxRpm.toFixed(2)}`;
  $('sHarm').textContent = `${s.harmonicPct.toFixed(3)}%`;
  $('sRevs').textContent = s.revolutions.toFixed(1);
  if (target) {
    const secs = 20 * 60 * (deviationPct(s.avgRpm, target.value) / 100);
    $('sDrift').textContent = `${Math.abs(secs).toFixed(1)} s ${secs >= 0 ? 'early' : 'late'}`;
  } else {
    $('sDrift').textContent = '--';
  }
}

let tab = 'graph';
function paint(s) {
  const target = currentTarget(s ? s.avgRpm : 0);
  if (tab === 'graph') {
    drawChart($('chart'), {
      samples: engine.samples,
      smoothed: s ? s.smoothed : null,
      avgRpm: s ? s.avgRpm : 0,
      target: target ? target.value : null,
      windowSec: settings.windowSec,
      scalePct: settings.scalePct,
      thresholdPct: settings.thresholdPct,
    });
  } else {
    drawPolar($('polar'), {
      bins: s && s.revolutions > 1.5 ? s.bins : null,
      scalePct: settings.scalePct,
      thresholdPct: settings.thresholdPct,
      phase: engine.samples.length ? engine.samples[engine.samples.length - 1].phase : null,
      harmonicPct: s ? s.harmonicPct : null,
    });
  }
}

function updateStatusFromState(st) {
  if (!running) return;
  if (st === STATE.WAITING) setStatus('Waiting for the platter to turn…');
  else if (st === STATE.SETTLING) setStatus(`Coming up to speed — ignoring the first ${settings.settleSec}s…`);
  else if (st === STATE.MEASURING) {
    const s = engine.stats;
    setStatus(s && s.duration < 60 ? 'Measuring. Give it a full minute for wow & flutter.' : 'Measuring.');
  } else if (st === STATE.FROZEN && running) {
    if (settings.freezeOnStop) stop();
    else { engine.arm(); setStatus('Platter stopped — waiting for the next run…'); }
  }
}

// ---------------------------------------------------------------- compass calibration
const compass = new CompassSource();
let calState = null;

async function openCompass() {
  const perm = SIM ? 'granted' : await requestOrientationPermission();
  if (perm !== 'granted') { toast('No compass access'); return; }
  closeSheets();
  $('modalCompass').hidden = false;
  calState = { revs: 0, secs: 0, compassRpm: 0 };
  $('calApply').disabled = true;
  $('calStatus').textContent = 'Waiting for rotation…';

  if (!running) { source.start(onSample); engine.arm(); running = true;
                  $('btnStart').textContent = 'Stop'; $('btnStart').classList.add('is-stop'); }
  compass.start((u) => {
    calState = { ...u, compassRpm: u.rpm };
    const gyro = engine.stats ? engine.stats.avgRpm : 0;
    $('calRevs').textContent = u.revolutions.toFixed(2);
    $('calCompass').textContent = u.rpm ? u.rpm.toFixed(3) : '--';
    $('calGyro').textContent = gyro ? gyro.toFixed(3) : '--';
    const factor = gyro > 1 && u.rpm > 1 ? u.rpm / gyro : null;
    $('calFactor').textContent = factor ? factor.toFixed(4) : '--';
    const enough = u.revolutions >= 10 && u.seconds >= 45 && factor && Math.abs(factor - 1) < 0.05;
    $('calApply').disabled = !enough;
    $('calStatus').textContent = enough
      ? 'Ready. Apply to correct the gyroscope.'
      : (factor && Math.abs(factor - 1) >= 0.05)
        ? 'Compass and gyroscope disagree by more than 5% — magnetic interference. Move away from the motor and speakers.'
        : `Keep going — ${u.revolutions.toFixed(1)} of 10 revolutions, ${Math.max(0, 45 - u.seconds).toFixed(0)}s left.`;
  });
}

function applyCompass() {
  const gyro = engine.stats ? engine.stats.avgRpm : 0;
  if (!gyro || !calState?.compassRpm) return;
  cal = { scale: (calState.compassRpm / gyro) * engine.scale, at: Date.now(), revs: calState.revs };
  store.saveCalibration(cal);
  engine.scale = cal.scale;
  closeCompass();
  toast(`Gyroscope corrected ×${cal.scale.toFixed(4)}`);
  updateSensorInfo();
}

function closeCompass() {
  compass.stop();
  $('modalCompass').hidden = true;
}

// ---------------------------------------------------------------- settings UI
function bindSettings() {
  const map = [
    ['setSmooth', 'smoothN', (v) => `${v} samples · ${(v / 60).toFixed(2)}s — shorter sees faster wow, longer is quieter`],
    ['setThresh', 'thresholdPct', (v) => `±${v.toFixed(2)}%`, 100],
    ['setScale', 'scalePct', (v) => `±${v.toFixed(1)}%`, 10],
    ['setWindow', 'windowSec', (v) => `${v}s`],
    ['setSettle', 'settleSec', (v) => `${v}s`],
  ];
  for (const [id, key, fmt, div] of map) {
    const el = $(id);
    el.value = div ? settings[key] * div : settings[key];
    const label = el.closest('.row').querySelector('small');
    const show = () => { label.textContent = fmt(div ? el.value / div : Number(el.value)); };
    show();
    el.oninput = () => {
      settings[key] = div ? Number(el.value) / div : Number(el.value);
      show();
      engine.smoothN = settings.smoothN;
      engine.settleMs = settings.settleSec * 1000;
      store.saveSettings(settings);
      paint(engine.stats);
    };
  }
  for (const [id, key] of [['setCounter', 'counterRotate'], ['setFreeze', 'freezeOnStop'], ['setWake', 'wakeLock']]) {
    const el = $(id);
    el.checked = settings[key];
    el.onchange = () => { settings[key] = el.checked; store.saveSettings(settings); };
  }
  const auto = $('setAutoStop');
  auto.value = String(settings.autoStopSec);
  const showAuto = () => {
    $('lblAutoStop').textContent = settings.autoStopSec
      ? `Ends the run at ${fmtClock(settings.autoStopSec)} of measured time`
      : 'Runs until you stop it, or the platter does';
  };
  showAuto();
  auto.onchange = () => {
    settings.autoStopSec = Number(auto.value);
    store.saveSettings(settings);
    showAuto();
  };

  for (const [id, key] of [['set78', 'ref78'], ['set16', 'ref16']]) {
    const el = $(id);
    el.value = String(settings[key]);
    el.onchange = () => { settings[key] = Number(el.value); store.saveSettings(settings); buildTargets(); };
  }
  updateSensorInfo();
}

function updateSensorInfo() {
  const bits = [];
  if (SIM) bits.push('Simulated turntable — no sensor in use');
  else if (!motionSupported()) bits.push('No motion sensor found');
  else bits.push(source.hz ? `Gyroscope ${source.hz.toFixed(0)} Hz` : 'Gyroscope ready');
  if (engine.noiseFloorRpm != null) bits.push(`noise floor ${engine.noiseFloorRpm.toFixed(3)} RPM`);
  if (Math.abs(cal.scale - 1) > 1e-6) bits.push(`calibrated ×${cal.scale.toFixed(4)}`);
  $('sensorInfo').textContent = bits.join(' · ');
  $('lblCal').textContent = Math.abs(cal.scale - 1) > 1e-6
    ? `×${cal.scale.toFixed(4)}, set ${new Date(cal.at).toLocaleDateString()}`
    : 'not calibrated (×1.0000)';
}

// ---------------------------------------------------------------- history UI
function renderHistory() {
  const list = $('historyList');
  const all = store.loadHistory();
  list.innerHTML = '';
  if (!all.length) { list.innerHTML = '<p class="empty">No saved runs yet.</p>'; return; }
  for (const r of all) {
    const row = document.createElement('div');
    row.className = 'item';
    const dev = r.devPct == null ? '' :
      `<span style="color:${devColour(r.devPct, settings.thresholdPct)}">${fmtSigned(r.devPct, 2)}%</span>`;
    row.innerHTML = `
      <div>
        <div class="big">${r.avgRpm.toFixed(3)} RPM <small style="display:inline;margin-left:6px">${r.targetLabel}</small></div>
        <div class="meta">${dev} · W&amp;F ${r.wfPeakPct.toFixed(2)}% peak, ${r.wfRmsPct.toFixed(2)}% rms
          · ${fmtClock(r.duration)} · ${r.revolutions.toFixed(0)} revs</div>
        <div class="when">${new Date(r.at).toLocaleString()}</div>
      </div>
      <button class="del" aria-label="Delete">&times;</button>`;
    row.querySelector('.del').onclick = () => { store.deleteRun(r.id); renderHistory(); };
    list.appendChild(row);
  }
}

function exportCsv() {
  const csv = store.historyCsv();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `rpm-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- chrome
function setStatus(t) { $('status').textContent = t; }
let toastTimer;
function toast(t) {
  const el = $('toast');
  el.textContent = t; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
const fmtSigned = (v, d) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

function openSheet(id) { closeSheets(); $(id).hidden = false; }
function closeSheets() { for (const s of document.querySelectorAll('.sheet')) s.hidden = true; }

function wire() {
  $('btnStart').onclick = start;
  $('btnZero').onclick = zero;
  $('btnSave').onclick = save;
  $('btnSettings').onclick = () => openSheet('sheetSettings');
  $('btnHistory').onclick = () => { renderHistory(); openSheet('sheetHistory'); };
  $('btnExport').onclick = exportCsv;
  $('btnWipe').onclick = () => { if (confirm('Erase every saved run?')) { store.clearHistory(); renderHistory(); toast('History erased'); } };
  $('btnCompass').onclick = openCompass;
  $('btnCalReset').onclick = () => {
    cal = { scale: 1, at: null, revs: 0 };
    store.saveCalibration(cal); engine.scale = 1; updateSensorInfo(); toast('Calibration cleared');
  };
  $('calCancel').onclick = closeCompass;
  $('calApply').onclick = applyCompass;

  for (const b of document.querySelectorAll('[data-close]')) b.onclick = closeSheets;
  for (const s of document.querySelectorAll('.sheet')) {
    s.onclick = (e) => { if (e.target === s) closeSheets(); };
  }
  $('tabGraph').onclick = () => setTab('graph');
  $('tabMap').onclick = () => setTab('map');

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) setStatus('Backgrounded — iOS stops the sensor; the gap is left out.');
  });
  window.addEventListener('resize', () => paint(engine.stats));
}

function setTab(t) {
  tab = t;
  $('tabGraph').classList.toggle('is-on', t === 'graph');
  $('tabMap').classList.toggle('is-on', t === 'map');
  $('tabGraph').setAttribute('aria-selected', String(t === 'graph'));
  $('tabMap').setAttribute('aria-selected', String(t === 'map'));
  $('wrapGraph').hidden = t !== 'graph';
  $('wrapMap').hidden = t !== 'map';
  paint(engine.stats);
}

function boot() {
  $('simBadge').hidden = !SIM;
  $('buildStamp').textContent = BUILD.startsWith('__') ? 'dev build' : `build ${BUILD}`;
  buildTargets();
  bindSettings();
  wire();
  setTab('graph');
  if (!SIM && !motionSupported()) setStatus('This browser exposes no gyroscope. On iPhone, use Safari.');
  else if (!SIM && !isSecure()) setStatus('Open this page over https — iOS blocks sensors otherwise.');
  else if (!SIM && needsPermission()) setStatus('Press Start — iOS will ask for motion access.');
  render();

  if ('serviceWorker' in navigator && window.isSecureContext) {   // https, or localhost
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();

// exposed for the automated smoke test
window.__rpm = { engine, get stats() { return lastStats; }, get saved() { return savedThisRun; } };
