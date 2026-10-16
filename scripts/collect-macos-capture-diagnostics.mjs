import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('Capture diagnostics require macOS.');
const directory = resolve('test-results/macos-capture');
const reportsDirectory = join(directory, 'crash-reports');
mkdirSync(reportsDirectory, { recursive: true });
const index = { collectedAt: new Date().toISOString(), commands: [], reports: [], errors: [] };
function command(name, executable, args, timeout = 30000) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 24 * 1024 * 1024 });
  const output = `$ ${JSON.stringify([executable, ...args])}\n${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(directory, `${name}.log`), output);
  index.commands.push({ name, status: result.status, signal: result.signal, error: result.error?.message });
  console.log(`${name}: exit=${result.status}, signal=${result.signal}, error=${result.error?.message ?? ''}`);
  console.log(output.slice(0, 160000));
  return result;
}

if (process.argv.includes('--debugger')) {
  const executable = '/Applications/Open Media.app/Contents/MacOS/open-media';
  for (const [name, flag] of [['with-border', '--capture-smoke-test'], ['without-border', '--capture-smoke-test-no-border']]) {
    command(`debugger-${name}`, '/usr/bin/xcrun', [
      'lldb', '--batch', '--one-line', 'run', '--one-line', 'thread backtrace all',
      '--one-line-on-crash', 'thread backtrace all', '--one-line-on-crash', 'register read',
      '--one-line-on-crash', 'frame variable', '--one-line-on-crash', 'disassemble --frame',
      '--', executable, '--open-media-capture', flag, join(directory, `debugger-${name}.mp4`),
    ], 50000);
  }
}

command('process-system-log', '/usr/bin/log', ['show', '--last', '5m', '--style', 'compact', '--info', '--debug', '--predicate', 'process == "open-media"']);
const starts = ['with-border', 'without-border'].flatMap(mode => {
  try { return [Date.parse(JSON.parse(readFileSync(join(directory, `${mode}.json`), 'utf8')).startedAt)]; }
  catch { return []; }
}).filter(Number.isFinite);
const earliest = starts.length ? Math.min(...starts) - 60000 : Date.now() - 10 * 60 * 1000;
for (const [name, source] of [
  ['user', join(homedir(), 'Library/Logs/DiagnosticReports')],
  ['system', '/Library/Logs/DiagnosticReports'],
]) {
  if (!existsSync(source)) continue;
  try {
    for (const file of readdirSync(source)) {
      if (!/^(?:open-media|Open Media)[-_].*\.(?:ips|crash)$/i.test(file)) continue;
      const path = join(source, file);
      const stat = statSync(path);
      if (!stat.isFile() || stat.mtimeMs < earliest) continue;
      const destination = `${name}-${file}`;
      copyFileSync(path, join(reportsDirectory, destination));
      index.reports.push({ file: destination, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      console.log(`Collected ${destination}`);
      const contents = readFileSync(path, 'utf8');
      if (file.endsWith('.ips')) {
        let report;
        try { report = JSON.parse(contents); }
        catch { try { report = JSON.parse(contents.slice(contents.indexOf('\n') + 1)); } catch { /* Preserve unparsed text below. */ } }
        if (report) {
          console.log(JSON.stringify({
            file: destination, procName: report.procName, osVersion: report.osVersion,
            exception: report.exception, termination: report.termination, asi: report.asi,
            faultingThread: report.faultingThread, threads: report.threads, usedImages: report.usedImages,
          }, null, 2).slice(0, 200000));
        } else console.log(contents.slice(0, 200000));
      } else console.log(contents.slice(0, 200000));
    }
  } catch (error) { index.errors.push(`${source}: ${error.message}`); }
}
writeFileSync(join(directory, 'diagnostics.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`Collected ${index.reports.length} application crash reports. No other process logs were collected.`);
