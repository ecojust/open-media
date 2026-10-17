import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateMacOSPermissions, verifyMacOSPermissions } from '../scripts/check-macos-permissions.mjs';

const valid = {
  signature: 'CodeDirectory v=20500 size=512 flags=0x10002(adhoc,runtime) hashes=9+7 location=embedded\n',
  entitlements: { 'com.apple.security.device.audio-input': true },
  info: { NSMicrophoneUsageDescription: '仅在你开启麦克风录制时采集声音。' },
};

test('packaged microphone permissions require a signed true entitlement and hardened runtime', () => {
  assert.equal(validateMacOSPermissions(valid).microphoneEntitlement, true);
  for (const value of [undefined, false, 'true', 1]) {
    assert.throws(() => validateMacOSPermissions({
      ...valid, entitlements: { 'com.apple.security.device.audio-input': value },
    }), /audio-input entitlement/);
  }
  for (const signature of ['', 'flags=0x2(adhoc)', 'flags=0x0(none)']) {
    assert.throws(() => validateMacOSPermissions({ ...valid, signature }), /hardened runtime/);
  }
  for (const value of [undefined, '', '  ', true]) {
    assert.throws(() => validateMacOSPermissions({
      ...valid, info: { NSMicrophoneUsageDescription: value },
    }), /explain microphone access/);
  }
});

function packagedCommands({ entitlements = valid.entitlements, empty = false, signature = valid.signature } = {}) {
  const application = '/Applications/Open Media.app';
  const calls = [];
  const signedPlist = `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(entitlements)
    .map(([key, value]) => `<key>${key}</key><${value ? 'true' : 'false'}/>`).join('')}</dict></plist>`;
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/codesign') {
      assert.equal(args.at(-1), `${application}/Contents/MacOS/open-media`);
      if (args.includes('--verbose=4')) return { stdout: '', stderr: signature };
      assert.deepEqual(args.slice(0, -1), ['--display', '--entitlements', ':-']);
      return { stdout: empty ? '' : signedPlist, stderr: 'Executable=/Applications/Open Media.app/Contents/MacOS/open-media\n' };
    }
    assert.equal(command, '/usr/bin/plutil');
    if (args.at(-1) === '-') {
      assert.equal(options.input, signedPlist, 'Only the signed entitlement plist is sent to the parser.');
      return { stdout: JSON.stringify(entitlements), stderr: '' };
    }
    assert.equal(args.at(-1), `${application}/Contents/Info.plist`);
    return { stdout: JSON.stringify(valid.info), stderr: '' };
  };
  return { application, run, calls };
}

test('installed verification reads the main executable signature and packaged plist', () => {
  const fixture = packagedCommands();
  assert.equal(verifyMacOSPermissions(fixture.application, fixture).hardenedRuntime, true);
  assert.equal(fixture.calls.length, 4);
});

test('installed verification rejects absent and false signed entitlements from command output', () => {
  for (const entitlements of [{}, { 'com.apple.security.device.audio-input': false }]) {
    const fixture = packagedCommands({ entitlements });
    assert.throws(() => verifyMacOSPermissions(fixture.application, fixture), /audio-input entitlement/);
  }
  const unsigned = packagedCommands({ empty: true });
  assert.throws(() => verifyMacOSPermissions(unsigned.application, unsigned), /no signed entitlements/);
  const unhardened = packagedCommands({ signature: 'CodeDirectory flags=0x2(adhoc)\n' });
  assert.throws(() => verifyMacOSPermissions(unhardened.application, unhardened), /hardened runtime/);
});

test('application packaging config includes the microphone entitlement without disabling hardening', () => {
  const root = resolve(import.meta.dirname, '../src-tauri');
  const config = JSON.parse(readFileSync(resolve(root, 'tauri.conf.json'), 'utf8')).bundle.macOS;
  assert.equal(config.hardenedRuntime, true);
  assert.equal(typeof config.entitlements, 'string');
  const parsePlist = file => JSON.parse(execFileSync('python3', [
    '-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', file,
  ], { encoding: 'utf8' }));
  const entitlements = parsePlist(resolve(root, config.entitlements));
  const info = parsePlist(resolve(root, config.infoPlist));
  assert.equal(validateMacOSPermissions({ ...valid, entitlements, info }).microphoneEntitlement, true);
  assert.deepEqual(Object.keys(entitlements), ['com.apple.security.device.audio-input']);
});
