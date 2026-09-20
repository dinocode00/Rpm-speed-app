// Canvas drawing: the scrolling speed graph and the platter heat map.

const COL = {
  grid: '#1e262e', gridStrong: '#2c3741', text: '#8d9aa7',
  line: '#e8edf2', good: '#2ee6a8', fast: '#ff5a5f', slow: '#4da3ff', band: 'rgba(46,230,168,.13)',
};

export function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Colour for a deviation, in percent, against the "on speed" threshold. */
export function devColour(pct, threshold) {
  const a = Math.abs(pct);
  if (a <= threshold) return COL.good;
  if (a <= threshold * 2.5) return '#ffb020';
  return pct > 0 ? COL.fast : COL.slow;
}

/**
 * Scrolling deviation graph.
 * @param {object} o {samples, smoothed, avgRpm, target, windowSec, scalePct, thresholdPct}
 */
export function drawChart(canvas, o) {
  const { ctx, w, h } = fit(canvas);
  const padL = 46, padR = 10, padT = 10, padB = 18;
  const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;
  const scale = o.scalePct;
  const yOf = (pct) => y1 - ((pct + scale) / (2 * scale)) * (y1 - y0);

  // green tolerance band
  ctx.fillStyle = COL.band;
  ctx.fillRect(x0, yOf(o.thresholdPct), x1 - x0, yOf(-o.thresholdPct) - yOf(o.thresholdPct));

  // horizontal grid + labels
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const steps = [scale, scale / 2, 0, -scale / 2, -scale];
  for (const s of steps) {
    const y = yOf(s);
    ctx.strokeStyle = s === 0 ? COL.gridStrong : COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); ctx.stroke();
    ctx.fillStyle = COL.text;
    ctx.fillText(`${s > 0 ? '+' : ''}${fmtPct(s)}`, x0 - 5, y);
  }

  const samples = o.samples;
  if (!samples || samples.length < 2 || !o.avgRpm) { footer(ctx, x0, x1, y1, o, null); return; }

  const tEnd = samples[samples.length - 1].t;
  const tStart = Math.max(samples[0].t, tEnd - o.windowSec);
  const span = Math.max(0.5, tEnd - tStart);
  const xOf = (t) => x0 + ((t - tStart) / span) * (x1 - x0);

  // reference: deviation from the *target*, so a deck running fast sits above the centre line
  const ref = o.target || o.avgRpm;
  let i0 = lowerBound(samples, tStart);
  const px = Math.max(1, Math.floor((samples.length - i0) / Math.max(1, (x1 - x0) * 2)));

  ctx.beginPath();
  let started = false;
  for (let i = i0; i < samples.length; i += px) {
    const pct = ((o.smoothed[i] - ref) / ref) * 100;
    const x = xOf(samples[i].t);
    const y = clamp(yOf(pct), y0 - 6, y1 + 6);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COL.line; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();

  // the run's own average, as a dashed line
  const avgPct = ((o.avgRpm - ref) / ref) * 100;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = devColour(avgPct, o.thresholdPct);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, yOf(clampPct(avgPct, scale))); ctx.lineTo(x1, yOf(clampPct(avgPct, scale))); ctx.stroke();
  ctx.setLineDash([]);

  footer(ctx, x0, x1, y1, o, { tStart, tEnd });
}

function footer(ctx, x0, x1, y1, o, range) {
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.fillStyle = COL.text; ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(range ? `${fmtClock(range.tStart)}` : 'waiting', x0, y1 + 4);
  ctx.textAlign = 'right';
  ctx.fillText(range ? `${fmtClock(range.tEnd)}` : `${o.windowSec}s window`, x1, y1 + 4);
}

/**
 * Platter heat map: mean deviation binned by where the platter was in its rotation.
 * @param {object} o {bins, scalePct, thresholdPct, phase, harmonicPct, harmonicPhase}
 */
export function drawPolar(canvas, o) {
  const { ctx, w, h } = fit(canvas);
  const cx = w / 2, cy = h / 2;
  const rOuter = Math.min(w, h) / 2 - 16;
  const rInner = rOuter * 0.42;
  const bins = o.bins;

  if (!bins) {
    ctx.fillStyle = COL.text; ctx.font = '12px -apple-system,system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Measure for a few revolutions', cx, cy);
    return;
  }

  const n = bins.length;
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const v = bins[i];
    if (v === null) continue;
    const a0 = -Math.PI / 2 + i * step, a1 = a0 + step * 1.02;
    const t = clamp(Math.abs(v) / o.scalePct, 0, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, a0, a1);
    ctx.arc(cx, cy, rInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = heat(v, o.scalePct, o.thresholdPct, 0.25 + 0.75 * t);
    ctx.fill();
  }

  // rings and spindle
  ctx.strokeStyle = COL.gridStrong; ctx.lineWidth = 1;
  for (const r of [rInner, rOuter]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.fillStyle = '#0b0d10';
  ctx.beginPath(); ctx.arc(cx, cy, rInner * 0.12, 0, Math.PI * 2); ctx.fill();

  // current platter position
  if (typeof o.phase === 'number') {
    const a = -Math.PI / 2 + (o.phase / 360) * Math.PI * 2;
    ctx.strokeStyle = COL.line; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rInner, cy + Math.sin(a) * rInner);
    ctx.lineTo(cx + Math.cos(a) * rOuter, cy + Math.sin(a) * rOuter);
    ctx.stroke();
  }

  // centre label
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = COL.text; ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.fillText('once per rev', cx, cy - 10);
  ctx.fillStyle = COL.line; ctx.font = '600 15px -apple-system,system-ui,sans-serif';
  ctx.fillText(o.harmonicPct != null ? `${o.harmonicPct.toFixed(3)}%` : '--', cx, cy + 8);

  // scale key
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.fillStyle = COL.slow; ctx.textAlign = 'left';
  ctx.fillText(`slow  -${fmtPct(o.scalePct)}`, 6, h - 10);
  ctx.fillStyle = COL.fast; ctx.textAlign = 'right';
  ctx.fillText(`+${fmtPct(o.scalePct)}  fast`, w - 6, h - 10);
}

function heat(pct, scale, threshold, alpha) {
  if (Math.abs(pct) <= threshold) return `rgba(46,230,168,${alpha * 0.55})`;
  const t = clamp((Math.abs(pct) - threshold) / Math.max(1e-6, scale - threshold), 0, 1);
  return pct > 0
    ? `rgba(255,${Math.round(176 - 96 * t)},${Math.round(32 + 30 * t)},${alpha})`
    : `rgba(${Math.round(77 - 40 * t)},${Math.round(163 - 40 * t)},255,${alpha})`;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clampPct = (v, s) => clamp(v, -s, s);
const fmtPct = (v) => (Math.abs(v) < 1 ? `${v.toFixed(2)}%` : `${v.toFixed(1)}%`);

export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function lowerBound(samples, t) {
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}
