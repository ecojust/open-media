import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('scripts/repair-video-vae-config.sh');
const originals = resolve('licenses/video-generation/MiniMax-H3');
const config = readFileSync(join(originals, 'video-vae-config.json'));
const provenance = JSON.parse(readFileSync(join(originals, 'video-vae-config-source.json')));
const revision = '42ed227ee7df40d41602854ae760620d6eb651fe';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const shell = { skip: process.platform === 'win32' };

function installation(t) {
  const root = mkdtempSync(join(tmpdir(), 'video-model-offline-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'Application Support', 'Open Media');
  const model = join(app, 'video-generation/models/h3-base-fl2va', revision);
  const folder = join(model, 'FL2VA/video_vae');
  mkdirSync(join(folder, 'source'), { recursive: true });
  writeFileSync(join(folder, 'source/model.safetensors'), 'existing weight bytes');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['curl', 'wget']) {
    writeFileSync(join(bin, name), '#!/bin/bash\nprintf network >> "$OFFLINE_NETWORK_TRACE"\nexit 99\n', { mode: 0o755 });
  }
  const run = (file = script) => spawnSync('bash', [file, app], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OFFLINE_NETWORK_TRACE: join(root, 'network') },
  });
  return { root, model, folder, run };
}

test('offline configuration matches both pinned model inventories and provenance', () => {
  assert.equal(config.length, provenance.size);
  assert.equal(digest(config), provenance.sha256);
  assert.equal(provenance.modified, false);
  const catalog = JSON.parse(readFileSync('src-tauri/resources/video-generation-models.json'));
  for (const model of catalog.models) {
    const entry = model.files.find(file => file.path.endsWith('/video_vae/config.json'));
    assert.equal(entry.sha256, provenance.sha256);
    assert.equal(entry.size, config.length);
    for (const source of provenance.sources) {
      assert.match(source.revision, /^[a-f0-9]{40}$/);
      assert.ok(source.urls.some(url => entry.urls.includes(url)));
    }
  }
});

test('repair succeeds without network, preserves weights and carries original notices', shell, t => {
  const f = installation(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已离线补齐配置/);
  assert.equal(existsSync(join(f.root, 'network')), false);
  assert.deepEqual(readFileSync(join(f.folder, 'config.json')), config);
  for (const name of ['LICENSE', 'NOTICE']) {
    assert.deepEqual(readFileSync(join(f.model, name)), readFileSync(join(originals, name)));
  }
  assert.equal(readFileSync(join(f.folder, 'source/model.safetensors'), 'utf8'), 'existing weight bytes');
  const modified = statSync(join(f.folder, 'config.json')).mtimeMs;
  const again = f.run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /配置已正确/);
  assert.equal(statSync(join(f.folder, 'config.json')).mtimeMs, modified);
});

test('offline repair rejects a damaged embedded configuration before installation', shell, t => {
  const f = installation(t);
  const damaged = join(f.root, 'damaged.sh');
  const body = readFileSync(script, 'utf8');
  const changed = body.replace('"latent_channels": 24', '"latent_channels": 25');
  assert.notEqual(changed, body);
  writeFileSync(damaged, changed);
  const result = f.run(damaged);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /内置配置校验不通过/);
  assert.equal(existsSync(join(f.folder, 'config.json')), false);
  assert.deepEqual(readdirSync(f.folder), ['source']);
});

test('offline repair preserves existing unknown configuration and notices', shell, t => {
  const f = installation(t);
  writeFileSync(join(f.folder, 'config.json'), 'user configuration');
  writeFileSync(join(f.model, 'NOTICE'), 'existing notice');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /未覆盖/);
  assert.equal(readFileSync(join(f.folder, 'config.json'), 'utf8'), 'user configuration');
  assert.equal(readFileSync(join(f.model, 'NOTICE'), 'utf8'), 'existing notice');
});

test('offline repair refuses a configuration symlink', shell, t => {
  const f = installation(t);
  const external = join(f.root, 'outside.json');
  writeFileSync(external, 'keep');
  symlinkSync(external, join(f.folder, 'config.json'));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /符号链接/);
  assert.equal(readFileSync(external, 'utf8'), 'keep');
});
