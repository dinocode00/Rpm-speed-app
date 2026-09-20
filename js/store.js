// Settings and saved runs. Everything stays on the device; nothing is uploaded anywhere.

const SETTINGS_KEY = 'rpm.settings.v1';
const HISTORY_KEY = 'rpm.history.v1';
const CAL_KEY = 'rpm.cal.v1';

export const DEFAULTS = {
  smoothN: 20,          // samples in the moving average (~1/3 s at 60 Hz)
  thresholdPct: 0.3,    // "on speed" window, in percent
  scalePct: 1.0,        // graph and meter full scale, in percent
  windowSec: 60,        // scrolling graph width
  settleSec: 3,         // ignored while the platter gets up to speed
  autoStopSec: 0,       // end the run after this much measured time (0 = run until stopped)
  counterRotate: true,
  freezeOnStop: true,
  wakeLock: true,
  ref78: 78,
  ref16: 16.6667,
};

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

export function loadSettings() { return { ...DEFAULTS, ...read(SETTINGS_KEY, {}) }; }
export function saveSettings(s) { write(SETTINGS_KEY, s); }

export function loadCalibration() { return read(CAL_KEY, { scale: 1, at: null, revs: 0 }); }
export function saveCalibration(c) { write(CAL_KEY, c); }

export function loadHistory() { return read(HISTORY_KEY, []); }
export function addRun(run) {
  const all = loadHistory();
  all.unshift(run);
  write(HISTORY_KEY, all.slice(0, 200));
  return all;
}
export function deleteRun(id) {
  const all = loadHistory().filter((r) => r.id !== id);
  write(HISTORY_KEY, all);
  return all;
}
export function clearHistory() { write(HISTORY_KEY, []); }

export function historyCsv() {
  const rows = [[
    'saved_at', 'target_rpm', 'average_rpm', 'deviation_pct', 'deviation_cents',
    'wf_peak_pct', 'wf_rms_pct', 'once_per_rev_pct', 'min_rpm', 'max_rpm',
    'revolutions', 'duration_sec', 'samples', 'gyro_scale', 'note',
  ]];
  for (const r of loadHistory()) {
    rows.push([
      new Date(r.at).toISOString(), r.target, num(r.avgRpm, 4), num(r.devPct, 4), num(r.devCents, 2),
      num(r.wfPeakPct, 4), num(r.wfRmsPct, 4), num(r.harmonicPct, 4), num(r.minRpm, 3), num(r.maxRpm, 3),
      num(r.revolutions, 2), num(r.duration, 1), r.samples, num(r.scale, 5), (r.note || '').replace(/[",\n]/g, ' '),
    ]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '');
