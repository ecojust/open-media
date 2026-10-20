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
    const calls = []
    const appearance = createNativeAppearanceSync({ getWindow: async () => ({
      label,
      setTheme: async theme => { calls.push(['theme', theme]) },
      setBackgroundColor: async color => { calls.push(['background', color]) },
    }) })
    await appearance.sync('dark')
    assert.deepEqual(calls, [])
  }
})

test('appearance coalesces theme switches while the native bridge loads', async () => {
  const bridge = deferred(), calls = []
  const appearance = createNativeAppearanceSync({ getWindow: () => bridge.promise })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  bridge.resolve({
    label: 'main',
    setTheme: async theme => { calls.push(['theme', theme]) },
    setBackgroundColor: async color => { calls.push(['background', color]) },
  })
  await completion
  assert.deepEqual(calls, [['theme', 'dark'], ['background', '#151923']])
  await appearance.sync('dark')
  assert.deepEqual(calls, [['theme', 'dark'], ['background', '#151923']], 'a successful identical appearance does not write again')
})

test('appearance serializes native theme and background writes while coalescing queued changes', async () => {
  const firstTheme = deferred(), firstBackground = deferred(), calls = []
  const appearance = createNativeAppearanceSync({ getWindow: async () => ({
    label: 'main',
    setTheme: async theme => {
      calls.push(['theme', theme])
      if (calls.length === 1) await firstTheme.promise
    },
    setBackgroundColor: async color => {
      calls.push(['background', color])
      if (calls.length === 2) await firstBackground.promise
    },
  }) })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  void appearance.sync('light')
  void appearance.sync('dark')
  await tick()
  assert.deepEqual(calls, [['theme', 'light']], 'the next theme cannot overtake a pending native theme')
  firstTheme.resolve()
  await tick()
  assert.deepEqual(calls, [['theme', 'light'], ['background', '#f7f9fc']], 'the next theme also waits for the window/webview background')
  firstBackground.resolve()
  await completion
  assert.deepEqual(calls, [['theme', 'light'], ['background', '#f7f9fc'], ['theme', 'dark'], ['background', '#151923']])
})

test('a theme queued during batch completion remains covered by the returned promise', async () => {
  const nextTheme = deferred(), calls = []
  let queued, completed = false
  const appearance = createNativeAppearanceSync({ getWindow: async () => ({
    label: 'main',
    setTheme: async theme => {
      calls.push(['theme', theme])
      if (theme === 'dark') await nextTheme.promise
    },
    setBackgroundColor: async color => {
      calls.push(['background', color])
      if (color === '#f7f9fc') queueMicrotask(() => queueMicrotask(() => {
        queued = appearance.sync('dark').then(() => { completed = true })
      }))
    },
  }) })
  const completion = appearance.sync('light')
  await tick()
  try {
    assert.deepEqual(calls, [['theme', 'light'], ['background', '#f7f9fc'], ['theme', 'dark']])
    assert.equal(completed, false, 'sync must wait for the batch that actually applies its queued theme')
  } finally { nextTheme.resolve() }
  await Promise.all([completion, queued])
  assert.equal(completed, true)
  assert.deepEqual(calls.at(-1), ['background', '#151923'])
})

test('system mode releases the native override even when the effective color is unchanged', async () => {
  const calls = []
  const appearance = createNativeAppearanceSync({ getWindow: async () => ({
    label: 'main',
    setTheme: async theme => { calls.push(['theme', theme]) },
    setBackgroundColor: async color => { calls.push(['background', color]) },
  }) })
  await appearance.sync('dark')
  await appearance.sync('dark', true)
  await appearance.sync('dark', true)
  await appearance.sync('light', true)
  await appearance.sync('light')
  assert.deepEqual(calls, [
    ['theme', 'dark'], ['background', '#151923'],
    ['theme', null], ['background', '#151923'],
    ['theme', null], ['background', '#f7f9fc'],
    ['theme', 'light'], ['background', '#f7f9fc'],
  ])
})

for (const failingStep of ['theme', 'background']) {
  test(`${failingStep} failures invalidate the completed appearance and allow a previous theme to be restored`, async () => {
    const calls = [], warnings = []
    let fail = false
    const appearance = createNativeAppearanceSync({ warn: cause => warnings.push(cause), getWindow: async () => ({
      label: 'main',
      setTheme: async theme => {
        calls.push(['theme', theme])
        if (fail && failingStep === 'theme') throw new Error('theme update rejected')
      },
      setBackgroundColor: async color => {
        calls.push(['background', color])
        if (fail && failingStep === 'background') throw new Error('background update rejected')
      },
    }) })
    await appearance.sync('light')
    fail = true
    await appearance.sync('dark')
    await appearance.sync('dark')
    assert.equal(warnings.length, 1)
    fail = false
    await appearance.sync('light')
    await appearance.sync('light')
    assert.deepEqual(calls, [
      ['theme', 'light'], ['background', '#f7f9fc'],
      ['theme', 'dark'], ...(failingStep === 'background' ? [['background', '#151923']] : []),
      ['theme', 'dark'], ...(failingStep === 'background' ? [['background', '#151923']] : []),
      ['theme', 'light'], ['background', '#f7f9fc'],
    ])
  })
}

test('a failed in-flight theme still permits the newest queued appearance to complete', async () => {
  const first = deferred(), calls = [], warnings = []
  const appearance = createNativeAppearanceSync({ warn: cause => warnings.push(cause), getWindow: async () => ({
    label: 'main',
    setTheme: async theme => {
      calls.push(['theme', theme])
      if (calls.length === 1) { await first.promise; throw new Error('theme update rejected') }
    },
    setBackgroundColor: async color => { calls.push(['background', color]) },
  }) })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  first.resolve()
  await completion
  assert.equal(warnings.length, 1)
  assert.deepEqual(calls, [['theme', 'light'], ['theme', 'dark'], ['background', '#151923']])
})

test('disposing appearance discards queued updates and prevents late bridge writes', async () => {
  const bridge = deferred(), calls = []
  const appearance = createNativeAppearanceSync({ getWindow: () => bridge.promise })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  appearance.dispose()
  bridge.resolve({
    label: 'main',
    setTheme: async theme => { calls.push(['theme', theme]) },
    setBackgroundColor: async color => { calls.push(['background', color]) },
  })
  await completion
  await appearance.sync('light')
  assert.deepEqual(calls, [])
})

test('disposing while native theme is in flight prevents later background and queued theme writes', async () => {
  const first = deferred(), calls = []
  const appearance = createNativeAppearanceSync({ getWindow: async () => ({
    label: 'main',
    setTheme: async theme => { calls.push(['theme', theme]); await first.promise },
    setBackgroundColor: async color => { calls.push(['background', color]) },
  }) })
  const completion = appearance.sync('light')
  await tick()
  void appearance.sync('dark')
  appearance.dispose()
  first.resolve()
  await completion
  assert.deepEqual(calls, [['theme', 'light']])
})
