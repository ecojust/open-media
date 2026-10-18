import { build } from 'vite';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { output: { type: 'string', default: '.media-runtime/logs/webkit-proof.json' }, 'prepare-only': { type: 'boolean', default: false } } });
const proofPath = resolve(root, values.output);
const sha = data => createHash('sha256').update(data).digest('hex');
const subprocess = (command, args, timeout = 120000) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? `exit ${result.status}`}`);
};

let directory;
let verified = false;
try {
  if (process.platform !== 'darwin' && !values['prepare-only']) throw new Error('This verification must run on macOS with the real system WKWebView.');
  await mkdir(dirname(proofPath), { recursive: true });
  directory = await mkdtemp(join(tmpdir(), 'open-media-webkit-'));
  const configuration = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const csp = configuration.app.security.csp;
  if (typeof csp !== 'string' || !csp.includes('asset:')) throw new Error('Production CSP is unavailable.');
  await build({
    configFile: false, root, logLevel: 'warn',
    define: { __APP_VERSION__: JSON.stringify('webkit-verification'), __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
    build: {
      outDir: directory, emptyOutDir: false, target: 'es2022', copyPublicDir: false,
      rollupOptions: { input: join(root, 'tests/fixtures/macos-webkit-frame.ts'), output: { format: 'iife', entryFileNames: 'verification.js', inlineDynamicImports: true } },
    },
  });
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Open Media WebKit verification</title></head><body><script src="/verification.js"></script></body></html>');
  const encoder = process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg';
  subprocess(encoder, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25', '-frames:v', '1', '-threads', '1', '-y', join(directory, 'frame.png')]);
  subprocess(encoder, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', '-y', join(directory, 'source.mp4')]);
  const png = await readFile(join(directory, 'frame.png'));
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ csp, pngSha256: sha(png), pngBytes: png.length }));
  if (values['prepare-only']) {
    console.log(JSON.stringify({ preparedOnly: true, directory, explanation: 'The fixture bundle was prepared. No system WKWebView verification was performed.' }));
  } else {
    const executable = join(directory, 'verify-macos-webkit');
    subprocess('xcrun', ['swiftc', '-swift-version', '5', '-framework', 'AppKit', '-framework', 'WebKit', join(root, 'scripts/verify-macos-webkit.swift'), '-o', executable]);
    subprocess(executable, [directory, proofPath], 110000);
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    if (proof.passed !== true || proof.engine !== 'System WKWebView' || proof.fixtureIPC !== true || proof.nativeCompositionVerified !== false) throw new Error('System WebKit verification did not provide valid proof.');
    let commit = process.env.GITHUB_SHA;
    if (!commit) commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    proof.commit = commit;
    proof.arch = process.arch;
    proof.productionCsp = csp;
    proof.fixturePngSha256 = sha(png);
    proof.sourceHashes = Object.fromEntries(await Promise.all([
      'tests/fixtures/macos-webkit-frame.ts', 'scripts/verify-macos-webkit.swift',
      'src/core/editor-preview-tools.ts', 'src/native-preview-tools.ts', 'src/core/tool-artifacts.ts', 'src-tauri/tauri.conf.json',
    ].map(async path => [path, sha(await readFile(join(root, path)))])));
    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    verified = true;
    console.log(`PASS Actual ${process.arch} WKWebView production timeline frame, PNG IPC, artifact hash and chunk readback. Proof: ${proofPath}`);
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.stack : cause);
  process.exitCode = 1;
} finally {
  if (directory && !values['prepare-only']) await rm(directory, { recursive: true, force: true });
  if (!values['prepare-only'] && !verified) console.error('System WKWebView verification did not pass; no successful proof is claimed.');
}
