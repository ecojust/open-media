import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getDesktopPlatform } from '../src/native-platform.ts'

test('desktop platform uses the native host and leaves web identity intact', async () => {
  const previousWindow = globalThis.window
  try {
    delete globalThis.window
    assert.equal(await getDesktopPlatform(), null)
    globalThis.window = {}
    assert.equal(await getDesktopPlatform(), null)

    const commands = []
    let platform = 'windows'
    globalThis.window = { __TAURI_INTERNALS__: { invoke: async command => { commands.push(command); return platform } } }
    assert.equal(await getDesktopPlatform(), 'windows')
    platform = 'macos'
    assert.equal(await getDesktopPlatform(), 'macos')
    platform = 'linux'
    assert.equal(await getDesktopPlatform(), 'linux')
    platform = 'freebsd'
    assert.equal(await getDesktopPlatform(), 'other')
    platform = undefined
    assert.equal(await getDesktopPlatform(), null)
    assert.deepEqual(commands, Array(5).fill('get_desktop_platform'))

    globalThis.window.__TAURI_INTERNALS__.invoke = async () => { throw new Error('Host unavailable') }
    assert.equal(await getDesktopPlatform(), null)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
