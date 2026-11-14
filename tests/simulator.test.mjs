import assert from 'node:assert/strict';
import { LOOP_MS, KEYFRAMES, sampleAt, sceneOffset, loopTime, createSimulator } from '../js/simulator.js';

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

test('loop time wraps inside the scenario length', () => {
  assert.equal(loopTime(0), 0);
  assert.equal(loopTime(LOOP_MS), 0);
  assert.equal(loopTime(LOOP_MS + 1500), 1500);
  assert.equal(loopTime(-1000), LOOP_MS - 1000);
});

test('idle phase has no presence and low motion', () => {
  const s = sampleAt(2000, 1_000_000, { noise: false });
  assert.equal(s.presence, false);
  assert.ok(s.motion < 8);
  assert.equal(s.t, 1_000_000);
  assert.ok(s.rssi < -60);
});

test('walk-in phase has presence and higher motion', () => {
  const s = sampleAt(sceneOffset('walk'), 1, { noise: false });
  assert.equal(s.presence, true);
  assert.ok(s.motion > 40);
  assert.ok(s.bearing != null);
});

test('sitting phase keeps presence with low motion', () => {
  const s = sampleAt(sceneOffset('presence'), 1, { noise: false });
  assert.equal(s.presence, true);
  assert.ok(s.motion < 20);
});

test('leaving then returns to idle', () => {
  const leaving = sampleAt(sceneOffset('leave'), 1, { noise: false });
  assert.equal(leaving.presence, true);
  assert.ok(leaving.motion > 40);
  const gone = sampleAt(78000, 1, { noise: false });
  assert.equal(gone.presence, false);
  assert.ok(gone.motion < 8);
});

test('with noise, values stay in range and the loop is complete', () => {
  for (let t = 0; t <= LOOP_MS; t += 500) {
    const s = sampleAt(t, 1_700_000_000_000 + t, { noise: true });
    assert.ok(s.motion >= 0 && s.motion <= 100, `motion ${s.motion} at ${t}`);
    assert.equal(typeof s.presence, 'boolean');
    assert.equal(typeof s.rssi, 'number');
    assert.ok(Number.isFinite(s.rssi));
  }
  assert.ok(KEYFRAMES.length >= 8);
  assert.equal(KEYFRAMES[0].t, 0);
  assert.equal(KEYFRAMES.at(-1).t, LOOP_MS);
});

test('createSimulator emits samples and can be stopped', async () => {
  let now = 0;
  const samples = [];
  const sim = createSimulator({
    interval: 20,
    now: () => now,
    noise: false,
    originOffset: sceneOffset('presence'),
  });
  sim.start((s) => samples.push(s));
  now = 40;
  await new Promise((r) => setTimeout(r, 50));
  sim.stop();
  const after = samples.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(samples.length >= 1);
  assert.equal(samples.length, after);
  assert.equal(samples[0].presence, true);
});

test('idle phase has no PIR and is not confirmed', () => {
  const s = sampleAt(2000, 1_000_000, { noise: false });
  assert.equal(s.pir, false);
  assert.equal(s.confirmed, false);
});

test('sitting scene has PIR and is confirmed', () => {
  const s = sampleAt(sceneOffset('presence'), 1, { noise: false });
  assert.equal(s.presence, true);
  assert.equal(s.pir, true);
  assert.equal(s.confirmed, true);
});

test('confirmed stays true for a few seconds after PIR falls', () => {
  // After t=76000 PIR is false; presence is already false so confirmed is false.
  // Just after a presence+PIR window, confirmed follows presence && recent PIR.
  const sitting = sampleAt(34000, 1, { noise: false });
  assert.equal(sitting.confirmed, true);
  const idle = sampleAt(80000, 1, { noise: false });
  assert.equal(idle.presence, false);
  assert.equal(idle.confirmed, false);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
