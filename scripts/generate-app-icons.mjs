import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The icon writer may order ICNS representations differently on each run.
// Compare their contents before replacing an otherwise identical existing icon.
function icnsRepresentations(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) throw new Error('无效的应用图标容器。')
  const representations = []
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('应用图标条目不完整。')
    const length = bytes.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > bytes.length) throw new Error('应用图标条目尺寸无效。')
    representations.push(bytes.subarray(offset, offset + length)); offset += length
  }
  return Buffer.concat(representations.sort(Buffer.compare))
}

const source = await readFile(join(root, 'src/assets/branding/open-media-logo.png'))
if (source.readUInt32BE(16) !== 1254 || source.readUInt32BE(20) !== 1254) {
  throw new Error('图标原稿尺寸已改变，请先重新确认主图案边界。')
}

// Frame the existing artwork without redrawing it. The opaque artwork spans
// x=137..1117, y=160..1133 in the source. This centered square leaves about
// 2.5% padding per side, so each desktop icon occupies about 95% of its canvas.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="112 131.5 1030 1030"><image width="1254" height="1254" href="data:image/png;base64,${source.toString('base64')}"/></svg>`
const temporary = await mkdtemp(join(tmpdir(), 'open-media-app-icons-'))
try {
  const input = join(temporary, 'icon.svg'), output = join(temporary, 'icons')
  await writeFile(input, svg)
  execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', input, '--output', output], { cwd: root, stdio: 'pipe' })
  // Windows selects ICO layers for different display scales and PNG resources
  // for the default window icon. Keep every desktop representation in sync.
  const desktopIcons = (await readdir(output)).filter(name => /\.(?:png|ico|icns)$/.test(name))
  for (const name of desktopIcons) {
    const generated = join(output, name), target = join(root, 'src-tauri/icons', name)
    if (name === 'icon.icns') {
      const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (current && icnsRepresentations(current).equals(icnsRepresentations(await readFile(generated)))) continue
    }
    await copyFile(generated, target)
  }
  console.log(`已同步 ${desktopIcons.length} 个桌面图标资源，统一图案占比。`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
