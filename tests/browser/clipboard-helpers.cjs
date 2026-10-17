const assert = require('node:assert/strict')

async function inspectClipboard(page, coordinates) {
  const result = await page.evaluate(async coordinates => {
    const items = await navigator.clipboard.read()
    const item = items.find(item => item.types.includes('image/png'))
    if (!item) throw new Error(`剪贴板中没有图片：${items.flatMap(item => item.types).join(', ')}`)
    const blob = await item.getType('image/png')
    const bytes = await blob.arrayBuffer()
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0)
      const points = coordinates ?? [[Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2)]]
      return {
        width: bitmap.width, height: bitmap.height,
        pixels: points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]),
        header: [...new Uint8Array(bytes).slice(0, 8)],
        digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''),
      }
    } finally { bitmap.close() }
  }, coordinates)
  assert.deepEqual(result.header, [137, 80, 78, 71, 13, 10, 26, 10], '真实剪贴板内容必须是 PNG 图片')
  return result
}

module.exports = { inspectClipboard }
