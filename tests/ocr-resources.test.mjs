import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const inventory = JSON.parse(read('licenses/application/frontend/manifest.json'));

test('bundled OCR language models preserve both compressed and upstream checksums', () => {
  const models = JSON.parse(read('licenses/application/ocr/manifest.json'));
  assert.equal(models.license, 'Apache-2.0');
  assert.deepEqual(models.models.map(model => model.language).sort(), ['chi_sim', 'eng']);
  assert.equal(sha(read(models.licenseFile.path)), models.licenseFile.sha256);
  for (const model of models.models) {
    const compressed = read(model.file);
    assert.equal(compressed.length, model.bytes);
    assert.equal(sha(compressed), model.sha256);
    assert.equal(sha(gunzipSync(compressed)), model.sourceSha256);
    assert.ok(model.source.includes(`/${models.revision}/`));
  }
});

test('standalone recognition worker inventory covers every embedded dependency with original notices', () => {
  const worker = inventory.browserRuntimeBundles.find(bundle => bundle.name === 'recognition-worker');
  assert.equal(sha(read(worker.sourcePath)), worker.sha256);
  assert.equal(sha(read(worker.sourceMapPath)), worker.sourceMapSha256);
  assert.equal(sha(read(worker.noticePath)), worker.noticeSha256);
  const map = JSON.parse(read(worker.sourceMapPath));
  const sources = new Map(map.sources.map((source, i) => [source, map.sourcesContent[i]]));
  const accounted = new Set();
  for (const dependency of worker.embeddedPackages) {
    assert.ok(dependency.sourceIntegrity.startsWith('sha512-'));
    assert.ok(dependency.licenses.length);
    for (const notice of dependency.licenses) {
      assert.equal(sha(read(notice.bundledPath)), notice.sha256);
      assert.equal(read(notice.bundledPath).length, notice.bytes);
    }
    for (const module of dependency.modules) {
      const source = `webpack://tesseract.js/./node_modules/${dependency.name}/${module.path}`;
      assert.ok(sources.has(source), `Unrecognized embedded module: ${source}`);
      assert.equal(sha(sources.get(source)), module.sha256);
      assert.equal(Buffer.byteLength(sources.get(source)), module.bytes);
      assert.equal(module.archiveByteIdentical, true);
      accounted.add(source);
    }
  }
  assert.deepEqual([...accounted].sort(), map.sources.filter(source => source.includes('/node_modules/')).sort());
});

test('copied WebAssembly runtime and native dependency notices retain audited originals', () => {
  const core = inventory.browserRuntimeBundles.find(bundle => bundle.name === 'recognition-webassembly-core');
  assert.equal(sha(read(core.sourcePath)), core.sha256);
  assert.deepEqual(core.nativeDependencies.map(dependency => dependency.name).sort(), [
    'emscripten runtime and standard libraries', 'giflib', 'leptonica', 'libjpeg', 'libpng', 'libtiff', 'libwebp', 'openlibm', 'tesseract', 'zlib',
  ]);
  for (const dependency of core.nativeDependencies) {
    assert.ok(dependency.notices.length);
    assert.ok(dependency.revision || dependency.version);
    for (const notice of dependency.notices) {
      assert.equal(sha(read(notice.file)), notice.sha256);
      assert.equal(read(notice.file).length, notice.bytes);
      assert.ok(notice.sourceUrl.startsWith('https://'));
    }
  }
});

test('frontend inventory explicitly accounts for every production lock entry', () => {
  const lock = JSON.parse(read('package-lock.json'));
  for (const [path, entry] of Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev)) {
    const name = path.replace(/^node_modules\//, '');
    const emitted = inventory.packages.find(item => item.name === name && item.version === entry.version);
    const excluded = inventory.excludedNonDevelopmentLockEntries.find(item => item.name === name && item.version === entry.version);
    assert.ok(emitted || excluded, `Unreviewed production package: ${name}@${entry.version}`);
    if (emitted) {
      assert.equal(emitted.sourceUrl, entry.resolved);
      assert.equal(emitted.sourceIntegrity, entry.integrity);
    }
  }
});
