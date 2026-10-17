import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const assetRoot = 'src/assets/background-music'
const licenseRoot = 'licenses/application/background-music'
const manifest = JSON.parse(read(`${assetRoot}/manifest.json`))
const catalogSource = read('src/core/background-music-catalog.ts').toString()
const compiled = ts.transpileModule(catalogSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const output = {}
new Function('exports', 'require', compiled)(output, name => ({ default: name }))

test('十种背景音乐对应不同的本地音频、风格和真实时长，目录不引用远程素材', () => {
  const catalog = output.BACKGROUND_MUSIC
  assert.equal(catalog.length, 10)
  assert.equal(manifest.tracks.length, 10)
  for (const key of ['id', 'filename', 'style', 'sha256']) assert.equal(new Set(manifest.tracks.map(track => track[key])).size, 10)
  assert.deepEqual(readdirSync(new URL(`../${assetRoot}/`, import.meta.url)).filter(name => name.endsWith('.mp3')).sort(), manifest.tracks.map(track => track.filename).sort())
  assert.ok(manifest.tracks.reduce((total, track) => total + track.bytes, 0) < 30_000_000)
  for (const track of manifest.tracks) {
    const item = catalog.find(item => item.id === track.id)
    assert.ok(item)
    for (const key of ['title', 'style', 'description', 'duration', 'filename']) assert.equal(item[key], track[key])
    assert.equal(item.url, `../assets/background-music/${track.filename}?url`)
    assert.ok(track.duration >= 30 && track.duration <= 180)
    assert.equal(track.codec, 'mp3')
    assert.equal(track.sampleRate, 44100)
    assert.equal(track.channels, 2)
    const bytes = read(`${assetRoot}/${track.filename}`)
    assert.equal(bytes.length, track.bytes)
    assert.equal(hash(bytes), track.sha256)
    assert.ok(bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff, 'The asset must contain MP3 bytes')
    assert.ok(track.processing.endSeconds <= track.original.duration)
    assert.ok(Math.abs(track.duration - (track.processing.endSeconds - track.processing.startSeconds)) < 0.1)
  }
})

test('内置音乐逐首保留原作者、下载来源、CC0 声明及片段处理记录', () => {
  const inventory = JSON.parse(read(`${licenseRoot}/manifest.json`))
  assert.equal(inventory.tracks.length, 10)
  assert.equal(manifest.license.spdx, 'CC0-1.0')
  assert.equal(hash(read(`${licenseRoot}/${manifest.license.file}`)), manifest.license.sha256)
  for (const track of manifest.tracks) {
    const notice = inventory.tracks.find(item => item.id === track.id)
    assert.ok(notice)
    assert.equal(notice.distributedSha256, track.sha256)
    assert.equal(notice.license, 'CC0-1.0')
    assert.ok(track.original.title && track.original.creator)
    assert.match(track.original.downloadSha256, /^[a-f0-9]{64}$/)
    assert.match(track.original.pageUrl, /^https:\/\/opengameart.org\/content\//)
    assert.match(track.original.downloadUrl, /^https:\/\/opengameart.org\/sites\/default\/files\//)
    const source = read(`${licenseRoot}/${track.original.sourcePage}`)
    assert.equal(hash(source), track.original.sourcePageSha256)
    assert.match(source.toString(), /creativecommons.org\/publicdomain\/zero\/1.0\//)
    assert.ok(typeof track.processing.excerpt === 'boolean')
    assert.ok(track.processing.encoder)
  }
})
