import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const audioInputEntitlement = 'com.apple.security.device.audio-input';

export function validateMacOSPermissions({ signature, entitlements, info }) {
  const flags = signature.match(/\bflags=(0x[\da-f]+)/i);
  assert.ok(flags && (Number(flags[1]) & 0x10000) !== 0,
    'The packaged application must retain hardened runtime.');
  assert.equal(entitlements[audioInputEntitlement], true,
    'The packaged executable must grant the audio-input entitlement for microphone recording.');
  assert.ok(typeof info.NSMicrophoneUsageDescription === 'string'
    && info.NSMicrophoneUsageDescription.trim().length > 0,
  'The packaged application must explain microphone access in Info.plist.');
  return {
    hardenedRuntime: true,
    microphoneEntitlement: true,
    microphoneUsageDescription: info.NSMicrophoneUsageDescription,
  };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Permission verification command failed: ${command}\n${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function verifyMacOSPermissions(application, { run = runCommand } = {}) {
  const executable = join(application, 'Contents/MacOS/open-media');
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', executable]);
  const entitlementData = run('/usr/bin/codesign', ['--display', '--entitlements', ':-', executable]);
  assert.ok(entitlementData.stdout.trim(),
    'The packaged executable has no signed entitlements; microphone recording would be denied.');
  // Convert only the signed plist on stdout, never codesign diagnostics on stderr.
  const entitlements = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    input: entitlementData.stdout,
  });
  const info = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(application, 'Contents/Info.plist')]);
  return validateMacOSPermissions({
    signature: `${signature.stdout}${signature.stderr}`,
    entitlements: JSON.parse(entitlements.stdout),
    info: JSON.parse(info.stdout),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.platform, 'darwin', 'Packaged permission verification must run on macOS.');
    assert.ok(process.argv[2], 'Provide the packaged application path.');
    const application = resolve(process.argv[2]);
    const permissions = verifyMacOSPermissions(application);
    console.log(JSON.stringify({ application, ...permissions }));
    console.log('Verified signed microphone entitlement, usage description and hardened runtime.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
