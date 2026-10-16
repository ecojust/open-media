import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.media-runtime');
const runtime = join(root, 'src-tauri/resources/media');
const lockPath = join(root, 'scripts/media-runtime.lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const binaryExtension = process.platform === 'win32' ? '.exe' : '';
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
let archiveCommand;
function runArchive(args) {
  const options = { timeout: 180000 };
  if (process.platform === 'win32') {
    if (!archiveCommand) {
      const candidates = ['tar', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'tar.exe')];
      archiveCommand = candidates.find(command => {
        const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000 });
        return result.status === 0 && result.stdout.includes('GNU tar');
      });
      if (!archiveCommand) throw new Error('Windows source extraction requires GNU tar with xz support. Run the source build commands in the build-tool shell.');
    }
    if (archiveCommand !== 'tar') {
      options.env = { ...process.env };
      const pathKey = Object.keys(options.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      options.env[pathKey] = `${dirname(archiveCommand)};${options.env[pathKey] ?? ''}`;
    }
    args = ['--force-local', ...args.map(value => value.replaceAll('\\', '/'))];
  }
  return run(archiveCommand ?? 'tar', args, options);
}
async function download(source) {
  const directory = join(cache, 'downloads');
  await mkdir(directory, { recursive: true });
  const destination = join(directory, source.archive);
  if (await exists(destination)) {
    if (await sha256(destination) === source.sha256) return destination;
    throw new Error(`Checksum mismatch in cached source: ${source.archive}. Remove this file and retry.`);
  }
  const partial = `${destination}.partial`;
  console.log(`Downloading ${source.id} ${source.version}`);
  try {
    run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--retry-all-errors', '--connect-timeout', '30', '--max-time', '180', '--output', partial, source.url]);
    if (await sha256(partial) !== source.sha256) throw new Error(`Downloaded source checksum mismatch: ${source.archive}`);
    await rename(partial, destination);
  } finally { await rm(partial, { force: true }); }
  return destination;
}
async function prepare() {
  for (const source of lock.sources) {
    const archive = await download(source);
    const directory = join(cache, 'sources', source.id);
    const marker = join(directory, '.open-media-source-sha256');
    if (await exists(marker) && (await readFile(marker, 'utf8')).trim() === source.sha256) continue;
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    console.log(`Extracting ${source.id} ${source.version}`);
    runArchive(['-xf', archive, '-C', directory, '--strip-components=1']);
    await writeFile(marker, `${source.sha256}\n`);
  }
  console.log('Verified media sources are ready.');
}
async function finalize() {
  await mkdir(runtime, { recursive: true });
  const binaries = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = `${name}${binaryExtension}`;
    await chmod(join(runtime, file), 0o755);
    binaries[file] = await sha256(join(runtime, file));
  }
  for (const source of lock.sources) {
    const from = join(cache, 'sources', source.id);
    const to = join(runtime, 'licenses', source.id);
    await mkdir(to, { recursive: true });
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (item.isFile() && /^(copying|license|authors|patents)([.\-_]|$)/i.test(item.name)) await copyFile(join(from, item.name), join(to, item.name));
    }
  }
  await copyFile(lockPath, join(runtime, 'source-lock.json'));
  await writeFile(join(runtime, 'runtime.json'), JSON.stringify({
    schema: 1, platform: process.platform, arch: process.arch, license: lock.license,
    sourceLockSha256: await sha256(lockPath),
    buildScriptSha256: await sha256(join(root, 'scripts/build-media-runtime.sh')),
    binaries, sources: lock.sources.map(({ id, version, license }) => ({ id, version, license })),
  }, null, 2) + '\n');
}
async function verify() {
  const manifest = JSON.parse(await readFile(join(runtime, 'runtime.json'), 'utf8'));
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Runtime platform does not match this build host.');
  if (manifest.sourceLockSha256 !== await sha256(lockPath) || manifest.buildScriptSha256 !== await sha256(join(root, 'scripts/build-media-runtime.sh'))) throw new Error('Runtime cache is stale; rebuild from the current source lock and script.');
  for (const [file, expected] of Object.entries(manifest.binaries)) if (await sha256(join(runtime, file)) !== expected) throw new Error(`Runtime binary checksum mismatch: ${file}`);
  const ffmpeg = join(runtime, `ffmpeg${binaryExtension}`);
  const ffprobe = join(runtime, `ffprobe${binaryExtension}`);
  const version = run(ffmpeg, ['-version']);
  if (!version.startsWith(`ffmpeg version ${lock.sources.find(source => source.id === 'ffmpeg').version}`)) throw new Error('Unexpected runtime version.');
  const encoders = run(ffmpeg, ['-hide_banner', '-encoders']);
  for (const encoder of ['libx264', 'libvpx-vp9', 'libopus', 'libmp3lame', 'libwebp', 'aac', 'png', 'mjpeg', 'gif', 'flac', 'pcm_s16le']) {
    if (!new RegExp(`\\s${encoder}\\s`).test(encoders)) throw new Error(`Missing required encoder: ${encoder}`);
  }
  const filters = run(ffmpeg, ['-hide_banner', '-filters']);
  for (const filter of ['scale', 'crop', 'pad', 'overlay', 'rotate', 'fade', 'afade', 'atempo', 'concat', 'palettegen', 'paletteuse', 'amix', 'adelay']) {
    if (!new RegExp(`\\s${filter}\\s`).test(filters)) throw new Error(`Missing required filter: ${filter}`);
  }
  const devices = run(ffmpeg, ['-hide_banner', '-devices']);
  for (const device of process.platform === 'darwin' ? ['avfoundation'] : process.platform === 'win32' ? ['gdigrab', 'dshow'] : []) {
    if (!new RegExp(`\\s${device}\\s`).test(devices)) throw new Error(`Missing required recording device: ${device}`);
  }
  const directory = join(cache, 'verification');
  await mkdir(directory, { recursive: true });
  const pixels = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=64x64', '-vf', 'format=rgba,format=yuv420p', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1024 * 1024 });
  if (pixels.error || pixels.status !== 0 || pixels.stdout.length !== 64 * 64 * 3) throw new Error('Bundled runtime failed its RGBA conversion check.');
  for (const offset of [0, 32 * 64 * 3, (64 * 64 - 1) * 3]) {
    const [red, green, blue] = pixels.stdout.subarray(offset, offset + 3);
    if (red < 220 || green < 220 || blue > 40) throw new Error(`Bundled runtime changed yellow pixels during RGBA conversion: ${red}, ${green}, ${blue}.`);
  }
  const movie = join(directory, 'sample.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x456be8:s=64x64:r=10:d=0.3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', movie]);
  const info = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', movie]));
  if (!info.streams.some(stream => stream.codec_name === 'h264') || !info.streams.some(stream => stream.codec_name === 'aac')) throw new Error('Packaged runtime failed its video and audio encoding check.');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', movie, '-frames:v', '1', join(directory, 'sample.png')]);
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', movie, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', join(directory, 'sample.webm')]);
  console.log(`Verified bundled runtime on ${process.platform}/${process.arch}.`);
}
async function sources() {
  await prepare();
  const index = process.argv.indexOf('--output');
  const output = resolve(root, index >= 0 ? process.argv[index + 1] : 'media-runtime-source.tar.gz');
  const stage = join(cache, 'source-package');
  const bundle = join(stage, 'media-runtime-source');
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(bundle, '.media-runtime/downloads'), { recursive: true });
  for (const source of lock.sources) await copyFile(join(cache, 'downloads', source.archive), join(bundle, '.media-runtime/downloads', source.archive));
  for (const file of ['scripts/media-runtime.mjs', 'scripts/media-runtime.lock.json', 'scripts/build-media-runtime.sh', 'docs/MEDIA_RUNTIME.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) {
    await mkdir(dirname(join(bundle, file)), { recursive: true });
    await copyFile(join(root, file), join(bundle, file));
  }
  await writeFile(join(bundle, 'README.txt'), 'Open Media bundled media tools: complete corresponding source\n\nAll original source archives are included in .media-runtime/downloads.\nNo media sources are patched. See docs/MEDIA_RUNTIME.md for prerequisites.\nRun: node scripts/media-runtime.mjs prepare\nThen: bash scripts/build-media-runtime.sh\n\nThe build scripts and source checksums are included. Each component retains\nits original copyright, license, patent notices, and build instructions.\n');
  await mkdir(dirname(output), { recursive: true });
  runArchive(['-czf', output, '-C', stage, 'media-runtime-source']);
  console.log(`Corresponding source: ${output}\nSHA256 ${await sha256(output)}`);
}
const command = process.argv[2] ?? 'prepare';
if (command === 'prepare') await prepare();
else if (command === 'finalize') await finalize();
else if (command === 'verify') await verify();
else if (command === 'sources') await sources();
else throw new Error(`Unknown runtime command: ${command}`);
