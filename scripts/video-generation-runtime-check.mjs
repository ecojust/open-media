import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const runner = resolve(process.argv[2] ?? '');
assert.equal(basename(runner), 'open-media-video-generation');
const out = resolve(process.env.VIDEO_GENERATION_CHECK_OUT ?? '.video-generation-check');
await mkdir(out, { recursive: true });
const evidence = { platform: process.platform, arch: process.arch, runner, device: null,
  requestValidation: false, modelConfigurationValidation: false,
  gpuComputation: 'not-run', actualModelGeneration: 'not-run' };
const run = (args, timeout = 120_000) => {
  const result = spawnSync(runner, args, { cwd: dirname(runner), encoding: 'utf8', timeout });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    error: result.error?.message, signal: result.signal };
};
const parse = result => result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function validateModelConfigurations() {
  const modelDir = join(out, 'configuration-fixture');
  const videoPath = join(modelDir, 'FL2VA/video_vae/config.json');
  const sourcePath = join(modelDir, 'FL2VA/video_vae/source/config.json');
  const audioPath = join(modelDir, 'FL2VA/audio_vae/config.json');
  const normalization = channels => ({ latents_mean: Array(channels).fill(0), latents_std: Array(channels).fill(1) });
  const writeConfig = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const expectInvalid = (family, expression) => {
    const result = run(['--check-model-configs', modelDir, family], 10_000);
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.ok(parse(result).some(event => event.type === 'error' && expression.test(event.message)), result.stdout);
  };
  const expectValid = family => {
    const result = run(['--check-model-configs', modelDir, family], 10_000);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(parse(result).some(event => event.type === 'configuration-check' && event.family === family && event.valid === true));
  };
  try {
    await rm(modelDir, { recursive: true, force: true });
    // The source architecture config must never substitute for normalization in its parent.
    await writeConfig(sourcePath, normalization(24));
    await writeConfig(audioPath, normalization(32));
    expectInvalid('FL2VA', /FL2VA\/video_vae\/config\.json/);
    const requestFile = join(out, 'missing-normalization-request.json');
    await writeFile(requestFile, JSON.stringify({ modelDir, outputPath: join(out, 'unused.mp4'), prompt: '验证配置' }));
    const missing = run(['--request', requestFile], 10_000);
    assert.equal(missing.status, 1, `${missing.stderr}\n${missing.stdout}`);
    const events = parse(missing);
    assert.ok(events.some(event => event.type === 'error' && /FL2VA\/video_vae\/config\.json/.test(event.message)));
    assert.ok(events.some(event => event.type === 'progress' && event.stage === 'model configuration'));
    assert.ok(!events.some(event => event.type === 'progress' && event.stage === 'loading'), 'bad configuration must fail before loading weights');
    for (const [value, expression] of [
      ['{', /JSON object/],
      [[], /JSON object/],
      [{}, /latents_mean/],
      [{ ...normalization(24), latents_mean: Array(23).fill(0) }, /latents_mean/],
      [{ ...normalization(24), latents_std: Array(25).fill(1) }, /latents_std/],
      [{ ...normalization(24), latents_mean: Array(24).fill('0') }, /latents_mean/],
      [{ ...normalization(24), latents_mean: Array(24).fill(1e39) }, /latents_mean/],
      [{ ...normalization(24), latents_mean: Array(24).fill(1e-50) }, /latents_mean/],
      [{ ...normalization(24), latents_std: Array(24).fill(true) }, /latents_std/],
      [{ ...normalization(24), latents_std: Array(24).fill(0) }, /latents_std/],
      [{ ...normalization(24), latents_std: Array(24).fill(-1) }, /latents_std/],
      [{ ...normalization(24), latents_std: Array(24).fill(1e-50) }, /latents_std/],
      [' '.repeat(1024 * 1024 + 1), /configuration size/],
    ]) {
      await writeConfig(videoPath, value);
      expectInvalid('FL2VA', expression);
    }
    await writeConfig(videoPath, normalization(24));
    expectValid('FL2VA');
    await writeConfig(audioPath, normalization(24));
    expectInvalid('FL2VA', /latents_mean.*FL2VA\/audio_vae\/config\.json/);
    await writeConfig(audioPath, normalization(32));
    expectInvalid('Ref2VA', /Ref2VA\/video_vae\/config\.json/);
    await writeConfig(join(modelDir, 'Ref2VA/video_vae/config.json'), normalization(24));
    expectInvalid('Ref2VA', /Ref2VA\/audio_vae\/config\.json/);
    await writeConfig(join(modelDir, 'Ref2VA/audio_vae/config.json'), normalization(32));
    expectValid('Ref2VA');
    // A broken optional reference model must not block base generation.
    await writeConfig(join(modelDir, 'Ref2VA/video_vae/config.json'), '{}');
    expectValid('FL2VA');
    expectInvalid('Ref2VA', /latents_mean.*Ref2VA\/video_vae\/config\.json/);
    evidence.modelConfigurationValidation = true;
  } finally {
    await rm(modelDir, { recursive: true, force: true });
  }
}
try {
  assert.equal(process.platform, 'darwin', 'native check requires macOS');
  assert.equal(process.arch, 'arm64', 'native check requires Apple Silicon');
  const badRequest = join(out, 'invalid-request.json');
  await writeFile(badRequest, JSON.stringify({ modelDir: 'relative', outputPath: 'relative', prompt: '验证' }));
  const invalid = run(['--request', badRequest]);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.ok(parse(invalid).some(event => event.type === 'error' && /absolute/.test(event.message)));
  evidence.requestValidation = true;
  await validateModelConfigurations();
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
  const summary = JSON.stringify({ requestValidation: evidence.requestValidation, modelConfigurationValidation: evidence.modelConfigurationValidation, gpuComputation: evidence.gpuComputation, device: evidence.device?.device ?? null, actualModelGeneration: evidence.actualModelGeneration })
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::notice title=Video generation verification::${summary}`);
}
