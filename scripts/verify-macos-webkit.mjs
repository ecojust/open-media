import { build } from 'vite';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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
  if (!values['prepare-only']) await rm(proofPath, { force: true });
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
  subprocess(encoder, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=6,drawbox=x=0:y=0:w=160:h=50:color=0xc82828:t=fill', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', '-y', join(directory, 'source.mp4')]);
  subprocess(encoder, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=4,drawbox=x=80:y=0:w=80:h=90:color=white:t=fill', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', '-y', join(directory, 'contrast.mp4')]);
  await copyFile(join(root, 'public/watermarks/loading-dots.mp4'), join(directory, 'loading-dots.mp4'));
  const png = await readFile(join(directory, 'frame.png'));
  const decodedFrame = execFileSync(encoder, ['-hide_banner', '-loglevel', 'error', '-ss', '0.25', '-i', join(directory, 'source.mp4'), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 15000, maxBuffer: 1024 * 1024 });
  const decodedSourceRgb = [...decodedFrame.subarray((5 * 160 + 5) * 3, (5 * 160 + 5) * 3 + 3)];
  if (decodedSourceRgb.length !== 3 || decodedSourceRgb[0] < 120 || decodedSourceRgb[0] <= decodedSourceRgb[1] + 80 || decodedSourceRgb[0] <= decodedSourceRgb[2] + 80) throw new Error('Independent FFmpeg source color reference is invalid.');
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ csp, pngSha256: sha(png), pngBytes: png.length, decodedSourceRgb }));
  if (values['prepare-only']) {
    console.log(JSON.stringify({ preparedOnly: true, directory, explanation: 'The fixture bundle was prepared. No system WKWebView verification was performed.' }));
  } else {
    const executable = join(directory, 'verify-macos-webkit');
    subprocess('xcrun', ['swiftc', '-swift-version', '5', '-framework', 'AppKit', '-framework', 'WebKit', join(root, 'scripts/verify-macos-webkit.swift'), '-o', executable]);
    let executionError;
    try { subprocess(executable, [directory, proofPath], 110000); } catch (cause) { executionError = cause; }
    let proof;
    try { proof = JSON.parse(await readFile(proofPath, 'utf8')); }
    catch { proof = { passed: false, realtimeCompositionVerified: false, nativeFrameArtifactVerified: false, error: executionError?.message || 'System WKWebView returned no proof.' }; }
    let commit = process.env.GITHUB_SHA;
    if (!commit) commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    proof.commit = commit;
    proof.arch = process.arch;
    proof.productionCsp = csp;
    proof.fixturePngSha256 = sha(png);
    proof.fixtureVideoSha256 = sha(await readFile(join(directory, 'source.mp4')));
    proof.fixtureDecodedSourceRgb = decodedSourceRgb;
    proof.fixtureContrastVideoSha256 = sha(await readFile(join(directory, 'contrast.mp4')));
    proof.verificationBundleSha256 = sha(await readFile(join(directory, 'verification.js')));
    proof.sourceHashes = Object.fromEntries(await Promise.all([
      'tests/fixtures/macos-webkit-frame.ts', 'scripts/verify-macos-webkit.swift', 'scripts/verify-macos-webkit.mjs',
      'src/core/editor-preview-tools.ts', 'src/native-preview-tools.ts', 'src/core/tool-artifacts.ts', 'src-tauri/tauri.conf.json',
      'src/core/preview.ts', 'src/core/visual-animation.ts', 'src/core/transitions.ts', 'src/core/filter-renderer.ts', 'src/core/canvas-blur.ts', 'src/core/project.ts',
      'public/watermarks/loading-dots.mp4',
    ].map(async path => [path, sha(await readFile(join(root, path)))])));
    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    if (executionError) throw executionError;
    if (proof.passed !== true || proof.engine !== 'System WKWebView' || proof.realtimeCompositionVerified !== true || proof.realtimeBlurVerified !== true || proof.realtimeIpcCalls !== 0 || proof.nativeFrameArtifactVerified !== true || proof.fixtureIPC !== true || proof.nativeCompositionVerified !== false) throw new Error('System WebKit verification did not provide valid, separate realtime composition and native artifact proof.');
    verified = true;
    console.log(`PASS Actual ${process.arch} WKWebView realtime video/text/watermark/transition/filter/chroma/blur composition and playing seeks; separate fixture PNG IPC, artifact hash and chunk readback. Proof: ${proofPath}`);
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.stack : cause);
  if (!values['prepare-only']) {
    let proof;
    try { proof = JSON.parse(await readFile(proofPath, 'utf8')); } catch { proof = { realtimeCompositionVerified: false, nativeFrameArtifactVerified: false }; }
    await mkdir(dirname(proofPath), { recursive: true });
    await writeFile(proofPath, `${JSON.stringify({ ...proof, passed: false, harnessError: cause instanceof Error ? cause.message : String(cause) }, null, 2)}\n`);
  }
  process.exitCode = 1;
} finally {
  if (directory && !values['prepare-only']) await rm(directory, { recursive: true, force: true });
  if (!values['prepare-only'] && !verified) console.error('System WKWebView verification did not pass; no successful proof is claimed.');
}
