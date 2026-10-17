const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createRequire } = require('node:module')
const { chromium, expect } = createRequire(path.join(process.cwd(), 'package.json'))('@playwright/test')

const root = path.resolve(process.env.COMPARISON_ROOT || path.join(__dirname, '..'))
const artifacts = path.resolve(process.env.COMPARISON_ARTIFACTS || path.join(root, '..', 'comparison-browser-verification'))
const expectedModels = Number(process.env.COMPARISON_MODELS || 4)
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
assert.equal(manifest.models.length, expectedModels)
assert.equal(manifest.corpus.length, 10)
const results = [], errors = [], foreignRequests = []

async function main() {
  fs.mkdirSync(artifacts, { recursive: true })
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return }
    const size = fs.statSync(file).size
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.mp3') ? 'audio/mpeg' : file.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream')
    response.setHeader('Accept-Ranges', 'bytes')
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
      if (start > end || start >= size) { response.writeHead(416); response.end(); return }
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      fs.createReadStream(file, { start, end }).pipe(response)
    } else { response.setHeader('Content-Length', size); fs.createReadStream(file).pipe(response) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
  await context.addInitScript(() => {
    window.verificationPlayers = []
    const original = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) { if (!window.verificationPlayers.includes(this)) window.verificationPlayers.push(this); return original.apply(this, args) }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) foreignRequests.push(request.url()) })
  const passed = message => { results.push(message); console.log(`PASS ${message}`) }
  try {
    await page.goto(`${origin}/index.html`)
    await expect(page.locator('.model-card')).toHaveCount(expectedModels)
    await expect(page.locator('.sentence-button')).toHaveCount(10)
    const sorted = [...manifest.models].sort((a, b) => a.model_download_bytes - b.model_download_bytes || a.id.localeCompare(b.id))
    assert.deepEqual(await page.locator('.model-name').allTextContents(), sorted.map(model => model.name))
    for (const row of manifest.corpus) {
      await page.locator(`[data-sentence="${row.id}"]`).click()
      await expect(page.locator('.script-text')).toHaveText(row.text)
      await expect(page.locator('.model-card .play-button')).toHaveCount(expectedModels)
      for (const model of sorted) {
        const sample = model.samples.find(sample => sample.id === row.id)
        const card = page.locator(`[data-card="${model.id}/${row.id}"]`)
        await expect(card.locator('.metric-value').first()).toHaveText(`${sample.generation_seconds.toFixed(2)} 秒`)
        await expect(card.locator('.metric-value').nth(1)).toHaveText(`${sample.duration_seconds.toFixed(2)} 秒`)
        if (sample.normalized_text && sample.normalized_text !== sample.text) {
          await card.locator('.sample-record > summary').click()
          await expect(card.locator('.sample-record')).toContainText(sample.normalized_text)
          await expect(card.locator('.sample-record')).toContainText('含前端规范化')
          await card.locator('.sample-record > summary').click()
        }
        if (sample.source_record?.notes != null) {
          await card.locator('.sample-record > summary').click()
          const notes = sample.source_record.notes
          await expect(card.locator('.sample-record > dl')).toContainText(typeof notes === 'string' ? notes : JSON.stringify(notes, null, 2))
          if (sample.source_record.reused || sample.source_record.reused_from || sample.source_record.reuse) await expect(card.locator('.sample-record > dl')).toContainText('音频复用来源与计时')
          await card.locator('.sample-record > summary').click()
        }
      }
    }
    passed(`正式 ${expectedModels * 10} 条原文、按实际下载量排序、逐句实际耗时和时长、规范化输入记录均与清单一致`)

    await page.locator('[data-sentence="01"]').click()
    for (const model of sorted) {
      await page.locator(`[data-play="${model.id}/01"]`).click()
      await expect.poll(() => page.evaluate(() => window.verificationPlayers[0]?.currentTime || 0)).toBeGreaterThan(.1)
      await expect.poll(() => page.evaluate(() => window.verificationPlayers.filter(player => !player.paused).length)).toBe(1)
      assert.deepEqual(await page.evaluate(() => ({ volume: window.verificationPlayers[0].volume, speed: window.verificationPlayers[0].playbackRate })), { volume: 1, speed: 1 })
    }
    await page.getByRole('button', { name: '按模型查看', exact: true }).click()
    assert.equal(await page.evaluate(() => window.verificationPlayers[0].paused && !window.verificationPlayers[0].getAttribute('src')), true)
    for (const model of sorted) {
      await page.locator(`[data-model="${model.id}"]`).click()
      await expect(page.locator('.sample-row')).toHaveCount(10)
      assert.deepEqual(await page.locator('.sample-row > div > p:first-of-type').allTextContents(), manifest.corpus.map(row => row.text))
    }
    passed('每模型 10 条全部可访问；真实播放互斥，切换模式释放音源，不调整音量或速度')

    await page.getByRole('button', { name: '按句对比', exact: true }).click()
    await page.getByRole('button', { name: '随机盲听', exact: true }).click()
    await expect(page.locator('.model-name').first()).toHaveText('声音 A')
    const blindBody = await page.locator('body').innerText()
    assert(sorted.every(model => !blindBody.includes(model.name)))
    await expect(page.locator('.metrics,.details,.sample-record')).toHaveCount(0)
    await page.locator('.play-button').first().click()
    await expect.poll(() => page.evaluate(() => window.verificationPlayers[0].currentTime)).toBeGreaterThan(.1)
    const blindId = (await page.evaluate(() => window.verificationPlayers[0].src)).split('/').at(-2)
    await page.getByRole('button', { name: '显示模型', exact: true }).click()
    await expect(page.locator(`[data-card^="${blindId}/"] .model-ordinal`)).toContainText('盲听 A')
    passed('盲听随机排序并隐藏模型/性能/前端记录，揭晓后保留声音与模型的字母对应关系')

    await page.screenshot({ path: path.join(artifacts, 'comparison-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: path.join(artifacts, 'comparison-mobile.png'), fullPage: true })
    await page.goto(`${origin}/Open-Media-Chinese-TTS-Comparison.html`)
    await context.setOffline(true)
    const decoded = await page.evaluate(async () => {
      const results = []
      const context = new AudioContext()
      try {
        for (const model of DATA.models) for (const sample of model.samples) {
          if (!sample.mp3.startsWith('data:audio/mpeg;base64,')) throw new Error('单文件缺少内嵌音频')
          const response = await fetch(sample.mp3)
          const audio = await context.decodeAudioData(await response.arrayBuffer())
          const values = audio.getChannelData(0)
          let energy = 0, peak = 0
          for (let index = 0; index < values.length; index++) { energy += values[index] ** 2; peak = Math.max(peak, Math.abs(values[index])) }
          const rms = Math.sqrt(energy / values.length)
          if (rms <= 1e-6 || Math.abs(audio.duration - sample.duration_seconds) > .2) throw new Error(`内嵌音频静音或时长异常 ${model.id}/${sample.id}`)
          results.push({ model: model.id, id: sample.id, duration: audio.duration, sampleRate: audio.sampleRate, peak, rms })
        }
      } finally { await context.close() }
      return results
    })
    assert.equal(decoded.length, expectedModels * 10)
    fs.writeFileSync(path.join(artifacts, 'offline-decoding.json'), JSON.stringify(decoded, null, 2))
    for (const model of sorted) {
      await page.locator(`[data-play="${model.id}/01"]`).click()
      await expect.poll(() => page.evaluate(() => window.verificationPlayers[0]?.currentTime || 0)).toBeGreaterThan(.1)
      assert.equal(await page.evaluate(() => window.verificationPlayers[0].src.startsWith('data:audio/mpeg;base64,')), true)
    }
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.verificationPlayers[0].paused && !window.verificationPlayers[0].getAttribute('src')), true)
    assert.deepEqual(errors, [])
    assert.deepEqual(foreignRequests, [])
    passed(`390px 无溢出，单文件断网后 ${decoded.length} 条音频全部实际解码为非静音且时长一致，每模型真实播放，Esc 释放；无外部请求/脚本错误`)
    fs.writeFileSync(path.join(artifacts, 'browser-validation.json'), JSON.stringify({ models: expectedModels, samples: decoded.length, results, errors, foreignRequests, fileProtocolNote: '环境策略禁止 file://；通过 localhost 打开单文件后切断网络，验证全部内嵌音频可脱网解码与播放。' }, null, 2))
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await context.close()
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
