import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

assert.equal(process.platform, 'darwin', 'This test needs a macOS desktop session.');
assert.equal(process.arch, 'arm64', 'This test inspects the released Apple Silicon application.');
const driver = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && existsSync(driver), 'Provide the compiled external interface driver.');
const directory = resolve('test-results/macos-capture-gui');
mkdirSync(directory, { recursive: true });
const application = '/Applications/Open Media.app';
const executable = `${application}/Contents/MacOS/open-media`;
const mediaDirectory = join(homedir(), 'Library/Application Support/com.ecojust.openmedia/media');
const startedAt = new Date().toISOString();
const report = {
  releaseTag: process.env.RELEASE_TAG ?? 'unknown', harnessCommit: process.env.GITHUB_SHA ?? '',
  invocation: 'application-launcher-and-real-interface-controls', application, executable, startedAt,
  outcome: 'not-completed', commands: [], processes: [],
  permissionScope: 'Hosted runner grants may belong to its execution agent. GUI success alone is not proof of per-application permission or permission continuity across upgrades.',
  userMachineTested: false, permissionDatabaseModified: false, applicationRebuilt: false, applicationResigned: false,
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function command(name, path, args, { required = true, timeout = 30000, sanitize = value => value } = {}) {
  const raw = spawnSync(path, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 24 * 1024 * 1024 });
  const result = { ...raw, stdout: sanitize(raw.stdout ?? ''), stderr: sanitize(raw.stderr ?? '') };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(directory, `${name}.log`), `$ ${JSON.stringify([path, ...args])}\n${output}`);
  report.commands.push({ name, status: result.status, signal: result.signal, error: result.error?.message });
  if (required && (result.error || result.status !== 0)) throw new Error(`${name} failed: ${result.error?.message ?? output}`);
  return { ...result, output };
}
function summarizeResponsibility(value) {
  // procinfo includes inherited environment variables. Remove those sections
  // before writing anything, and allow only identity and signature fields.
  let excludedIndent;
  const lines = [];
  for (const line of value.split('\n')) {
    if (excludedIndent !== undefined) {
      if (line === `${excludedIndent}}`) excludedIndent = undefined;
      continue;
    }
    const environment = line.match(/^(\s*)(?:environment vector|inherited environment|default environment|environment)\s*=\s*\{/);
    if (environment) { excludedIndent = environment[1]; continue; }
    if (/^\s*(?:program path|pid|ppid|responsible pid|responsible unique pid|responsible path|entitlements|code signing info|sandboxed)\s*=/.test(line)) lines.push(line.trim());
  }
  return lines.join('\n');
}
function permissionEvidence(phase, from) {
  const until = new Date().toISOString();
  const log = command(`${phase}-permission-system-log`, '/usr/bin/sudo', ['-n', '/usr/bin/log', 'show', '--last', '10m', '--style', 'json', '--info', '--debug', '--predicate', 'process == "tccd" OR process == "replayd" OR process == "open-media" OR eventMessage CONTAINS[c] "com.ecojust.openmedia"'], { required: false, timeout: 30000 });
  try {
    const records = JSON.parse(log.stdout).filter(event => {
      const time = Date.parse(String(event.timestamp).replace(' ', 'T'));
      return time >= Date.parse(from) - 1000 && time <= Date.parse(until) + 1000;
    });
    const messageIDs = new Set(records.filter(event => /com\.ecojust\.openmedia|\/open-media\b/i.test(event.eventMessage ?? ''))
      .flatMap(event => [...String(event.eventMessage).matchAll(/msgID[=:]\s*["']?([\d.]+)/g)].map(match => match[1])));
    const events = records.filter(event => {
      const message = String(event.eventMessage ?? '');
      return /(?:com\.ecojust\.openmedia|\/open-media\b|ScreenCapture)/i.test(message)
        && /AUTHREQ|AttributionChain|TCC|PROMPT|prompt|denied|deny|declined|signature|identity|request|auth/i.test(message)
        || [...message.matchAll(/msgID[=:]\s*["']?([\d.]+)/g)].some(match => messageIDs.has(match[1]));
    }).map(event => ({ timestamp: event.timestamp, processID: event.processID, message: String(event.eventMessage).slice(0, 8000) }));
    const evidence = { from, until, matchedCount: events.length, events };
    writeFileSync(join(directory, `${phase}-permission-events.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    // Keep the first decisions as well as later results if an unusual runner
    // generates excessive traffic; never replace GUI evidence with control logs.
    const visible = events.length > 600 ? [...events.slice(0, 300), ...events.slice(-300)] : events;
    console.log(JSON.stringify({ event: `${phase}-permission-evidence`, from, until, matchedCount: events.length, omitted: events.length - visible.length, events: visible }, null, 2));
    return { from, until, matchedCount: events.length, file: `${phase}-permission-events.json` };
  } catch {
    return { from, until, error: 'Structured permission events unavailable; inspect the original phase log.' };
  }
}
function applicationProcesses() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000 });
  return (result.stdout ?? '').split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || !match[3].startsWith(executable)) return [];
    return [{ pid: Number(match[1]), parentPID: Number(match[2]), command: match[3], observedAt: new Date().toISOString() }];
  });
}
const observed = new Set();
function sampleProcesses() {
  for (const entry of applicationProcesses()) {
    if (observed.has(entry.pid)) continue;
    observed.add(entry.pid);
    report.processes.push(entry);
    const responsibility = command(`process-${entry.pid}-responsibility`, '/usr/bin/sudo', ['-n', '/bin/launchctl', 'procinfo', String(entry.pid)], { required: false, timeout: 5000, sanitize: summarizeResponsibility });
    entry.responsibility = responsibility.output;
  }
}
function screenshot(stage) {
  const name = stage.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  command(`screenshot-${name}`, '/usr/sbin/screencapture', ['-x', join(directory, `${name}.png`)], { required: false, timeout: 5000 });
}
function currentMedia() {
  return new Set(existsSync(mediaDirectory) ? readdirSync(mediaDirectory).filter(name => name.endsWith('.mp4')) : []);
}
let monitor;
let mainPID;
try {
  assert.ok(existsSync(executable), 'Install the released application first.');
  report.operatingSystem = command('system', '/usr/bin/sw_vers', []).output.trim();
  report.executableSHA256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  report.signature = command('signature-and-requirement', '/usr/bin/codesign', ['--display', '--verbose=4', '--requirements', '-', application]).output;
  command('verify-signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  assert.equal(applicationProcesses().length, 0, 'The test must start with this application closed.');
  const before = currentMedia();
  command('launch', '/usr/bin/open', ['-n', '-a', application]);
  const launchDeadline = Date.now() + 30000;
  while (Date.now() < launchDeadline) {
    const main = applicationProcesses().find(entry => entry.command === executable);
    if (main) { mainPID = main.pid; break; }
    await delay(250);
  }
  assert.ok(mainPID, 'The application launcher did not start the released application.');
  report.mainPID = mainPID;
  sampleProcesses();
  monitor = setInterval(sampleProcesses, 500);
  const uiLog = join(directory, 'ui-driver.log');
  writeFileSync(uiLog, '');
  const driverResult = await new Promise((resolve, reject) => {
    const child = spawn(driver, [String(mainPID), directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), 330000);
    child.stdout.on('data', data => {
      appendFileSync(uiLog, data);
      process.stdout.write(data);
      pending += data.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'stage' && typeof event.stage === 'string') {
          sampleProcesses();
          screenshot(event.stage);
        }
      }
    });
    child.stderr.on('data', data => { appendFileSync(uiLog, data); process.stderr.write(data); });
    child.on('error', error => { clearTimeout(deadline); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }); });
  });
  report.driver = driverResult;
  if (existsSync(join(directory, 'ui-report.json'))) report.interface = JSON.parse(readFileSync(join(directory, 'ui-report.json'), 'utf8'));
  else throw new Error('The interface driver did not produce a structured result.');
  report.outcome = report.interface.outcome;
  screenshot('final');
  if (report.interface.outcome === 'recorded') {
    const created = [...currentMedia()].filter(name => !before.has(name));
    assert.equal(created.length, 1, 'A successful interface recording must create exactly one new saved video.');
    const input = join(mediaDirectory, created[0]);
    const video = join(directory, 'gui-recording.mp4');
    copyFileSync(input, video);
    const probe = `${application}/Contents/Resources/media/ffprobe`;
    const decoder = `${application}/Contents/Resources/media/ffmpeg`;
    const metadata = JSON.parse(command('recording-probe', probe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]).stdout);
    writeFileSync(join(directory, 'gui-recording-probe.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    const videos = metadata.streams.filter(stream => stream.codec_type === 'video');
    assert.equal(videos.length, 1);
    assert.ok(videos[0].width >= 16 && videos[0].height >= 16, 'The recording must have a real picture.');
    assert.equal(metadata.streams.some(stream => stream.codec_type === 'audio'), false, 'The test never enables microphone recording.');
    const duration = Number(metadata.format.duration);
    assert.ok(Number.isFinite(duration) && duration >= 2.5 && duration <= 30, 'The recording should contain a few seconds of actual video.');
    command('decode-recording', decoder, ['-v', 'error', '-xerror', '-i', video, '-map', '0:v:0', '-f', 'null', '-']);
    command('recording-frame', decoder, ['-v', 'error', '-ss', '1', '-i', video, '-frames:v', '1', join(directory, 'gui-recording-frame.png')]);
    report.recording = { duration, bytes: statSync(video).size, decoded: true, sha256: createHash('sha256').update(readFileSync(video)).digest('hex') };
    report.outcome = 'gui-recording-passed';
  } else process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (!['permission-denied', 'automation-blocked', 'timeout'].includes(report.outcome)) report.outcome = 'failed';
  process.exitCode = 1;
  console.error(report.error);
} finally {
  clearInterval(monitor);
  sampleProcesses();
  report.guiPermissionEvidence = permissionEvidence('gui', startedAt);
  screenshot('diagnostic-end');
  // End only the application launched by this harness. Its capture children
  // detect the parent's exit and stop their devices and border normally.
  if (mainPID) {
    try { process.kill(mainPID, 'SIGTERM'); } catch { /* Already closed. */ }
    for (let attempt = 0; attempt < 20 && applicationProcesses().length; attempt++) await delay(250);
    const remaining = applicationProcesses().filter(entry => observed.has(entry.pid));
    report.cleanup = { remainingAfterGrace: remaining.map(entry => entry.pid) };
    for (const entry of remaining) { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* Already closed. */ } }
  }
  // Compare enumeration only after the real interface attempt. This control is
  // intentionally labelled as the runner's direct process, never app permission.
  const controlStartedAt = new Date().toISOString();
  const control = command('direct-runner-source-control', executable, ['--open-media-capture', 'sources', '--request-permission'], { required: false, timeout: 25000 });
  let sources;
  try { sources = JSON.parse(control.stdout); } catch { /* Preserve the raw error. */ }
  report.directRunnerControl = {
    outcome: control.status === 0 && Array.isArray(sources) ? 'sources-readable' : /-3801|TCC|拒绝/.test(control.output) ? 'permission-denied' : 'failed',
    sourceCount: Array.isArray(sources) ? sources.length : undefined,
    permissionScope: 'This direct invocation can inherit the hosted execution agent grant.',
  };
  report.controlPermissionEvidence = permissionEvidence('control', controlStartedAt);
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
