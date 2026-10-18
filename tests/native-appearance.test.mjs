import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeAppearanceSync } from '../src/native-appearance.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('browser execution skips native appearance without loading an IPC bridge', async () => {
  const warnings = []
  const appearance = createNativeAppearanceSync({ warn: cause => warnings.push(cause) })
  await appearance.sync('dark')
  assert.deepEqual(warnings, [])
})

test('appearance leaves capture and recording windows untouched', async () => {
  for (const label of ['capture-picker', 'recording-controls']) {
    const colors = []
    const appearance = createNativeAppearanceSync({ getWindow: async () => ({ label, setBackgroundColor: async color => { colors.push(color) } }) })
    await appearance.sync('dark')
    assert.deepEqual(colors, [])
  }
})

test('appearance coalesces theme switches while the native bridge loads', async () => {
  const bridge = deferred(), colors = []
  const appearance = createNativeAppearanceSync({ getWindow: () => bridge.promise })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  bridge.resolve({ label: 'main', setBackgroundColor: async color => { colors.push(color) } })
  await completion
  assert.deepEqual(colors, ['#151923'])
  await appearance.sync('dark')
  assert.deepEqual(colors, ['#151923'], 'a successful identical theme does not write again')
})

test('appearance waits for each window/webview pair before applying the newest queued color', async () => {
  const first = deferred(), colors = []
  let active = 0, maximumActive = 0
  const appearance = createNativeAppearanceSync({ getWindow: async () => ({ label: 'main', setBackgroundColor: async color => {
    colors.push(color)
    active++
    maximumActive = Math.max(active, maximumActive)
    if (colors.length === 1) await first.promise
    active--
  } }) })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  void appearance.sync('light')
  void appearance.sync('dark')
  await tick()
  assert.deepEqual(colors, ['#f7f9fc'])
  first.resolve()
  await completion
  assert.deepEqual(colors, ['#f7f9fc', '#151923'])
  assert.equal(maximumActive, 1)
})

test('appearance failures are contained and warn once without blocking later changes', async () => {
  const colors = [], warnings = []
  let fail = true
  const appearance = createNativeAppearanceSync({ warn: cause => warnings.push(cause), getWindow: async () => ({ label: 'main', setBackgroundColor: async color => {
    colors.push(color)
    if (fail) throw new Error('background update rejected')
  } }) })
  await appearance.sync('dark')
  await appearance.sync('light')
  assert.equal(warnings.length, 1)
  fail = false
  await appearance.sync('light')
  await appearance.sync('light')
  assert.deepEqual(colors, ['#151923', '#f7f9fc', '#f7f9fc'])
})

test('disposing appearance discards queued updates and prevents late bridge writes', async () => {
  const bridge = deferred(), colors = []
  const appearance = createNativeAppearanceSync({ getWindow: () => bridge.promise })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  appearance.dispose()
  bridge.resolve({ label: 'main', setBackgroundColor: async color => { colors.push(color) } })
  await completion
  await appearance.sync('light')
  assert.deepEqual(colors, [])
})
