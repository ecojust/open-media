const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 900, height: 1050 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__rhythm_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>' }))
    await page.goto(`${server.resolvedUrls.local[0]}__rhythm_test__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const source = await (await fetch('/src/components/editor-tools/RhythmAssist.vue')).text()
      const { createApp, h, shallowRef, ref } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Component = (await import('/src/components/editor-tools/RhythmAssist.vue')).default
      const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
      const { commitHistory, createHistory, undoHistory } = await import('/src/core/timeline.ts')
      const project = createProject('节奏辅助交互')
      const asset = { id: 'source', kind: 'video', name: '操作演示.mp4', url: 'blob:test', duration: 60, width: 1920, height: 1080, size: 100, mime: 'video/mp4' }
      project.assets.push(asset)
      project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset, project, { id: 'first', start: 10, trimIn: 12, trimOut: 32, speed: 2 }), createClip(asset, project, { id: 'second', start: 30, trimIn: 12, trimOut: 22 }))
      project.tracks.find(track => track.kind === 'text').clips.push(createTextClip(project, { id: 'subtitle', text: '重要的说明', start: 12, trimOut: 4 }))
      const state = shallowRef(project), selected = ref('first'), visible = ref(true)
      let history = createHistory(project)
      const fixture = window.rhythm = { state, selected, visible, calls: [], seeks: [], busy: [], commits: 0, hold: false, aborted: 0 }
      fixture.undo = () => { history = undoHistory(history); state.value = history.present }
      fixture.move = () => { const copy = JSON.parse(JSON.stringify(state.value)); copy.tracks.find(track => track.kind === 'video').clips[0].start++; state.value = copy }
      const run = async (name, args, options) => {
        fixture.calls.push({ name, args })
        if (fixture.hold) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { fixture.aborted++; reject(new DOMException('Cancelled', 'AbortError')) }, { once: true }))
        options.onProgress({ stage: '正在检测素材' })
        return { data: { intervals: [{ kind: 'freeze', start: 16, end: 24, confidence: 1 }], detectors: ['black', 'freeze'] } }
      }
      const app = createApp({ render: () => h('main', { style: 'width:480px;--ed-border:#d2d7df;--ed-bg:#fff;--ed-panel:#f4f6f8;--ed-text:#17243a;--ed-muted:#526079;--ed-accent:#5274e3' }, visible.value && h(Component, { project: state.value, selectedClipId: selected.value, runTool: run,
        onChange: next => { history = commitHistory(history, next); state.value = next; fixture.commits++ }, onSeek: (time, clipId) => fixture.seeks.push({ time, clipId }), onBusy: value => fixture.busy.push(value),
      })) })
      app.mount('#app')
    })
    await expect(page.getByLabel('节奏分析范围')).toHaveValue('selected')
    await page.getByTestId('rhythm-analyze').click()
    await expect(page.getByTestId('rhythm-candidate')).toHaveCount(1)
    await expect(page.getByTestId('rhythm-candidate')).toContainText('00:12.000–00:16.000')
    await expect(page.getByTestId('rhythm-candidate')).toContainText('同期有字幕 / 标注')
    await expect(page.getByText('操作演示.mp4 没有音轨。', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '定位 00:12.000', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.rhythm.seeks), [{ time: 12, clipId: 'first' }])
    await page.getByLabel('选择 00:12.000 的候选').check()
    await expect(page.locator('.rhythm-summary')).toContainText('覆盖 4.00 秒')
    await page.getByTestId('rhythm-add-markers').click()
    assert.equal(await page.evaluate(() => window.rhythm.state.value.markers.length), 1)
    assert.equal(await page.evaluate(() => window.rhythm.commits), 1)
    await page.getByTestId('rhythm-add-markers').click()
    assert.equal(await page.evaluate(() => window.rhythm.commits), 1)
    await page.evaluate(() => window.rhythm.undo())
    assert.equal(await page.evaluate(() => window.rhythm.state.value.markers?.length || 0), 0)
    console.log('PASS 选中片段映射、同期提示、定位、标记幂等与一次撤销')

    await page.getByLabel('节奏分析范围').selectOption('project')
    await page.getByTestId('rhythm-analyze').click()
    await expect(page.getByTestId('rhythm-candidate')).toHaveCount(2)
    assert.equal(await page.evaluate(() => window.rhythm.calls.length), 2, '同一源视频只调用一次')
    await page.getByRole('button', { name: '勾选筛选结果', exact: true }).click()
    await expect(page.locator('.rhythm-summary')).toContainText('覆盖 10.00 秒')
    await page.evaluate(() => window.rhythm.move())
    await expect(page.getByText('时间线或素材已改变，请重新分析；旧结果不能定位或添加标记。')).toBeVisible()
    await expect(page.getByTestId('rhythm-add-markers')).toBeDisabled()
    await expect(page.getByRole('button', { name: '定位 00:12.000', exact: true })).toBeDisabled()
    console.log('PASS 项目分析、同源去重、候选多选与过期结果阻止操作')

    await page.evaluate(() => { window.rhythm.hold = true })
    await page.getByTestId('rhythm-analyze').click()
    await expect(page.getByRole('button', { name: '取消处理', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消处理', exact: true }).click()
    await expect(page.getByText('已取消', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.rhythm.aborted), 1)
    await page.getByTestId('rhythm-analyze').click()
    await page.evaluate(() => window.rhythm.move())
    await expect(page.getByText('时间线或素材已改变，请重新分析；旧结果不能定位或添加标记。')).toBeVisible()
    assert.equal(await page.evaluate(() => window.rhythm.aborted), 2)
    await expect(page.getByTestId('rhythm-candidate')).toHaveCount(0)
    assert.equal((await page.evaluate(() => window.rhythm.busy)).at(-1), false)
    assert.deepEqual(errors, [])
    console.log('PASS 主动取消、工程变化中止与忙碌状态释放；无浏览器异常')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
