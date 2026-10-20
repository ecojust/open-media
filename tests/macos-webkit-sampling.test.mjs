import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeSamplingWindowMiss, assertRealtimeSamplingWindow, createChromaMotionSamplingGate, sampleTransitionAfterSeek } from './fixtures/macos-webkit-frame.ts';

test('transition sampling retains the strict 200ms limit and records the observed clock', () => {
  assert.doesNotThrow(() => assertRealtimeSamplingWindow('transition-after-seek', 2.75, 2.949, .2));
  for (const actualTime of [2.95, 3.25, 3.75]) {
    assert.throws(() => assertRealtimeSamplingWindow('transition-after-seek', 2.75, actualTime, .2), error => {
      assert.ok(error instanceof RealtimeSamplingWindowMiss);
      assert.equal(error.requestedTime, 2.75); assert.equal(error.actualTime, actualTime);
      assert.equal(error.maxLateness, .2); assert.match(error.message, /RAF missed the transition sampling window/);
      return true;
    });
  }
});

test('a timely initial playing seek succeeds once without adding pre-roll', async () => {
  const attempts = [], events = [];
  await sampleTransitionAfterSeek(async attempt => {
    attempts.push(attempt);
    assertRealtimeSamplingWindow(attempt.label, attempt.time, 2.8, attempt.maxLateness);
  }, event => events.push(event));
  assert.equal(attempts.length, 1); assert.equal(attempts[0].start, 2.5);
  assert.equal(attempts[0].time, 2.75); assert.equal(attempts[0].maxLateness, .2);
  assert.deepEqual(events.map(event => event.status), ['started', 'passed']);
});

test('missed windows retry bounded real pre-roll with the same transition sample and lateness limit', async () => {
  const attempts = [], events = [];
  await sampleTransitionAfterSeek(async attempt => {
    attempts.push(attempt);
    assert.equal(attempt.time, 2.75); assert.equal(attempt.maxLateness, .2);
    assertRealtimeSamplingWindow(attempt.label, attempt.time, attempt.attempt < 3 ? 3.25 : 2.81, attempt.maxLateness);
  }, event => events.push(event));
  assert.deepEqual(attempts.map(attempt => attempt.start), [2.5, 2.25, 1.75]);
  assert.deepEqual(events.map(event => event.status), ['started', 'missed-window', 'started', 'missed-window', 'started', 'passed']);
  assert.equal(events[1].observedTime, 3.25); assert.equal(events[1].delayMilliseconds, 500);
  assert.equal(events.at(-1).attempt, 3); assert.equal(events.at(-1).maxAttempts, 3);
});

test('three missed windows still fail with all attempts visible', async () => {
  const events = [];
  await assert.rejects(sampleTransitionAfterSeek(async attempt => {
    assertRealtimeSamplingWindow(attempt.label, attempt.time, 3.75, attempt.maxLateness);
  }, event => events.push(event)), RealtimeSamplingWindowMiss);
  assert.equal(events.length, 6);
  assert.deepEqual(events.filter(event => event.status === 'missed-window').map(event => event.attempt), [1, 2, 3]);
  assert.ok(!events.some(event => event.status === 'passed'));
});

test('pixel and renderer failures, cancellation and decoder stalls are never retried', async () => {
  for (const error of [new Error('video and transition: actual pixels differ'), new Error('Realtime renderer reported errors'),
    new Error('realtime playback samples timed out'), new DOMException('Cancelled', 'AbortError'),
    new RealtimeSamplingWindowMiss('fade-in', 3.25, 3.7, .2)]) {
    let calls = 0; const events = [];
    await assert.rejects(sampleTransitionAfterSeek(async () => { calls++; throw error; }, event => events.push(event)), actual => actual === error);
    assert.equal(calls, 1); assert.equal(events.at(-1).status, 'failed');
  }
});

test('a pixel failure after an allowed timing retry remains a failure', async () => {
  const events = []; let calls = 0;
  const pixelFailure = new Error('moving text background and opacity: actual pixels differ');
  await assert.rejects(sampleTransitionAfterSeek(async attempt => {
    calls++;
    if (calls === 1) assertRealtimeSamplingWindow(attempt.label, attempt.time, 3.5, attempt.maxLateness);
    throw pixelFailure;
  }, event => events.push(event)), error => error === pixelFailure);
  assert.equal(calls, 2);
  assert.deepEqual(events.map(event => event.status), ['started', 'missed-window', 'started', 'failed']);
});

const layer = (currentTime, overrides = {}) => ({ source: 'asset://localhost/fixture.mp4', currentTime, paused: false, seeking: false, readyState: 4, width: 160, error: null, ...overrides });
const label = 'chroma-watermark-motion';

test('chroma recovery does not change the first chroma sample or any other checkpoint', () => {
  const events = [], gate = createChromaMotionSamplingGate(event => events.push(event));
  for (const name of ['chroma-watermark', 'color-filter', 'fade-out', 'transition-after-seek']) {
    assert.equal(gate(name, 1.4, 100, {}), true);
  }
  assert.deepEqual(events, []);
});

