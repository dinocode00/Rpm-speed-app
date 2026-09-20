// Sensor access. iOS 13+ hands out motion and orientation data only after an explicit
// permission request made from inside a user gesture, and only over HTTPS.

export const isSecure = () => window.isSecureContext;

export function motionSupported() {
  return typeof window.DeviceMotionEvent !== 'undefined';
}

export function needsPermission() {
  return typeof DeviceMotionEvent !== 'undefined' &&
         typeof DeviceMotionEvent.requestPermission === 'function';
}

/** @returns {Promise<'granted'|'denied'|'unsupported'|'insecure'>} */
export async function requestMotionPermission() {
  if (!motionSupported()) return 'unsupported';
  if (!isSecure()) return 'insecure';
  if (!needsPermission()) return 'granted';
  try {
    return (await DeviceMotionEvent.requestPermission()) === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
  if (typeof DeviceOrientationEvent.requestPermission !== 'function') return 'granted';
  try {
    return (await DeviceOrientationEvent.requestPermission()) === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Live gyroscope. Calls onSample([alpha, beta, gamma] deg/s, performance.now()). */
export class MotionSource {
  constructor() { this.hz = 0; this._n = 0; this._t0 = 0; this.gotData = false; }

  start(onSample) {
    this.stop();
    this._t0 = performance.now(); this._n = 0;
    this._handler = (e) => {
      const r = e.rotationRate;
      if (!r || (r.alpha === null && r.beta === null && r.gamma === null)) return;
      this.gotData = true;
      const now = performance.now();
      this._n++;
      const dt = (now - this._t0) / 1000;
      if (dt > 1) { this.hz = this._n / dt; this._n = 0; this._t0 = now; }
      onSample([r.alpha || 0, r.beta || 0, r.gamma || 0], now);
    };
    window.addEventListener('devicemotion', this._handler);
  }

  stop() {
    if (this._handler) window.removeEventListener('devicemotion', this._handler);
    this._handler = null;
  }
}

/** Magnetometer heading, unwrapped into a continuous angle so revolutions can be counted. */
export class CompassSource {
  constructor() { this.reset(); }

  reset() { this.total = 0; this.last = null; this.t0 = null; this.tLast = null; }

  start(onUpdate) {
    this.stop(); this.reset();
    this._handler = (e) => {
      let h = (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading))
        ? e.webkitCompassHeading
        : (typeof e.alpha === 'number' ? 360 - e.alpha : null);
      if (h === null) return;
      const now = performance.now();
      if (this.last !== null) {
        let d = h - this.last;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        this.total += d;
      } else {
        this.t0 = now;
      }
      this.last = h; this.tLast = now;
      const secs = (now - this.t0) / 1000;
      onUpdate({
        revolutions: Math.abs(this.total) / 360,
        seconds: secs,
        rpm: secs > 0 ? Math.abs(this.total) / 360 / (secs / 60) : 0,
      });
    };
    window.addEventListener('deviceorientation', this._handler);
  }

  stop() {
    if (this._handler) window.removeEventListener('deviceorientation', this._handler);
    this._handler = null;
  }
}

/** Synthetic turntable, so the app can be demonstrated and tested without hardware. */
export class SimSource {
  constructor({ rpm = 33.31, wow = 0.25, wowHz = 0.9, noise = 0.6, spinUp = 1.5 } = {}) {
    Object.assign(this, { rpm, wow, wowHz, noise, spinUp });
    this.hz = 60; this.gotData = true;
  }

  start(onSample) {
    this.stop();
    this.t0 = performance.now();
    this._timer = setInterval(() => {
      const now = performance.now();
      const t = (now - this.t0) / 1000;
      const ramp = Math.min(1, t / this.spinUp);
      const wobble = 1 + (this.wow / 100) * Math.sin(2 * Math.PI * this.wowHz * t);
      const deg = this.rpm * ramp * wobble * 6;
      const n = () => this.noise * (Math.random() + Math.random() + Math.random() - 1.5);
      onSample([deg + n(), n(), n()], now);
    }, 1000 / 60);
  }

  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }
}

/** Keeps the screen on while a measurement is running (iOS 16.4+). */
export class Wakelock {
  async on() {
    try {
      if ('wakeLock' in navigator) this._s = await navigator.wakeLock.request('screen');
    } catch { /* not fatal */ }
  }
  off() { try { this._s?.release(); } catch {} this._s = null; }
}
