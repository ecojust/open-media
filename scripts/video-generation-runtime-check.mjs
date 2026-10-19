import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const runner = resolve(process.argv[2] ?? '');
assert.equal(basename(runner), 'open-media-video-generation');
const out = resolve(process.env.VIDEO_GENERATION_CHECK_OUT ?? '.video-generation-check');
await mkdir(out, { recursive: true });
const evidence = { platform: process.platform, arch: process.arch, runner, device: null,
  requestValidation: false, gpuComputation: 'not-run', actualModelGeneration: 'not-run' };
const run = (args, timeout = 120_000) => {
  const result = spawnSync(runner, args, { cwd: dirname(runner), encoding: 'utf8', timeout });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    error: result.error?.message, signal: result.signal };
};
const parse = result => result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
try {
  assert.equal(process.platform, 'darwin', 'native check requires macOS');
  assert.equal(process.arch, 'arm64', 'native check requires Apple Silicon');
  const badRequest = join(out, 'invalid-request.json');
  await writeFile(badRequest, JSON.stringify({ modelDir: 'relative', outputPath: 'relative', prompt: '验证' }));
  const invalid = run(['--request', badRequest]);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.ok(parse(invalid).some(event => event.type === 'error' && /absolute/.test(event.message)));
  evidence.requestValidation = true;
  const device = run(['--probe']);
  evidence.deviceProbe = device;
  if (device.status !== 0 && /no Metal device available/.test(device.stdout)) {
    evidence.gpuComputation = 'unavailable-no-metal-device';
    console.log('::warning::The runner compiled and validated requests, but this host has no Metal device. GPU execution and real model generation remain unverified.');
  } else {
    assert.equal(device.status, 0, `${device.stderr}\n${device.stdout}`);
    evidence.device = parse(device).find(event => event.type === 'device');
    assert.ok(evidence.device);
    const check = run(['--self-test'], 240_000);
    evidence.selfTest = check;
    assert.equal(check.status, 0, `${check.stderr}\n${check.stdout}`);
    assert.equal(parse(check).find(event => event.type === 'device')?.shaderTested, true);
    evidence.gpuComputation = 'passed';
  }
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  const summary = JSON.stringify({ requestValidation: evidence.requestValidation, gpuComputation: evidence.gpuComputation, device: evidence.device?.device ?? null, actualModelGeneration: evidence.actualModelGeneration })
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::notice title=Video generation verification::${summary}`);
}
