
/**
 * Coerce an optional JSON boolean. Missing or invalid values yield undefined
 * so older firmware (no pir/confirmed/mute) stays compatible.
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @returns {boolean | undefined}
 */
export function optionalBool(raw, key) {
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
  let value = raw[key];
  if (value === 0 || value === 1 || value === '0' || value === '1') {
    value = Boolean(Number(value));
  }
  if (value === 'true' || value === 'false') value = value === 'true';
  return typeof value === 'boolean' ? value : undefined;
}

/** @typedef {{ t: number, rssi: number, motion: number, presence: boolean, bearing?: number, pir?: boolean, confirmed?: boolean, mute?: boolean }} Sample */

/**
 * Parse and validate a CSI sample. Accepts an object or a JSON string.
 * Shape: { t, rssi, motion, presence } with optional bearing, pir, confirmed, mute.
 * @param {unknown} input
 * @returns {{ ok: true, sample: Sample } | { ok: false, error: string }}
 */
export function parseSample(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return { ok: false, error: 'json' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'object' };
  }
  const raw = /** @type {Record<string, unknown>} */ (data);
  let t = Number(raw.t);
  const rssi = Number(raw.rssi);
  const motion = Number(raw.motion);
  if (!Number.isFinite(t) || !Number.isFinite(rssi) || !Number.isFinite(motion)) {
    return { ok: false, error: 'numbers' };
  }
  // Epoch seconds -> ms. Boot millis or other small values are replaced later by the receiver.
  if (t > 1e9 && t < 1e11) t = t * 1000;
  let presence = raw.presence;
  if (presence === 0 || presence === 1 || presence === '0' || presence === '1') {
    presence = Boolean(Number(presence));
  }
  if (presence === 'true' || presence === 'false') {
    presence = presence === 'true';
  }
  if (typeof presence !== 'boolean') {
    return { ok: false, error: 'presence' };
  }
  /** @type {Sample} */
  const sample = {
    t,
    rssi,
    motion: clamp(motion, 0, 100),
    presence,
  };
  if (raw.bearing !== undefined && raw.bearing !== null && Number.isFinite(Number(raw.bearing))) {
    sample.bearing = ((Number(raw.bearing) % 360) + 360) % 360;
  }
  const pir = optionalBool(raw, 'pir');
  const confirmed = optionalBool(raw, 'confirmed');
  const mute = optionalBool(raw, 'mute');
  if (pir !== undefined) sample.pir = pir;
  if (confirmed !== undefined) sample.confirmed = confirmed;
  if (mute !== undefined) sample.mute = mute;
  return { ok: true, sample };
}

/**
 * If `t` is not a plausible epoch in ms, stamp the sample with the receive time.
 * @param {Sample} sample
 * @param {number} [now]
 */
export function stampSampleTime(sample, now = Date.now()) {
  if (sample.t < 1e11) sample.t = now;
  return sample;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export const MOTION_START = 22;
export const MOTION_STOP = 12;

/**
 * Hysteresis detector for motion start/stop events.
 * @param {{ start?: number, stop?: number }} [opts]
 */
export function createMotionDetector(opts = {}) {
  const startAt = opts.start ?? MOTION_START;
  const stopAt = opts.stop ?? MOTION_STOP;
  let active = false;
  return {
    get active() {
      return active;
    },
    /**
     * @param {Sample} sample
     * @returns {'start' | 'stop' | null}
     */
    observe(sample) {
      if (!active && sample.motion >= startAt) {
        active = true;
        return 'start';
      }
      if (active && sample.motion <= stopAt) {
        active = false;
        return 'stop';
      }
      return null;
    },
    reset() {
      active = false;
    },
  };
}

export const SETTINGS_KEY = 'wifi-radar-settings';

export function isEspHost(loc = location) {
  if (loc.protocol !== 'http:') return false;
  const h = loc.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return false;
  if (h.endsWith('github.io')) return false;
  return true;
}

export function defaultSettings(loc = typeof location !== 'undefined' ? location : null) {
  if (loc && isEspHost(loc)) {
    return {
      source: 'esp32',
      ip: loc.hostname,
      port: loc.port || '80',
      path: '/ws',
      mute: false,
    };
  }
  return { source: 'sim', ip: '', port: '80', path: '/ws', mute: false };
}

/**
 * @param {unknown} raw
 * @param {Location | { protocol: string, hostname: string, port: string } | null} [loc]
 */
export function loadSettings(raw, loc = typeof location !== 'undefined' ? location : null) {
  const base = defaultSettings(loc);
  if (!raw || typeof raw !== 'object') return base;
  const data = /** @type {Record<string, unknown>} */ (raw);
  const source = data.source === 'esp32' ? 'esp32' : data.source === 'sim' ? 'sim' : base.source;
  const ip = typeof data.ip === 'string' ? data.ip.trim() : base.ip;
  let port = typeof data.port === 'string' || typeof data.port === 'number' ? String(data.port).trim() : base.port;
  if (!/^\d{1,5}$/.test(port)) port = base.port;
  const path = typeof data.path === 'string' && data.path.startsWith('/') ? data.path : base.path;
  const mute = typeof data.mute === 'boolean' ? data.mute : base.mute;
  // When the page itself is served by the ESP32, always prefer the same host.
  if (loc && isEspHost(loc)) {
    return { source: 'esp32', ip: loc.hostname, port: loc.port || '80', path: '/ws', mute };
  }
  return { source, ip, port, path, mute };
}

export function websocketUrl(settings) {
  const ip = (settings.ip || '').trim();
  if (!ip) return '';
  const port = String(settings.port || '80');
  const path = settings.path || '/ws';
  const host = port && port !== '80' ? `${ip}:${port}` : ip;
  return `ws://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

export function isMixedContent(wsUrl, loc = typeof location !== 'undefined' ? location : null) {
  if (!wsUrl || !loc) return false;
  return loc.protocol === 'https:' && wsUrl.startsWith('ws:');
}
