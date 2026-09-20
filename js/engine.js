// Measurement engine: turns a stream of gyroscope vectors into turntable speed statistics.
//
// A gyroscope reports the angular velocity of the whole phone, which — once the phone is lying on
// the platter — is the angular velocity of the platter itself. That is why placement does not
// matter: anywhere on the record reads the same, centred or not.

export const DEG_PER_REV = 360;
export const rpmFromDegPerSec = (d) => d / 6;          // deg/s -> rev/min
export const degPerSecFromRpm = (r) => r * 6;

export const MOVING_THRESHOLD_RPM = 3;                  // below this the platter counts as stopped
const MOVE_CONFIRM_MS = 300;                            // rotation must persist this long to arm
const STOP_CONFIRM_MS = 900;                            // ...and stop this long to disarm
const MAX_SAMPLES = 200000;                             // ~55 min at 60 Hz before decimation

export const STATE = {
  IDLE: 'idle',
  ZEROING: 'zeroing',
  WAITING: 'waiting',
  SETTLING: 'settling',
  MEASURING: 'measuring',
  FROZEN: 'frozen',
};

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class Engine {
  constructor(opts = {}) {
    this.settleMs = (opts.settleSec ?? 3) * 1000;
    this.smoothN = opts.smoothN ?? 30;
    this.scale = opts.scale ?? 1;          // gyroscope scale correction (compass calibration)
    this.bias = opts.bias ? opts.bias.slice() : [0, 0, 0];
    this.noiseFloorRpm = opts.noiseFloorRpm ?? null;
    this.reset();
  }

  reset() {
    this.state = STATE.IDLE;
    this.samples = [];        // {t, rpm, phase}  t in seconds from start of measurement
    this.decim = 1;
    this.axis = [1, 0, 0];    // unit rotation axis in device coordinates (alpha/beta/gamma)
    this.axisAcc = [0, 0, 0];
    this.angleDeg = 0;        // signed, integrated about `axis`
    this.durationSec = 0;     // measured span, kept in step with angleDeg
    this.t0 = null;           // performance.now() at the first measured sample
    this.tLast = null;
    this.rateLast = 0;
    this.moveSince = null;
    this.stopSince = null;
    this.settleStart = null;
    this.liveRpm = 0;
    this.stats = null;
    this._zero = null;
  }

  // ---- zeroing -------------------------------------------------------------
  beginZero() {
    this.state = STATE.ZEROING;
    this._zero = { sum: [0, 0, 0], sq: 0, n: 0, until: performance.now() + 2000 };
  }

  // ---- arming --------------------------------------------------------------
  arm() {
    const keep = { bias: this.bias, scale: this.scale, noiseFloorRpm: this.noiseFloorRpm };
    this.reset();
    Object.assign(this, keep);
    this.state = STATE.WAITING;
  }

  freeze() { if (this.state !== STATE.IDLE) this.state = STATE.FROZEN; }

  /**
   * Feed one sensor reading.
   * @param {number[]} raw  [alpha, beta, gamma] in deg/s (rotation about device z, x, y)
   * @param {number} now    performance.now() timestamp in ms
   */
  push(raw, now) {
    if (this.state === STATE.ZEROING) return this._pushZero(raw, now);
    if (this.state === STATE.IDLE || this.state === STATE.FROZEN) return;

    const v = [
      (raw[0] - this.bias[0]) * this.scale,
      (raw[1] - this.bias[1]) * this.scale,
      (raw[2] - this.bias[2]) * this.scale,
    ];
    const mag = norm(v);
    const movingNow = rpmFromDegPerSec(mag) > MOVING_THRESHOLD_RPM;

    // Track the rotation axis from the mean vector: cross-axis noise averages out, and the
    // projection onto it keeps a sign, so a tilted or propped-up phone still reads correctly.
    if (movingNow) {
      this.axisAcc[0] += v[0]; this.axisAcc[1] += v[1]; this.axisAcc[2] += v[2];
      const n = norm(this.axisAcc);
      if (n > 0) this.axis = [this.axisAcc[0] / n, this.axisAcc[1] / n, this.axisAcc[2] / n];
    }
    const rate = movingNow ? dot(v, this.axis) : 0;     // deg/s about the platter axis
    this.liveRpm = rpmFromDegPerSec(rate);

    // --- state machine ---
    if (movingNow) {
      this.stopSince = null;
      if (this.moveSince === null) this.moveSince = now;
    } else {
      this.moveSince = null;
      if (this.stopSince === null) this.stopSince = now;
    }

    if (this.state === STATE.WAITING) {
      if (this.moveSince !== null && now - this.moveSince >= MOVE_CONFIRM_MS) {
        this.state = STATE.SETTLING;
        this.settleStart = now;
      }
    } else if (this.state === STATE.SETTLING) {
      if (!movingNow) { this.state = STATE.WAITING; this.settleStart = null; }
      else if (now - this.settleStart >= this.settleMs) {
        this.state = STATE.MEASURING;
        this.t0 = now; this.tLast = now; this.rateLast = rate;
        this.angleDeg = 0; this.durationSec = 0;
      }
    } else if (this.state === STATE.MEASURING) {
      const dt = (now - this.tLast) / 1000;
      this.tLast = now;
      if (dt > 0 && dt < 0.5) {
        this.angleDeg += ((rate + this.rateLast) / 2) * dt;   // trapezoid
        const t = (now - this.t0) / 1000;
        this.durationSec += dt;   // accumulated, so a suspended tab leaves a gap rather than a slow reading
        const phase = ((this.angleDeg % DEG_PER_REV) + DEG_PER_REV) % DEG_PER_REV;
        this._store({ t, rpm: rpmFromDegPerSec(rate), phase });
      }
      this.rateLast = rate;
      if (this.stopSince !== null && now - this.stopSince >= STOP_CONFIRM_MS) this.state = STATE.FROZEN;
    }
  }

  _store(s) {
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) {          // halve the rate rather than forget the start
      this.samples = this.samples.filter((_, i) => i % 2 === 0);
      this.decim *= 2;
    }
  }

  _pushZero(raw, now) {
    const z = this._zero;
    z.sum[0] += raw[0]; z.sum[1] += raw[1]; z.sum[2] += raw[2];
    z.sq += raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2];
    z.n++;
    if (now >= z.until && z.n > 10) {
      const mean = z.sum.map((s) => s / z.n);
      const meanSq = z.sq / z.n;
      const varSum = Math.max(0, meanSq - dot(mean, mean));   // total variance across the three axes
      this.bias = mean;
      this.noiseFloorRpm = rpmFromDegPerSec(Math.sqrt(varSum / 3));
      this.state = STATE.IDLE;
      this._zero = null;
      return { done: true, bias: mean, noiseFloorRpm: this.noiseFloorRpm };
    }
    return null;
  }

  get elapsed() { return this.durationSec; }

  /** Full statistics over the measured run. Cheap enough to call a few times a second. */
  computeStats() {
    const s = this.samples;
    if (s.length < 5) return (this.stats = null);

    const duration = this.durationSec;
    if (duration <= 0) return (this.stats = null);

    // Average from the integrated angle, not the mean of samples: uneven event delivery then
    // cannot bias the headline figure.
    const avgRpm = (this.angleDeg / DEG_PER_REV) / (duration / 60);

    const n = Math.max(1, Math.min(this.smoothN, Math.floor(s.length / 4)));
    this._scratch = this._scratch && this._scratch.length > s.length ? this._scratch : new Float64Array(s.length + 1);
    const sm = movingAverage(s, n, this._scratch);

    let min = Infinity, max = -Infinity, sum = 0, sumSq = 0, peak = 0;
    let c1 = 0, s1 = 0;
    const BINS = 72;
    const binSum = new Float64Array(BINS), binN = new Float64Array(BINS);

    for (let i = 0; i < sm.length; i++) {
      const r = sm[i];
      if (r < min) min = r;
      if (r > max) max = r;
      sum += r; sumSq += r * r;
      const d = r - avgRpm;
      if (Math.abs(d) > Math.abs(peak)) peak = d;
      const ph = s[i].phase;
      const rad = (ph * Math.PI) / 180;
      c1 += d * Math.cos(rad); s1 += d * Math.sin(rad);
      const b = Math.min(BINS - 1, Math.floor((ph / DEG_PER_REV) * BINS));
      binSum[b] += d; binN[b]++;
    }
    const m = sum / sm.length;
    const variance = Math.max(0, sumSq / sm.length - m * m);
    const rms = Math.sqrt(variance);

    const harmAmp = (2 / sm.length) * Math.hypot(c1, s1);
    const harmPhase = ((Math.atan2(s1, c1) * 180) / Math.PI + 360) % 360;

    const pct = (x) => (avgRpm ? (x / avgRpm) * 100 : 0);
    const bins = [];
    for (let b = 0; b < BINS; b++) bins.push(binN[b] ? pct(binSum[b] / binN[b]) : null);

    return (this.stats = {
      avgRpm,
      duration,
      revolutions: Math.abs(this.angleDeg) / DEG_PER_REV,
      samples: s.length,
      minRpm: min,
      maxRpm: max,
      wfPeakPct: Math.abs(pct(peak)),
      wfRmsPct: pct(rms),
      rangePct: pct(max - min),
      harmonicPct: pct(harmAmp),
      harmonicPhase: harmPhase,
      bins,
      smoothed: sm,
    });
  }
}

/** Centred moving average over the rpm field, with the window shrinking at both edges. */
export function movingAverage(samples, n, scratch) {
  const len = samples.length;
  const out = new Float64Array(len);
  if (len === 0) return out;
  if (n <= 1) { for (let i = 0; i < len; i++) out[i] = samples[i].rpm; return out; }
  const pre = scratch && scratch.length > len ? scratch : new Float64Array(len + 1);
  pre[0] = 0;
  for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + samples[i].rpm;
  const half = n >> 1;
  for (let i = 0; i < len; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(len, i - half + n);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

/** Nearest nominal speed, or null when nothing is close enough to be credible. */
export function detectTarget(rpm, targets, tolerance = 0.12) {
  let best = null, bestErr = Infinity;
  for (const t of targets) {
    const err = Math.abs(rpm - t.value) / t.value;
    if (err < bestErr) { bestErr = err; best = t; }
  }
  return bestErr <= tolerance ? best : null;
}

export const deviationPct = (rpm, target) => ((rpm - target) / target) * 100;
export const deviationCents = (rpm, target) => 1200 * Math.log2(rpm / target);
