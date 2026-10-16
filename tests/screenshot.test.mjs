import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SCREENSHOT_SHORTCUT, matchesScreenshotShortcut, screenshotShortcutFromEvent, screenshotShortcutLabel, screenshotShortcutValidationError, takeBrowserScreenshot } from '../src/core/screenshot.ts'

const key = (overrides = {}) => ({ key: '2', code: 'Digit2', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides })
test('screenshot shortcut respects physical digit key and platform primary modifier', () => {
  assert.equal(matchesScreenshotShortcut(key({ key: '@', ctrlKey: true, shiftKey: true }), DEFAULT_SCREENSHOT_SHORTCUT, false), true)
  assert.equal(matchesScreenshotShortcut(key({ key: '@', metaKey: true, shiftKey: true }), DEFAULT_SCREENSHOT_SHORTCUT, true), true)
  assert.equal(matchesScreenshotShortcut(key({ ctrlKey: true, shiftKey: true }), DEFAULT_SCREENSHOT_SHORTCUT, true), false)
  assert.equal(matchesScreenshotShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), DEFAULT_SCREENSHOT_SHORTCUT, false), false)
  assert.equal(matchesScreenshotShortcut(key({ ctrlKey: true, shiftKey: true, repeat: true }), DEFAULT_SCREENSHOT_SHORTCUT, false), false)
  assert.equal(matchesScreenshotShortcut(key({ ctrlKey: true, shiftKey: true }), null, false), false)
})
test('shortcut editing accepts supported primary modifiers and excludes composition and unsupported function keys', () => {
  assert.equal(screenshotShortcutFromEvent(key({ key: '∑', code: 'KeyW', altKey: true }), true), 'Alt+W')
  assert.equal(screenshotShortcutFromEvent(key({ key: '@', metaKey: true, shiftKey: true }), true), 'Cmd+Shift+2')
  assert.equal(screenshotShortcutFromEvent(key({ ctrlKey: true, shiftKey: true }), false), 'Ctrl+Shift+2')
  assert.equal(screenshotShortcutFromEvent(key({ shiftKey: true })), null)
  assert.equal(screenshotShortcutFromEvent(key({ key: 'F20', code: 'F20', ctrlKey: true })), 'Ctrl+F20')
  assert.equal(screenshotShortcutFromEvent(key({ key: 'F21', code: 'F21', ctrlKey: true })), null)
  assert.equal(screenshotShortcutFromEvent(key({ ctrlKey: true, isComposing: true })), null)
  assert.equal(screenshotShortcutLabel(DEFAULT_SCREENSHOT_SHORTCUT, false), 'Ctrl + Shift + 2')
  assert.equal(screenshotShortcutLabel('Cmd+Shift+2', true), '⌘ ⇧ 2')
})
test('screenshot shortcuts preserve existing save, open, undo and redo combinations', () => {
  for (const primary of ['Ctrl', 'Control', 'Cmd', 'Command', 'Meta', 'Super', 'CommandOrControl', 'CmdOrCtrl']) {
    for (const shift of ['', 'Shift+']) {
      for (const [key, action] of [['S', '保存'], ['O', '打开'], ['Z', shift ? '重做' : '撤销'], ['Y', '重做']]) {
        assert.match(screenshotShortcutValidationError(`${primary}+${shift}${key}`), new RegExp(action))
      }
    }
  }
  assert.equal(screenshotShortcutValidationError(' ctrl + shift + z '), '此快捷键用于重做，请选择其他组合。')
  for (const shortcut of [null, DEFAULT_SCREENSHOT_SHORTCUT, 'Ctrl+Alt+S', 'Cmd+Option+O', 'Alt+Z', 'Ctrl+Shift+K', 'Cmd+F20']) {
    assert.equal(screenshotShortcutValidationError(shortcut), '')
  }
})

function fixture(t, { request, emptyPng = false } = {}) {
  const log = [], canvases = []
  let stops = 0
  const track = new EventTarget()
  Object.assign(track, { readyState: 'live', label: '测试屏幕', stop() { stops++; this.readyState = 'ended'; log.push('stop') }, getSettings: () => ({ displaySurface: 'monitor', width: 640, height: 360 }) })
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  const video = new EventTarget()
  Object.assign(video, { readyState: 2, videoWidth: 640, videoHeight: 360, srcObject: null, play: async () => {}, pause() { log.push('pause') }, remove() { log.push('remove') } })
  const originals = new Map()
  for (const name of ['navigator', 'document']) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia(options) { log.push(['request', options]); return request ? request(stream) : Promise.resolve(stream) } } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(name) {
    if (name === 'video') return video
    assert.equal(name, 'canvas')
    const canvas = { width: 0, height: 0, draws: [], getContext: () => ({ drawImage(...args) { canvas.draws.push(args); log.push(['draw', canvases.indexOf(canvas)]) } }), toBlob(callback, mime) { log.push(['png', canvases.indexOf(canvas)]); callback(emptyPng ? null : new Blob(['fixture'], { type: mime })) } }
    canvases.push(canvas)
    return canvas
  } } })
  t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] } })
  return { log, canvases, video, stream, stops: () => stops }
}
test('browser screenshot freezes one frame before selection, releases sharing, and crops the original pixels', async t => {
  const env = fixture(t)
  const result = await takeBrowserScreenshot({ chooseSource: async request => {
    assert.equal(request.source.width, 640)
    assert.match(request.imageUrl, /^blob:/)
    assert.ok(env.stops() > 0, 'sharing must stop before the selection UI appears')
    assert.deepEqual(env.canvases[0].draws, [[env.video, 0, 0]])
    return { region: { x: 24, y: 16, width: 120, height: 80 }, outputSize: { width: 1920, height: 1080 } }
  } })
  assert.equal(result.blob.type, 'image/png')
  assert.match(result.name, /^截屏-.*\.png$/)
  assert.equal(result.width, 120)
  assert.equal(result.height, 80)
  assert.deepEqual(env.canvases[1].draws[0], [env.canvases[0], 24, 16, 120, 80, 0, 0, 120, 80])
  assert.equal(env.video.srcObject, null)
  assert.deepEqual(env.log[0], ['request', { video: true, audio: false }])
})
test('cancelled permission request discards a stream that arrives later', async t => {
  let complete
  const env = fixture(t, { request: stream => new Promise(resolve => { complete = () => resolve(stream) }) })
  const abort = new AbortController()
  const result = takeBrowserScreenshot({ signal: abort.signal })
  abort.abort()
  await assert.rejects(result, { name: 'AbortError' })
  complete()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(env.stops(), 1)
  assert.equal(env.canvases.length, 0)
})
test('cancelled selection and invalid crops do not return a screenshot and release the source', async t => {
  const env = fixture(t)
  await assert.rejects(takeBrowserScreenshot({ chooseSource: async () => null }), { name: 'AbortError' })
  assert.ok(env.stops() > 0)
  env.stream.getVideoTracks()[0].readyState = 'live'
  await assert.rejects(takeBrowserScreenshot({ chooseSource: async () => ({ region: { x: 630, y: 0, width: 100, height: 100 } }) }), /截屏范围已超出/)
  assert.equal(env.video.srcObject, null)
})
test('PNG serialization errors release all display resources', async t => {
  const env = fixture(t, { emptyPng: true })
  await assert.rejects(takeBrowserScreenshot(), /无法生成截屏图片/)
  assert.ok(env.stops() > 0)
  assert.equal(env.video.srcObject, null)
})
