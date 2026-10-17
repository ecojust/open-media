import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyMacOSPermissions } from './check-macos-permissions.mjs';

const mode = process.argv[2];
assert.ok(['baseline', 'installed', 'with-border', 'without-border'].includes(mode), 'Choose baseline, installed, with-border or without-border.');
assert.equal(process.platform, 'darwin', 'Installed recording verification must run on macOS.');
assert.equal(process.arch, 'arm64', 'This verification targets Apple Silicon.');
const directory = resolve('test-results/macos-capture');
mkdirSync(directory, { recursive: true });
const logFile = join(directory, `${mode}.log`);
const reportFile = join(directory, `${mode}.json`);
const application = '/Applications/Open Media.app';
const executable = `${application}/Contents/MacOS/open-media`;
const captureLibrary = `${application}/Contents/Frameworks/libopen_media_capture.dylib`;
const report = {
  mode, application, executable, invocation: 'installed-main-executable-capture-mode',
  harnessCommit: process.env.GITHUB_SHA ?? '',
  sourceCommit: mode === 'baseline' ? undefined : process.env.OPEN_MEDIA_TEST_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? '',
  sourceRelease: mode === 'baseline' ? 'v0.1.4' : undefined,
  startedAt: new Date().toISOString(), commands: [],
};
writeFileSync(logFile, '');
function log(text) {
  process.stdout.write(text);
  appendFileSync(logFile, text);
}
function run(command, args, options = {}) {
  log(`\n$ ${JSON.stringify([command, ...args])}\n`);
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  log(output);
  report.commands.push({ command, args, status: result.status, signal: result.signal, error: result.error?.message });
  if (result.error || result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? result.signal}): ${command}\n${result.error?.message ?? ''}\n${output}`);
  }
  return output;
}
function records(output) {
  return output.split(/\r?\n/).flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
    } catch { return []; }
  });
}
function identity(output) {
  const entries = records(output).filter(entry => 'captureIdentityMode' in entry);
  assert.equal(entries.length, 1, 'The process must report exactly one capture identity.');
  assert.equal(entries[0].captureIdentityMode, 'packaged');
  assert.equal(entries[0].captureApplicationIdentifier, 'com.ecojust.openmedia');
  assert.equal(entries[0].captureBundlePath, application);
  assert.equal(entries[0].captureExecutablePath, executable);
  return entries[0];
}

try {
  assert.ok(existsSync(executable), 'The installed application executable is missing.');
  report.operatingSystem = run('/usr/bin/sw_vers', []);
  report.architecture = run('/usr/bin/uname', ['-m']).trim();
  report.executableSHA256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (mode === 'baseline' || mode === 'installed') {
    report.signature = run('/usr/bin/codesign', ['--display', '--verbose=4', application]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
    report.dependencies = run('/usr/bin/otool', ['-L', executable]);
    if (mode === 'baseline') {
      report.captureLibraryPresent = existsSync(captureLibrary);
      if (report.captureLibraryPresent) {
        report.captureLibrarySignature = run('/usr/bin/codesign', ['--display', '--verbose=4', captureLibrary]);
      }
    } else {
      assert.equal(existsSync(captureLibrary), false, 'The installed app must not contain the former capture dynamic library.');
      assert.doesNotMatch(report.dependencies, /libopen_media_capture/, 'Recording must not load a separate application capture library.');
      report.permissions = verifyMacOSPermissions(application);
    }
    report.identity = identity(run(executable, ['--open-media-capture', '--self-test']));
    report.outcome = 'passed';
    report.scope = 'installed-signature-linkage-and-self-test';
    log('\nInstalled loader and identity verification passed; real screen access is checked separately.\n');
  } else {
    const withBorder = mode === 'with-border';
    const outputPath = join(directory, `${mode}.mp4`);
    assert.equal(existsSync(outputPath), false, 'A fresh recording must not reuse a previous video.');
    const output = run(executable, ['--open-media-capture', withBorder ? '--capture-smoke-test' : '--capture-smoke-test-no-border', outputPath]);
    report.identity = identity(output);
    const entries = records(output);
    const start = entries.filter(entry => entry.captureSmokeTest === 'starting');
    const firstFrame = entries.filter(entry => entry.captureSmokeTest === 'first-frame');
    const completed = entries.filter(entry => entry.captureSmokeTest === 'passed');
    assert.equal(start.length, 1);
    assert.equal(start[0].recordingBorder, String(withBorder));
    assert.equal(start[0].microphone, 'false');
    assert.equal(firstFrame.length, 1, 'The first captured frame must report the observed border state.');
    assert.equal(firstFrame[0].recordingBorderVisible, String(withBorder));
    assert.equal(completed.length, 1, 'A real recording completion record is required.');
    assert.equal(completed[0].recordingBorderWasVisible, String(withBorder));
    assert.equal(completed[0].recordingBorderClosed, 'true', 'Stopping must close the recording border.');
    assert.ok(Number(completed[0].screenFrames) > 0, 'Screen capture must provide actual samples.');
    assert.ok(Number(completed[0].encodedFrames) > 1, 'The recorder must encode multiple screen frames.');
    assert.ok(statSync(outputPath).size > 0);
    const probe = `${application}/Contents/Resources/media/ffprobe`;
    const decoder = `${application}/Contents/Resources/media/ffmpeg`;
    const metadata = JSON.parse(run(probe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath]));
    writeFileSync(join(directory, `${mode}-probe.json`), `${JSON.stringify(metadata, null, 2)}\n`);
    const video = metadata.streams.filter(stream => stream.codec_type === 'video');
    assert.equal(video.length, 1);
    assert.equal(video[0].width, 1280);
    assert.equal(video[0].height, 720);
    assert.equal(metadata.streams.some(stream => stream.codec_type === 'audio'), false);
    const duration = Number(metadata.format.duration);
    assert.ok(Number.isFinite(duration) && duration >= 2.8 && duration <= 10, 'The real video must contain approximately three seconds.');
    run(decoder, ['-v', 'error', '-xerror', '-i', outputPath, '-map', '0:v:0', '-f', 'null', '-']);
    const screenshot = join(directory, `${mode}-frame.png`);
    run(decoder, ['-v', 'error', '-ss', '1', '-i', outputPath, '-frames:v', '1', screenshot]);
    report.recording = {
      starting: start[0], firstFrame: firstFrame[0], completed: completed[0], outputPath,
      bytes: statSync(outputPath).size,
      sha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
      durationSeconds: duration, decoded: true,
    };
    report.outcome = 'passed';
    report.scope = 'real-screen-recording';
    log(`\nReal screen recording passed: ${mode}, ${duration}s, SHA256 ${report.recording.sha256}\n`);
  }
} catch (error) {
  report.outcome = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  report.permissionDenied = /TCC|3801|denied|not permitted|not allowed|未授权|未允许|拒绝/i.test(report.error);
  log(`\nVerification failed: ${report.error}\n`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