test('already synchronized playback and small in-flight seeks keep the original sampling behavior', () => {
  const events = [], gate = createChromaMotionSamplingGate(event => events.push(event));
  assert.equal(gate(label, 1.4, 100, { source: layer(1.35), watermark: layer(1.38) }), true);
  assert.equal(gate(label, 1.4, 200, { source: layer(1.35, { seeking: true }), watermark: layer(1.38) }), true);
  assert.deepEqual(events, [], 'No recovery budget is granted without an active, excessive-drift seek');
});

test('the .4 second drift boundary remains exclusive and only an active seek may enter recovery there', () => {
  for (const seeking of [false, true]) {
    const events = [], gate = createChromaMotionSamplingGate(event => events.push(event));
    const media = { source: layer(0), watermark: layer(.4, { seeking }) };
    if (seeking) {
      assert.equal(gate(label, 0, 100, media), false);
      assert.equal(events[0].status, 'entered');
      assert.throws(() => gate(label, 0, 200, { source: layer(0), watermark: layer(.4) }), /not synchronized/);
    } else {
      assert.throws(() => gate(label, 0, 100, media), /not synchronized/);
      assert.equal(events[0].status, 'failed');
    }
  }
});

test('the observed two-layer seek gets one fixed deadline and only resumes after both layers settle', () => {
  const events = [], gate = createChromaMotionSamplingGate(event => events.push(event));
  const initial = { source: layer(1.133, { seeking: true }), watermark: layer(.924, { seeking: true }) };
  assert.equal(gate(label, 1.471, 100, initial, 31), false);
  assert.equal(gate(label, 1.7, 329, { source: layer(1.68), watermark: layer(1.6, { seeking: true }) }, 17), false,
    'The watermark is now within .4s but the already-armed gate still waits for seek completion');
  assert.equal(gate(label, 1.9, 529, { source: layer(1.85), watermark: layer(1.83) }, 4), true);
  assert.deepEqual(events.map(event => event.status), ['entered', 'recovered']);
  assert(events.every(event => event.started === 100 && event.deadline === 1100));
  assert.equal(events[1].elapsedMilliseconds, 429);
  assert.equal(events[0].media[1].currentTime, .924);
  assert.equal(events[0].renderMilliseconds, 31);
  assert.equal(events[1].renderMilliseconds, 4);
});

test('another active seek cannot renew the recovery deadline, and deadline expiry fails even if frames just became ready', () => {
  for (const recoveredAtDeadline of [false, true]) {
    const events = [], gate = createChromaMotionSamplingGate(event => events.push(event));
    assert.equal(gate(label, 1.5, 100, { source: layer(1.5), watermark: layer(.9, { seeking: true }) }), false);
    assert.equal(gate(label, 2.2, 800, { source: layer(1.6, { seeking: true }), watermark: layer(2.1, { seeking: true }) }), false);
    const current = recoveredAtDeadline ? { source: layer(2.5), watermark: layer(2.5) }
      : { source: layer(1.6, { seeking: true }), watermark: layer(2.1, { seeking: true }) };
    assert.throws(() => gate(label, 2.5, 1100, current), /fixed 1000ms deadline/);
    assert.deepEqual(events.map(event => event.status), ['entered', 'timeout']);
    assert.equal(events[1].started, 100); assert.equal(events[1].deadline, 1100);
    assert.equal(events[1].elapsedMilliseconds, 1000);
  }
});

test('paused, errored, absent and non-seeking desynchronized media fail immediately before or during recovery', () => {
  const failures = [undefined, layer(.9), layer(1.5, { paused: true }), layer(1.5, { error: 'decode failed' }),
    layer(1.5, { width: 0 }), layer(1.5, { readyState: 1 }), layer(NaN, { seeking: true })];
  for (const waiting of [false, true]) for (const broken of failures) for (const role of ['source', 'watermark']) {
    const events = [], gate = createChromaMotionSamplingGate(event => events.push(event));
    if (waiting) assert.equal(gate(label, 1.5, 100, { source: layer(1.5), watermark: layer(.9, { seeking: true }) }), false);
    const media = { source: layer(1.5), watermark: layer(1.5), [role]: broken };
    assert.throws(() => gate(label, 1.5, 120, media));
    assert.equal(events.at(-1).status, 'failed');
    assert.equal(events.filter(event => event.status === 'entered').length, waiting ? 1 : 0);
  }
});

test('seek readiness may recover inside the deadline but a settled out-of-sync layer fails despite the other pending seek', () => {
  const events = [], gate = createChromaMotionSamplingGate(event => events.push(event));
  assert.equal(gate(label, 1.5, 100, { source: layer(1.5), watermark: layer(.9, { seeking: true, readyState: 1 }) }), false);
  assert.equal(gate(label, 1.7, 300, { source: layer(1.65), watermark: layer(1.6, { seeking: true, readyState: 2 }) }), false);
  assert.throws(() => gate(label, 1.8, 400, { source: layer(1.2), watermark: layer(1.75, { seeking: true }) }), /source is not synchronized/);
  assert.deepEqual(events.map(event => event.status), ['entered', 'failed']);
});
