const repository = 'ecojust/open-media'
const tag = 'ai-runtime-v1'
const apiRoot = `https://api.github.com/repos/${repository}`
const downloadRoot = `https://github.com/${repository}/releases/download/${tag}/`
const platforms = ['macos-arm64', 'windows-x64', 'linux-x64']
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const positiveSize = value => Number.isSafeInteger(value) && value > 0

export function aiRuntimeRequirements(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.runtimes) || catalog.runtimes.length !== 1) {
    throw new Error('A populated, supported AI runtime catalog is required before publication.')
  }
  const runtime = catalog.runtimes[0]
  if (runtime?.id !== 'ai-generation-v1' || runtime.version !== 1 || !runtime.platforms
      || Object.keys(runtime.platforms).sort().join(',') !== [...platforms].sort().join(',')) {
    throw new Error('The AI runtime catalog must include every supported platform and runtime version.')
  }
  const required = []
  for (const platform of platforms) {
    const archive = runtime.platforms[platform]
    const name = `${tag}-${platform}.zip`
    if (!archive || archive.url !== `${downloadRoot}${name}` || !positiveSize(archive.size)
        || !positiveSize(archive.unpackedSize) || !sha256(archive.sha256) || !sha256(archive.manifestSha256)) {
      throw new Error(`Invalid official AI runtime archive: ${platform}`)
    }
    const parts = archive.parts === undefined ? [archive] : archive.parts
    if (!Array.isArray(parts) || !parts.length) throw new Error(`Missing AI runtime parts: ${platform}`)
    let total = 0
    for (const [index, part] of parts.entries()) {
      const filename = archive.parts === undefined ? name : `${name}.part${String(index + 1).padStart(3, '0')}`
      if (!part || part.url !== `${downloadRoot}${filename}` || !positiveSize(part.size) || !sha256(part.sha256)) {
        throw new Error(`Invalid official AI runtime part: ${platform}`)
      }
      total += part.size
      required.push({ runtimeId: runtime.id, platform, name: filename, url: part.url, size: part.size, sha256: part.sha256 })
    }
    if (!Number.isSafeInteger(total) || total !== archive.size) throw new Error(`AI runtime part sizes do not match the archive: ${platform}`)
  }
  return required
}

function verifyPublicRelease(release) {
  if (!release || !positiveSize(release.id) || release.draft !== false || release.tag_name !== tag
      || !release.published_at || !Number.isFinite(Date.parse(release.published_at))
      || release.url !== `${apiRoot}/releases/${release.id}`
      || release.html_url !== `https://github.com/${repository}/releases/tag/${tag}`) {
    throw new Error('The official AI runtime release is missing, unpublished, or belongs to a different source.')
  }
}

export function verifyAiRuntimeAssets(required, release, assets) {
  verifyPublicRelease(release)
  if (!Array.isArray(required) || !required.length) throw new Error('AI runtime asset requirements must not be empty.')
  if (!Array.isArray(assets) || assets.some(asset => !asset || !positiveSize(asset.id) || typeof asset.name !== 'string')
      || new Set(assets.map(asset => asset.name)).size !== assets.length
      || new Set(assets.map(asset => asset.id)).size !== assets.length) {
    throw new Error('AI runtime release assets are invalid or duplicated.')
  }
  const verified = required.map(expected => {
    const asset = assets.find(item => item.name === expected.name)
    if (!asset || asset.state !== 'uploaded' || asset.size !== expected.size
        || asset.digest !== `sha256:${expected.sha256}` || asset.browser_download_url !== expected.url
        || asset.url !== `${apiRoot}/releases/assets/${asset.id}`) {
      throw new Error(`AI runtime release asset is missing or differs from the pinned catalog: ${expected.name}`)
    }
    return { ...expected, assetId: asset.id, digest: asset.digest }
  })
  return { schema: 1, kind: 'public-github-release-assets', repository, tag, releaseId: release.id,
    url: release.html_url, publishedAt: release.published_at, assets: verified }
}

export async function verifyPublishedAiRuntime(catalog, { fetchImpl = fetch } = {}) {
  const required = aiRuntimeRequirements(catalog)
  // Deliberately unauthenticated: a private/draft release must not appear usable
  // merely because the publisher has a token. Catalog and mirror URLs are never
  // requested here; only fixed official JSON API paths are permitted.
  async function publicApi(path) {
    const response = await fetchImpl(`${apiRoot}${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    if (!response.ok) throw new Error(`Public AI runtime API ${path.split('?')[0]} returned ${response.status}.`)
    return response.json()
  }
  const release = await publicApi(`/releases/tags/${tag}`)
  verifyPublicRelease(release)
  const assets = []
  for (let page = 1; page <= 100; page++) {
    const items = await publicApi(`/releases/${release.id}/assets?per_page=100&page=${page}`)
    if (!Array.isArray(items)) throw new Error('Invalid public AI runtime asset listing.')
    assets.push(...items)
    if (items.length < 100) return verifyAiRuntimeAssets(required, release, assets)
  }
  throw new Error('Public AI runtime asset listing exceeded the pagination limit.')
}
