import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.speech-runtime');
const lockPath = join(root, 'scripts/speech-runtime.lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const target = flag('--target', `${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`);
const output = resolve(flag('--directory', join(root, 'src-tauri/resources/speech')));
const executableRoot = resolve(flag('--executable-directory', output));
const packaged = process.argv.includes('--packaged');
const extension = target.startsWith('windows-') ? '.exe' : '';
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
let archiveTool;
function archive(args) {
  const options = { timeout: 600000 };
  if (process.platform !== 'win32') return run('tar', args, options);
  if (!archiveTool) {
    const candidates = ['tar', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'tar.exe')];
    const command = candidates.find(candidate => {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 });
      return result.status === 0 && result.stdout.includes('GNU tar');
    });
    archiveTool = { command: command ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), gnu: !!command };
  }
  // A GNU archive tool treats D: as a remote host unless explicitly disabled.
  if (archiveTool.gnu) {
    args = ['--force-local', ...args.map(value => value.replaceAll('\\', '/'))];
    if (archiveTool.command !== 'tar') {
      options.env = { ...process.env };
      const key = Object.keys(options.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
      options.env[key] = `${dirname(archiveTool.command)};${options.env[key] ?? ''}`;
    }
  }
  return run(archiveTool.command, args, options);
}
async function download(source) {
  const directory = join(cache, 'downloads');
  await mkdir(directory, { recursive: true });
  const destination = join(directory, source.archive);
  if (await exists(destination)) {
    if (await sha256(destination) === source.sha256) return destination;
    throw new Error(`Cached speech archive checksum mismatch: ${source.archive}`);
  }
  const temporary = `${destination}.partial`;
  try {
    console.log(`Downloading speech resource: ${source.id}`);
    run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--retry-all-errors', '--connect-timeout', '30', '--max-time', '300', '--output', temporary, source.url], { timeout: 1200000 });
    if (await sha256(temporary) !== source.sha256) throw new Error(`Speech archive checksum mismatch: ${source.archive}`);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return destination;
}
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Speech resources must contain regular files: ${path}`);
  }
  return result.sort();
}
async function resourcePermissions(directory, prefix = '') {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await resourcePermissions(join(directory, entry.name), path);
    else if (entry.isFile()) await chmod(join(directory, entry.name), path.startsWith('runtime/') ? 0o755 : 0o644);
    else throw new Error(`Speech resources must contain regular files: ${path}`);
  }
}
function safePath(base, path) {
  if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(path)) throw new Error(`Unsafe speech resource path: ${path}`);
  const result = resolve(base, path);
  if (relative(base, result).startsWith('..')) throw new Error(`Speech resource escapes directory: ${path}`);
  return result;
}
async function verifyLicenses() {
  const directory = join(root, 'licenses/speech-runtime');
  const inventory = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (!inventory.files.length) throw new Error('Speech license inventory is empty.');
  for (const file of inventory.files) {
    if (!lock.sources.some(source => source.id === file.sourceId)) throw new Error(`Unknown license source: ${file.sourceId}`);
    if (await sha256(safePath(directory, file.path)) !== file.sha256) throw new Error(`Original speech license changed: ${file.path}`);
  }
}
async function prepare() {
  await verifyLicenses();
  const runtimeSource = lock.sources.find(source => source.kind === 'runtime' && source.target === target);
  const modelSource = lock.sources.find(source => source.kind === 'model');
  if (!runtimeSource || !modelSource) throw new Error(`Unsupported speech target: ${target}`);
  const hostTarget = `${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  if (target !== hostTarget) throw new Error('Prepare speech resources on the target host so the executable is compiled and tested for that host.');
  const extracted = join(cache, 'extracted', target);
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  for (const source of [runtimeSource, modelSource]) archive(['-xf', await download(source), '-C', extracted]);
  const source = join(extracted, runtimeSource.directory);
  for (const item of ['runtime', 'model', 'licenses']) await rm(join(output, item), { recursive: true, force: true });
  await mkdir(join(output, 'runtime/bin'), { recursive: true });
  await mkdir(join(output, 'runtime/lib'), { recursive: true });
  await cp(join(extracted, modelSource.directory), join(output, 'model'), { recursive: true });
  await cp(join(root, 'licenses/speech-runtime'), join(output, 'licenses'), { recursive: true });
  const libraries = process.platform === 'win32'
    ? ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll']
    : process.platform === 'darwin'
      ? ['libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib']
      : ['libonnxruntime.so', 'libsherpa-onnx-c-api.so'];
  for (const library of libraries) {
    const destination = join(output, `runtime/${process.platform === 'win32' ? 'bin' : 'lib'}`, library);
    await copyFile(join(source, 'lib', library), destination);
    await chmod(destination, 0o755);
  }
  const executable = `runtime/bin/open-media-speech${extension}`;
  const build = join(cache, 'runner-build', target);
  await mkdir(build, { recursive: true });
  const runner = join(root, 'scripts/speech-runtime-runner.c');
  if (process.platform === 'win32') {
    run('cl.exe', ['/nologo', '/O2', '/MT', '/utf-8', '/std:c11', `/I${join(source, 'include')}`, runner,
      `/Fe:${join(output, executable)}`, `/Fo:${join(build, 'runner.obj')}`, join(source, 'lib/sherpa-onnx-c-api.lib'),
      '/link', '/MANIFEST:EMBED', `/MANIFESTINPUT:${join(root, 'scripts/speech-runtime-runner.manifest')}`], { cwd: build });
  } else {
    run(process.env.CC ?? 'cc', ['-O2', '-std=c11', ...(process.platform === 'darwin' ? ['-mmacosx-version-min=13.0'] : []), '-I', join(source, 'include'), runner,
      '-L', join(source, 'lib'), '-lsherpa-onnx-c-api',
      `-Wl,-rpath,${process.platform === 'darwin' ? '@executable_path' : '$ORIGIN'}/../lib`,
      '-o', join(output, executable)], { cwd: build });
    await chmod(join(output, executable), 0o755);
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify({
    schema: 1, version: lock.engine.version, executable, input: 'utf8-file',
    model: { file: 'model/model.int8.onnx', voices: 'model/voices.bin', tokens: 'model/tokens.txt',
      dataDir: 'model/espeak-ng-data', lexicons: ['model/lexicon-us-en.txt', 'model/lexicon-zh.txt'],
      ruleFsts: ['model/date-zh.fst', 'model/number-zh.fst', 'model/phone-zh.fst'], sampleRate: 24000 },
    voices: lock.voices,
  }, null, 2) + '\n');
  await copyFile(lockPath, join(output, 'source-lock.json'));
  const inventory = [];
  for (const path of await files(output)) {
    if (path === 'runtime.json' || path === 'README.md' || path === '.gitkeep') continue;
    inventory.push({ path, sha256: await sha256(join(output, path)), kind: path.startsWith('runtime/') ? 'binary' : path.startsWith('licenses/') ? 'license' : path.startsWith('model/') ? 'model' : 'metadata' });
  }
  await writeFile(join(output, 'runtime.json'), JSON.stringify({
    schema: 1, platform: process.platform, arch: process.arch, model: lock.model,
    sourceLockSha256: await sha256(lockPath), prepareScriptSha256: await sha256(fileURLToPath(import.meta.url)),
    runnerSourceSha256: await sha256(runner), runnerManifestSha256: await sha256(join(root, 'scripts/speech-runtime-runner.manifest')),
    files: inventory, licenses: inventory.filter(file => file.kind === 'license'),
  }, null, 2) + '\n');
  // Upstream archives use owner-only modes; installed shared applications must
  // permit every local user to read the model without granting write access.
  await resourcePermissions(output);
  await rm(extracted, { recursive: true, force: true });
  console.log(`Bundled offline speech prepared: ${target}, ${lock.voices.length} voices.`);
}
function inspectWave(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Speech output is not a WAV file.');
  let format, pcm;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error('Speech output is truncated.');
    if (id === 'fmt ') format = bytes.subarray(offset + 8, offset + 8 + size);
    if (id === 'data') pcm = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!format || format.length < 16 || !pcm || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 24000 || format.readUInt16LE(14) !== 16 || pcm.length < 12000) throw new Error('Speech output must be non-empty 24 kHz mono PCM16.');
  let energy = 0, peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const value = pcm.readInt16LE(i); energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  if (Math.sqrt(energy / (pcm.length / 2)) < 30 || peak < 500) throw new Error('Generated speech contains no audible samples.');
  return { duration: pcm.length / 48000, sha256: createHash('sha256').update(pcm).digest('hex') };
}
function verifyMacBinary(bytes, path) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`Unexpected speech executable format: ${path}`);
  const expectedCpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007;
  if (bytes.readUInt32LE(4) !== expectedCpu) throw new Error(`Speech executable architecture mismatch: ${path}`);
  let offset = 32, minimum;
  for (let index = 0; index < bytes.readUInt32LE(16); index++) {
    if (offset + 8 > bytes.length) throw new Error(`Truncated executable load commands: ${path}`);
    const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > bytes.length) throw new Error(`Invalid executable load command: ${path}`);
    if (command === 0x32 || command === 0x24) {
      if (size < (command === 0x32 ? 24 : 16)) throw new Error(`Invalid executable minimum system version: ${path}`);
      minimum = bytes.readUInt32LE(offset + (command === 0x32 ? 12 : 8));
    }
    offset += size;
  }
  if (!minimum || minimum > 0x000d0000) throw new Error(`Speech executable requires a system newer than macOS 13.0: ${path}`);
}
async function verify() {
  await verifyLicenses();
  const inventory = JSON.parse(await readFile(join(output, 'runtime.json'), 'utf8'));
  const expected = { sourceLockSha256: await sha256(lockPath), prepareScriptSha256: await sha256(fileURLToPath(import.meta.url)), runnerSourceSha256: await sha256(join(root, 'scripts/speech-runtime-runner.c')), runnerManifestSha256: await sha256(join(root, 'scripts/speech-runtime-runner.manifest')) };
  for (const [key, value] of Object.entries(expected)) if (inventory[key] !== value) throw new Error(`Speech build provenance mismatch: ${key}`);
  if (inventory.platform !== process.platform || inventory.arch !== process.arch) throw new Error('Speech runtime does not match this host.');
  if (JSON.stringify(inventory.model) !== JSON.stringify(lock.model)) throw new Error('Unexpected speech model.');
  if (!inventory.files.length || !inventory.licenses.length) throw new Error('Speech inventory is incomplete.');
  const seen = new Set();
  for (const item of inventory.files) {
    if (seen.has(item.path)) throw new Error(`Duplicate speech inventory path: ${item.path}`);
    seen.add(item.path);
    const location = safePath(item.kind === 'binary' ? executableRoot : output, item.path);
    if (!await exists(location)) throw new Error(`Missing speech resource: ${item.path}`);
    if (!(packaged && process.platform === 'darwin' && item.kind === 'binary') && await sha256(location) !== item.sha256) throw new Error(`Speech resource checksum mismatch: ${item.path}`);
    if (process.platform === 'darwin' && item.kind === 'binary') verifyMacBinary(await readFile(location), item.path);
  }
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  if (manifest.voices.length !== lock.voices.length || JSON.stringify(manifest.voices) !== JSON.stringify(lock.voices)) throw new Error('Bundled voice mapping changed.');
  const executable = safePath(executableRoot, manifest.executable);
  const directory = join(cache, 'verification', '中文 语音');
  await mkdir(directory, { recursive: true });
  const model = manifest.model;
  const results = [];
  for (const [sid, text] of [[3, '你好，这是离线语音。今天是2026年10月16日。'], [59, '你好，这是离线语音。今天是2026年10月16日。'], [0, 'Welcome. This voice is generated locally.']]) {
    const textFile = join(directory, `文字-${sid}.txt`), waveFile = join(directory, `声音-${sid}.wav`);
    await writeFile(textFile, text, 'utf8');
    const log = run(executable, [`--kokoro-model=${model.file}`, `--kokoro-voices=${model.voices}`, `--kokoro-tokens=${model.tokens}`, `--kokoro-data-dir=${model.dataDir}`, `--kokoro-lexicon=${model.lexicons.join(',')}`, `--tts-rule-fsts=${model.ruleFsts.join(',')}`, `--sid=${sid}`, '--speed=1', `--output-filename=${waveFile}`, `--text-file=${textFile}`, '--debug=true'], { cwd: output });
    if (!log.includes(`speakers=${lock.voices.length}, text_bytes=${Buffer.byteLength(text)}`) || !/progress=1\.000000/.test(log) || !log.includes('stage=complete')) throw new Error('Speech process did not confirm complete text and model processing.');
    // Verify the model's own tokenization received Chinese characters unchanged,
    // including on hosts whose default system code page is not UTF-8.
    if (sid !== 0 && !log.includes('你好')) throw new Error('Chinese text did not reach the speech model intact.');
    const result = inspectWave(await readFile(waveFile));
    results.push(result);
    console.log(`Verified voice ${sid}: ${result.duration.toFixed(3)} s, audible PCM, UTF-8 input intact.`);
  }
  if (results[0].sha256 === results[1].sha256) throw new Error('Different bundled voices produced identical audio.');
  console.log(`Offline speech verified on ${process.platform}/${process.arch}.`);
}
async function sources() {
  await verifyLicenses();
  for (const source of lock.sources) await download(source);
  const stage = join(cache, 'source-package'), bundle = join(stage, 'speech-runtime-source');
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(bundle, '.speech-runtime/downloads'), { recursive: true });
  for (const source of lock.sources) await copyFile(join(cache, 'downloads', source.archive), join(bundle, '.speech-runtime/downloads', source.archive));
  for (const path of ['scripts/speech-runtime.mjs', 'scripts/speech-runtime.lock.json', 'scripts/speech-runtime-runner.c', 'scripts/speech-runtime-runner.manifest', 'docs/SPEECH_RUNTIME.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) {
    await mkdir(dirname(join(bundle, path)), { recursive: true });
    await copyFile(join(root, path), join(bundle, path));
  }
  await cp(join(root, 'licenses/speech-runtime'), join(bundle, 'licenses/speech-runtime'), { recursive: true });
  await writeFile(join(bundle, 'README.txt'), 'Open Media offline speech: complete corresponding source and build inputs.\n\nAll original engine sources, corresponding upstream build workflows, CPU runtime dependencies, model weights and voice data are supplied in .speech-runtime/downloads. SHA256 values, origin URLs and exact revisions are recorded in scripts/speech-runtime.lock.json. Original license and attribution texts are retained in licenses/speech-runtime and in every source archive.\n\nThe independent speech helper is GPL-3.0-or-later. Its source and exact compiler/linker invocation are included. See docs/SPEECH_RUNTIME.md for rebuilding and installation details. Run node scripts/speech-runtime.mjs prepare followed by verify to reproduce the packaged helper and model resources from the supplied verified runtime archives.\n');
  const destination = resolve(flag('--output', join(root, 'speech-runtime-source.tar.gz')));
  await mkdir(dirname(destination), { recursive: true });
  archive(['-czf', destination, '-C', stage, 'speech-runtime-source']);
  console.log(`Speech corresponding source: ${destination}\nSHA256 ${await sha256(destination)}`);
}

const command = process.argv[2] ?? 'prepare';
if (command === 'prepare') await prepare();
else if (command === 'verify') await verify();
else if (command === 'sources') await sources();
else if (command === 'licenses') await verifyLicenses();
else throw new Error(`Unknown speech runtime command: ${command}`);
