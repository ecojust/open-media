import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url))
const catalog = JSON.parse(read('src-tauri/resources/speech-models.json'))
const bundled = JSON.parse(read('scripts/speech-runtime.lock.json'))

test('optional downloads pin every file and count shared models once', () => {
  assert.equal(catalog.schema, 1)
  const voiceIds = new Set(bundled.voices.map(voice => voice.id))
  const models = new Set()
  for (const pack of catalog.models) {
    assert.ok(!models.has(pack.id))
    models.add(pack.id)
    assert.equal(pack.license, 'Apache-2.0')
    assert.equal(pack.modelSize, pack.files.reduce((sum, file) => sum + file.size, 0))
    assert.equal(pack.downloadSize, pack.modelSize)
    const files = new Set()
    for (const file of pack.files) {
      assert.ok(!files.has(file.path))
      files.add(file.path)
      assert.doesNotMatch(file.path, /(^\/|[\\,:]|(^|\/)\.\.(\/|$))/)
      const url = new URL(file.url)
      assert.equal(url.protocol, 'https:')
      assert.equal(url.hostname, 'huggingface.co')
      assert.match(url.pathname, /\/resolve\/[a-f0-9]{40}\//)
      assert.ok(Number.isSafeInteger(file.size) && file.size > 0)
      assert.match(file.sha256, /^[a-f0-9]{64}$/)
    }
    for (const voice of pack.voices) {
      assert.ok(!voiceIds.has(voice.id), 'Optional voices cannot override a bundled voice')
      voiceIds.add(voice.id)
      assert.ok(Number.isInteger(voice.speakerId) && voice.speakerId >= 0)
    }
    for (const path of [pack.model.file, pack.model.tokens, pack.model.voices, ...pack.model.lexicons, ...pack.model.ruleFsts]) {
      assert.ok(files.has(path) || /^@bundled\/model\/[^/]+\.fst$/.test(path), `Missing pinned resource ${path}`)
    }
    assert.equal(pack.model.dataDir, '@bundled/model/espeak-ng-data')
  }
  assert.equal(catalog.models.length, 1)
  assert.equal(catalog.models[0].voices.length, 3)
  assert.equal(catalog.models[0].downloadSize, 176178663)
})

test('optional model publisher notices retain the exact downloaded bytes', () => {
  const base = 'licenses/application/optional-speech'
  const inventory = JSON.parse(read(`${base}/manifest.json`))
  const model = catalog.models.find(model => model.id === inventory.modelId)
  assert.ok(model)
  for (const file of inventory.files) {
    const source = model.files.find(source => source.path === file.path)
    assert.equal(file.url, source.url)
    assert.equal(file.sha256, source.sha256)
    const bytes = read(`${base}/${file.path}`)
    assert.equal(bytes.length, source.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256)
  }
  assert.ok(inventory.files.some(file => file.path === 'LICENSE'))
  assert.ok(inventory.files.some(file => file.path === 'README.md'))
})
