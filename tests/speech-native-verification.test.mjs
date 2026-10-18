import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeDeviceState, runNativeSpeech, shouldRetryNativeCpu } from '../scripts/speech-runtime.mjs';

test('native verification only retries a failed current CoreML attempt before writing', () => {
  const device = 'stage=device,device=coreml,engine=matcha\n';
  const failed = { status: 4, signal: null, stdout: device, stderr: 'native failure' };
  assert.equal(shouldRetryNativeCpu(failed), true);
  assert.equal(shouldRetryNativeCpu({ ...failed, status: null, signal: 'SIGABRT' }), true);
  for (const value of [
    { ...failed, status: 0 }, { ...failed, error: new Error('timed out') },
    ...['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL'].map(signal => ({ ...failed, status: null, signal })),
    ...['stage=writing\n', 'stage=writing,bytes=1\n', 'stage=complete\n',
      'stage=device,device=cpu\n', 'stage=device,device=unknown\n',
      'stage=fallback,from=coreml,device=cpu,reason=unavailable\n'].map(suffix => ({ ...failed, stdout: device + suffix })),
    { ...failed, stdout: '', stderr: device },
  ]) assert.equal(shouldRetryNativeCpu(value), false, JSON.stringify(value));
  assert.equal(shouldRetryNativeCpu(failed, true), false);
  assert.deepEqual(nativeDeviceState(device + 'stage=writing\nstage=device,device=cpu\n'), { backend: 'cpu', writing: false });
});

const stub = `
const fs = require('node:fs');
const cpu = process.argv.includes('--provider=cpu');
const output = process.argv.find(arg => arg.startsWith('--output-filename=')).slice(18);
fs.appendFileSync(process.env.NATIVE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (cpu) {
  if (fs.existsSync(output)) throw new Error('partial GPU audio was not removed');
  console.log('stage=device,device=cpu');
  if (process.env.NATIVE_MODE === 'both-fail') { console.error('CPU failure'); process.exit(4); }
  fs.writeFileSync(output, 'CPU test output');
  console.log('stage=writing\\nstage=complete');
} else {
  console.log('stage=device,device=coreml');
  if (process.env.NATIVE_MODE === 'timeout') { setTimeout(() => {}, 10000); }
  else {
    fs.writeFileSync(output, 'incomplete GPU test output');
    if (process.env.NATIVE_MODE === 'writing') console.log('stage=writing');
    console.error('original CoreML failure'); process.exit(4);
  }
}
`;

async function fixture(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'speech-native-verification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'process.cjs'), audio = join(directory, 'output.wav');
  const calls = join(directory, 'calls.jsonl'), log = join(directory, 'generation.log');
  await writeFile(script, stub);
  return { audio, calls, log, run: (timeout = 3000) => runNativeSpeech(process.execPath,
    [script, '--provider=coreml', `--output-filename=${audio}`], audio, log,
    { timeout, env: { ...process.env, NATIVE_MODE: mode, NATIVE_CALLS: calls } }) };
}

test('native verification records CoreML failure and one successful CPU retry', async t => {
  const sample = await fixture(t, 'fallback');
  const result = await sample.run();
  assert.equal(result.execution.backend, 'cpu');
  assert.equal(result.execution.fallbackFrom, 'coreml');
  assert.equal(result.execution.attempts.length, 2);
  assert.equal(result.execution.attempts[0].error, 'original CoreML failure');
  assert.equal(await readFile(sample.audio, 'utf8'), 'CPU test output');
  const calls = (await readFile(sample.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('--provider=cpu'));
  assert.ok(!calls[1].includes('--provider=coreml'));
  const log = await readFile(sample.log, 'utf8');
  assert.match(log, /original CoreML failure[\s\S]*stage=fallback[\s\S]*device=cpu/);
});

test('native verification does not retry output-write failures', async t => {
  const sample = await fixture(t, 'writing');
  await assert.rejects(sample.run(), /Native speech failed/);
  assert.equal((await readFile(sample.calls, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(readFile(sample.audio), { code: 'ENOENT' });
});

test('native verification never loops when the CPU retry also fails', async t => {
  const sample = await fixture(t, 'both-fail');
  await assert.rejects(sample.run(), /CPU failure/);
  assert.equal((await readFile(sample.calls, 'utf8')).trim().split('\n').length, 2);
  assert.match(await readFile(sample.log, 'utf8'), /original CoreML failure[\s\S]*CPU failure/);
});

test('native verification preserves timeout failure without starting a CPU retry', async t => {
  const sample = await fixture(t, 'timeout');
  await assert.rejects(sample.run(200), /Native speech failed/);
  const log = await readFile(sample.log, 'utf8');
  assert.doesNotMatch(log, /stage=fallback/);
  assert.equal((await readFile(sample.calls, 'utf8')).trim().split('\n').length, 1);
});
