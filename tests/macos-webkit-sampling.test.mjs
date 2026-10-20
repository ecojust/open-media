import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeSamplingWindowMiss, assertRealtimeSamplingWindow, sampleTransitionAfterSeek } from './fixtures/macos-webkit-frame.ts';

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
