import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'src/assets/branding/open-media-logo.png'))
if (source.readUInt32BE(16) !== 1254 || source.readUInt32BE(20) !== 1254) {
  throw new Error('图标原稿尺寸已改变，请先重新确认主图案边界。')
}

// Frame the existing artwork without redrawing it. The opaque artwork spans
// x=137..1117, y=160..1133 in the source. This centered square leaves about
// 2.5% padding per side, so the Dock icon occupies about 95% of its canvas.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="112 131.5 1030 1030"><image width="1254" height="1254" href="data:image/png;base64,${source.toString('base64')}"/></svg>`
const temporary = await mkdtemp(join(tmpdir(), 'open-media-macos-icon-'))
try {
  const input = join(temporary, 'icon.svg'), output = join(temporary, 'icons')
  await writeFile(input, svg)
  execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', input, '--output', output], { cwd: root, stdio: 'pipe' })
  // Keep the in-app branding and all other platform icons unchanged.
  await copyFile(join(output, 'icon.icns'), join(root, 'src-tauri/icons/icon.icns'))
  console.log('已更新 macOS 应用图标；原稿和界面图标保持原样。')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
