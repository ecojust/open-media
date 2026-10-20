import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(join(root, path));
const json = async path => JSON.parse(await read(path));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = await json('src-tauri/resources/video-generation-models.json');
const source = await json('licenses/video-generation/h3/manifest.json');
assert.equal(lock.schemaVersion, 1);
assert.equal(lock.engine.version, source.revision);
assert.match(source.revision, /^[a-f0-9]{40}$/);
assert.match(lock.revision, /^[a-f0-9]{40}$/);
assert.deepEqual(lock.engine.platforms, ['macos-arm64']);
assert.equal(lock.engine.minimumMacos, '15.0');
const vendor = 'src-tauri/native/video-generation/upstream';
const sourcePaths = source.files.map(file => file.path);
assert.equal(new Set(sourcePaths).size, source.files.length);
assert.deepEqual((await readdir(join(root, vendor))).sort(), sourcePaths.sort());
for (const file of source.files) {
  assert.match(file.path, /^[a-zA-Z0-9_.-]+$/);
  const bytes = await read(`${vendor}/${file.path}`);
  assert.equal(bytes.length, file.size, file.path);
  assert.equal(digest(bytes), file.sha256, file.path);
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  assert.deepEqual(await read(`${vendor}/${name}`), await read(`licenses/video-generation/h3/${name}`));
}
const license = await read(lock.license.path);
assert.equal(digest(license), lock.license.sha256);
assert.equal(license.toString('utf8'), lock.license.text);
assert.match(lock.license.text, /Excluded Territories/);
assert.match(lock.license.notice, /Community License Agreement/);
assert.equal(lock.license.commercialAttribution, 'MiniMax H3');
assert.notEqual(lock.license.id, 'MIT');
const encoder = await json('licenses/video-generation/MiniMax-H3/encoder-license-source.json');
assert.equal(digest(await read('licenses/video-generation/MiniMax-H3/Qwen3-VL-LICENSE')), encoder.sha256);
const metadata = await json('licenses/video-generation/MiniMax-H3/metadata.json');
assert.equal(metadata.revision, lock.revision);
const indexed = new Map(metadata.entries.map(file => [file.path, file]));
const seen = new Set();
const models = new Map(lock.models.map(model => [model.id, model]));
assert.equal(models.size, 2);
assert.deepEqual(models.get('h3-base-ref2va').requires, ['h3-base-fl2va']);
assert.deepEqual(models.get('h3-base-fl2va').requires, []);
for (const model of lock.models) {
  const hashes = new Map();
  const paths = new Set();
  let total = 0;
  for (const file of model.files) {
    assert.ok(!paths.has(file.path), `duplicate path: ${file.path}`);
    paths.add(file.path);
    assert.match(file.path, /^(FL2VA|Ref2VA)\/[a-zA-Z0-9_.\/-]+$/);
    assert.ok(!file.path.includes('..'));
    assert.ok(!file.path.endsWith('.py'));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
    const entry = indexed.get(file.path);
    assert.ok(entry, `missing original metadata: ${file.path}`);
    assert.equal(file.size, entry.size);
    if (entry.lfs) assert.equal(file.sha256, entry.lfs.oid);
    assert.equal(file.urls.length, 2);
    for (const [index, origin] of ['https://huggingface.co', 'https://hf-mirror.com'].entries()) {
      assert.equal(file.urls[index], `${origin}/${lock.repository}/resolve/${lock.revision}/${file.path}`);
    }
    total += file.size;
    hashes.set(file.sha256, file.size);
  }
  assert.equal(total, model.totalBytes);
  assert.equal([...hashes].filter(([sha]) => !seen.has(sha)).reduce((n, [, size]) => n + size, 0), model.uniqueBytes);
  hashes.forEach((_, sha) => seen.add(sha));
  const family = model.id === 'h3-base-fl2va' ? 'FL2VA' : 'Ref2VA';
  for (const required of ['tokenizer/tokenizer.json', 'transformer/config.json', 'text_encoder/config.json',
    'text_encoder/model.safetensors.index.json', 'transformer/model.safetensors.index.json',
    'audio_vae/config.json', 'audio_vae/model.safetensors',
    'video_vae/config.json', 'video_vae/source/config.json', 'video_vae/source/model.safetensors']) {
    assert.ok(paths.has(`${family}/${required}`), `missing required model file: ${required}`);
  }
  assert.equal(model.files.filter(file => file.path.includes('/text_encoder/model-')).length, 14);
  assert.equal(model.files.filter(file => file.path.includes('/transformer/model-')).length, 13);
}
assert.ok(models.get('h3-base-ref2va').uniqueBytes < models.get('h3-base-ref2va').totalBytes / 2);
const shader = await read(`${vendor}/${lock.engine.shader}`);
assert.ok(shader.length > 200_000);
console.log(`Video generation source and model inventories verified: ${source.files.length} original files, ${indexed.size} locked model files. No weights downloaded or generated media claimed.`);
