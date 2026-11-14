import assert from 'node:assert/strict';
import {
  parseSample,
  stampSampleTime,
  createMotionDetector,
  loadSettings,
  defaultSettings,
  websocketUrl,
  isMixedContent,
  isEspHost,
  clamp,
} from '../js/samples.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}

test('accepts a valid sample object', () => {
  const r = parseSample({ t: 1731600000000, rssi: -62.2, motion: 41, presence: true });
  assert.equal(r.ok, true);
  assert.equal(r.sample.presence, true);
  assert.equal(r.sample.motion, 41);
  assert.equal(r.sample.rssi, -62.2);
});

test('parses a JSON string', () => {
  const r = parseSample('{"t":1731600000000,"rssi":-50,"motion":12.4,"presence":false}');
  assert.equal(r.ok, true);
  assert.equal(r.sample.presence, false);
});

test('rejects invalid JSON and missing fields', () => {
  assert.equal(parseSample('{nope').ok, false);
  assert.equal(parseSample(null).ok, false);
  assert.equal(parseSample([]).ok, false);
  assert.equal(parseSample({ t: 1, rssi: 1, motion: 1 }).ok, false);
  assert.equal(parseSample({ t: 'x', rssi: -20, motion: 1, presence: true }).ok, false);
});

test('clamps motion to 0-100', () => {
  assert.equal(parseSample({ t: 1, rssi: -30, motion: 140, presence: false }).sample.motion, 100);
  assert.equal(parseSample({ t: 1, rssi: -30, motion: -9, presence: false }).sample.motion, 0);
  assert.equal(clamp(12, 0, 10), 10);
});

test('accepts 0/1 and string booleans for presence', () => {
  assert.equal(parseSample({ t: 1, rssi: -30, motion: 1, presence: 1 }).sample.presence, true);
  assert.equal(parseSample({ t: 1, rssi: -30, motion: 1, presence: 0 }).sample.presence, false);
  assert.equal(parseSample({ t: 1, rssi: -30, motion: 1, presence: 'true' }).sample.presence, true);
});

test('keeps optional bearing in 0-360', () => {
  const r = parseSample({ t: 1, rssi: -30, motion: 1, presence: true, bearing: 400 });
  assert.equal(r.sample.bearing, 40);
});

test('converts epoch seconds to milliseconds', () => {
  const r = parseSample({ t: 1731600000, rssi: -30, motion: 1, presence: false });
  assert.equal(r.sample.t, 1731600000000);
});

test('stampSampleTime replaces boot-style timestamps', () => {
  const s = stampSampleTime({ t: 4500, rssi: -60, motion: 0, presence: false }, 1731600000000);
  assert.equal(s.t, 1731600000000);
  const keep = stampSampleTime({ t: 1731600000000, rssi: -60, motion: 0, presence: false }, 1);
  assert.equal(keep.t, 1731600000000);
});

test('motion detector uses hysteresis', () => {
  const d = createMotionDetector();
  assert.equal(d.observe({ motion: 10 }), null);
  assert.equal(d.observe({ motion: 22 }), 'start');
  assert.equal(d.observe({ motion: 18 }), null);
  assert.equal(d.observe({ motion: 12 }), 'stop');
  assert.equal(d.observe({ motion: 12 }), null);
});

const pages = { protocol: 'https:', hostname: 'passcool17.github.io', port: '' };
const esp = { protocol: 'http:', hostname: 'wifi-radar.local', port: '' };
const lan = { protocol: 'http:', hostname: '192.168.1.42', port: '' };
const local = { protocol: 'http:', hostname: 'localhost', port: '4173' };

test('detects an ESP32-served host', () => {
  assert.equal(isEspHost(pages), false);
  assert.equal(isEspHost(local), false);
  assert.equal(isEspHost(esp), true);
  assert.equal(isEspHost(lan), true);
});

test('defaults to ESP32 mode on the device host', () => {
  const s = defaultSettings(esp);
  assert.equal(s.source, 'esp32');
  assert.equal(s.ip, 'wifi-radar.local');
  assert.equal(websocketUrl(s), 'ws://wifi-radar.local/ws');
});

test('loads saved settings on GitHub Pages', () => {
  const s = loadSettings({ source: 'esp32', ip: '192.168.1.50', port: '80' }, pages);
  assert.equal(s.source, 'esp32');
  assert.equal(websocketUrl(s), 'ws://192.168.1.50/ws');
});

test('forces same-host ESP32 settings when served by the board', () => {
  const s = loadSettings({ source: 'sim', ip: '10.0.0.9', port: '81' }, lan);
  assert.equal(s.source, 'esp32');
  assert.equal(s.ip, '192.168.1.42');
  assert.equal(websocketUrl(s), 'ws://192.168.1.42/ws');
});

test('includes a non-default port in the URL', () => {
  assert.equal(websocketUrl({ ip: '10.0.0.8', port: '81', path: '/ws' }), 'ws://10.0.0.8:81/ws');
});

test('flags mixed content on HTTPS pages', () => {
  assert.equal(isMixedContent('ws://192.168.1.50/ws', pages), true);
  assert.equal(isMixedContent('ws://wifi-radar.local/ws', esp), false);
  assert.equal(isMixedContent('', pages), false);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
