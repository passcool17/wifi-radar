import { clamp } from './samples.js';

/** Full loop length in milliseconds. */
export const LOOP_MS = 90_000;

/**
 * Scenario keyframes (loop time in ms).
 * Idle noise, person walks in, sits, then leaves.
 */
export const KEYFRAMES = [
  { t: 0, presence: false, motion: 2, rssi: -74, bearing: null, pir: false },
  { t: 14000, presence: false, motion: 3, rssi: -73, bearing: null, pir: false },
  { t: 15500, presence: true, motion: 48, rssi: -64, bearing: 38, pir: true },
  { t: 20000, presence: true, motion: 74, rssi: -55, bearing: 70, pir: true },
  { t: 26000, presence: true, motion: 16, rssi: -58, bearing: 86, pir: true },
  { t: 34000, presence: true, motion: 7, rssi: -59, bearing: 90, pir: true },
  { t: 50000, presence: true, motion: 9, rssi: -59, bearing: 92, pir: true },
  { t: 56000, presence: true, motion: 54, rssi: -54, bearing: 118, pir: true },
  { t: 64000, presence: true, motion: 68, rssi: -62, bearing: 168, pir: true },
  { t: 70000, presence: false, motion: 14, rssi: -70, bearing: 210, pir: true },
  { t: 76000, presence: false, motion: 3, rssi: -74, bearing: null, pir: false },
  { t: 90000, presence: false, motion: 2, rssi: -74, bearing: null, pir: false },
];

export function loopTime(elapsedMs) {
  return ((elapsedMs % LOOP_MS) + LOOP_MS) % LOOP_MS;
}

function lerp(a, b, u) {
  return a + (b - a) * u;
}

function hashNoise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Deterministic sample at a position in the loop.
 * @param {number} elapsedMs time since the scenario origin
 * @param {number} wallMs wall-clock timestamp written to `t`
 * @param {{ noise?: boolean }} [opts]
 */
export function sampleAt(elapsedMs, wallMs, opts = {}) {
  const noise = opts.noise !== false;
  const t = loopTime(elapsedMs);
  let i = 0;
  while (i < KEYFRAMES.length - 1 && KEYFRAMES[i + 1].t <= t) i += 1;
  const a = KEYFRAMES[i];
  const b = KEYFRAMES[Math.min(i + 1, KEYFRAMES.length - 1)];
  const span = Math.max(1, b.t - a.t);
  const u = clamp((t - a.t) / span, 0, 1);
  // Smoothstep for less mechanical ramps
  const s = u * u * (3 - 2 * u);
  let motion = lerp(a.motion, b.motion, s);
  let rssi = lerp(a.rssi, b.rssi, s);
  const presence = u < 0.5 ? a.presence : b.presence;
  const pir = Boolean(u < 0.5 ? a.pir : b.pir);
  let bearing;
  if (a.bearing != null && b.bearing != null) {
    // shortest-path interpolation is unnecessary here; bearings only increase
    bearing = lerp(a.bearing, b.bearing, s);
  } else if (a.bearing != null) {
    bearing = a.bearing;
  } else if (b.bearing != null && u > 0.2) {
    bearing = b.bearing;
  }
  if (noise) {
    const n1 = hashNoise(t * 0.017 + wallMs * 0.00001);
    const n2 = hashNoise(t * 0.031 + 17.2);
    motion += (n1 - 0.5) * (presence ? 4.2 : 2.2);
    rssi += (n2 - 0.5) * 1.6;
  }
  const recentPir = pir || pirRecently(t, 5000);
  const sample = {
    t: wallMs,
    rssi: Math.round(rssi * 10) / 10,
    motion: Math.round(clamp(motion, 0, 100) * 10) / 10,
    presence,
    pir,
    confirmed: Boolean(presence && recentPir),
  };
  if (bearing != null) sample.bearing = bearing;
  return sample;
}

function pirAt(loopT) {
  const t = loopTime(loopT);
  let i = 0;
  while (i < KEYFRAMES.length - 1 && KEYFRAMES[i + 1].t <= t) i += 1;
  const a = KEYFRAMES[i];
  const b = KEYFRAMES[Math.min(i + 1, KEYFRAMES.length - 1)];
  const span = Math.max(1, b.t - a.t);
  const u = clamp((t - a.t) / span, 0, 1);
  return Boolean(u < 0.5 ? a.pir : b.pir);
}

function pirRecently(loopT, windowMs) {
  if (pirAt(loopT)) return true;
  for (let back = 200; back <= windowMs; back += 200) {
    if (pirAt(loopT - back)) return true;
  }
  return false;
}

/**
 * Scene shortcuts used by tests and screenshots.
 * @param {string | null} name
 */
export function sceneOffset(name) {
  if (name === 'presence' || name === 'assis') return 34_000;
  if (name === 'marche' || name === 'walk') return 18_000;
  if (name === 'sortie' || name === 'leave') return 62_000;
  if (name === 'idle') return 4_000;
  return 0;
}

/**
 * @param {{ interval?: number, now?: () => number, noise?: boolean, originOffset?: number }} [opts]
 */
export function createSimulator(opts = {}) {
  const interval = opts.interval ?? 100;
  const now = opts.now ?? Date.now;
  const noise = opts.noise !== false;
  const originOffset = opts.originOffset ?? 0;
  let timer = null;
  let origin = 0;
  let onSample = null;

  function tick() {
    const wall = now();
    const sample = sampleAt(wall - origin + originOffset, wall, { noise });
    onSample?.(sample);
  }

  return {
    start(handler) {
      onSample = handler;
      origin = now();
      tick();
      timer = setInterval(tick, interval);
    },
    stop() {
      if (timer != null) clearInterval(timer);
      timer = null;
      onSample = null;
    },
  };
}
