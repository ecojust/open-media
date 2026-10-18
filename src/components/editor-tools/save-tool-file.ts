import { isDesktop, saveBytes } from '../../native'

export async function saveToolFile(blob: Blob, filename: string): Promise<boolean> {
  if (isDesktop()) return Boolean(await saveBytes(filename, new Uint8Array(await blob.arrayBuffer())))
  const url = URL.createObjectURL(blob)
  try { const link = document.createElement('a'); link.href = url; link.download = filename; link.click() }
  finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000) }
  return true
}
