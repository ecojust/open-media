import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { verifySourceContents } from './release-source.mjs'
import { join, resolve } from 'node:path'
import { digest, validateBuild, verifyDigest, verifyMetadata, validateAssetMetadata, verifySpeechMetadata, sourceChecksums, speechSourceRequirements } from './release-validation.mjs'

const repository = process.env.RELEASE_REPOSITORY
const runId = process.env.RELEASE_BUILD_RUN
const commit = process.env.RELEASE_EXPECTED_COMMIT
const token = process.env.GH_TOKEN
if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^\d+$/.test(runId || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Release inputs are missing or invalid.')
const apiRoot = `https://api.github.com/repos/${repository}`
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
async function api(path, options = {}) {
  const { allow404, ...request } = options
  const response = await fetch(`${apiRoot}${path}`, { ...request, headers: { ...headers, ...(request.body ? { 'Content-Type': 'application/json' } : {}), ...request.headers }, signal: AbortSignal.timeout(60000) })
  if (response.status === 404 && allow404) return null
  if (!response.ok) throw new Error(`Repository API ${path.split('?')[0]} returned ${response.status}.`)
  return response.status === 204 ? null : response.json()
}
async function list(path, field) {
  const values = []
  for (let page = 1; ; page++) {
    const result = await api(`${path}?per_page=100&page=${page}`)
    const items = field ? result[field] : result
    values.push(...items)
    if (items.length < 100) return values
  }
}
const [run, jobs, artifacts] = await Promise.all([
  api(`/actions/runs/${runId}`), list(`/actions/runs/${runId}/jobs`, 'jobs'), list(`/actions/runs/${runId}/artifacts`, 'artifacts'),
])
const selected = validateBuild(run, jobs, artifacts, commit)
const sourceFile = path => execFileSync('git', ['show', `${commit}:${path}`], { maxBuffer: 5 * 1024 * 1024 })
const speechLockBytes = sourceFile('scripts/speech-runtime.lock.json')
const speechLock = JSON.parse(speechLockBytes)
const expectedSpeech = { sourceLockSha256: digest(speechLockBytes), prepareScriptSha256: digest(sourceFile('scripts/speech-runtime.mjs')), runnerSourceSha256: digest(sourceFile('scripts/speech-runtime-runner.c')), runnerManifestSha256: digest(sourceFile('scripts/speech-runtime-runner.manifest')), model: speechLock.model }
const speechLicenseFiles = execFileSync('git', ['ls-tree', '-rz', '--name-only', commit, '--', 'licenses/speech-runtime/'], { encoding: 'utf8' }).split('\0').filter(Boolean)
if (!speechLicenseFiles.includes('licenses/speech-runtime/manifest.json') || speechLicenseFiles.length < 2) throw new Error('Original speech dependency and model license texts are required.')

const version = JSON.parse(sourceFile('package.json')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only a stable semantic version can be published by this workflow.')
const tag = `v${version}`
const existingTag = await api(`/git/ref/tags/${tag}`, { allow404: true })
if (existingTag) {
  let target = existingTag.object
  while (target.type === 'tag') target = (await api(`/git/tags/${target.sha}`)).object
  if (target.type !== 'commit' || target.sha !== commit) throw new Error('The version tag already points at a different commit.')
}
const notes = sourceFile(`.github/release-notes/${tag}.md`).toString('utf8')
if (!notes.trim()) throw new Error('Reviewed release notes are required.')
const output = resolve('release-output'), temporary = resolve('.release-staging')
await mkdir(output, { recursive: true }); await mkdir(temporary, { recursive: true })
const payloads = new Map()
const verification = { version, commit, sourceRunId: run.id, sourceRunUrl: run.html_url, platforms: [] }

for (const { platform, artifact } of selected) {
  // Read the redirect explicitly: the repository token is never sent to blob storage.
  const response = await fetch(`${apiRoot}/actions/artifacts/${artifact.id}/zip`, { headers, redirect: 'manual', signal: AbortSignal.timeout(60000) })
  let downloaded = response
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get('location'))
    if (location.protocol !== 'https:') throw new Error('Artifact storage must use HTTPS.')
    downloaded = await fetch(location, { signal: AbortSignal.timeout(300000) })
  }
  if (!downloaded.ok) throw new Error(`Artifact download for ${platform} returned ${downloaded.status}.`)
  const bytes = Buffer.from(await downloaded.arrayBuffer())
  verifyDigest(bytes, artifact.digest)
  const archive = join(temporary, `${platform}.zip`), directory = join(temporary, platform)
  await writeFile(archive, bytes); await mkdir(directory, { recursive: true })
  execFileSync('python3', ['-c', `
import pathlib,stat,sys,zipfile
archive,target,limit=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    files=z.infolist()
    if len(files)>30 or sum(f.file_size for f in files)>int(limit): raise ValueError('Artifact extraction limit exceeded')
    names=set()
    for f in files:
        p=pathlib.PurePosixPath(f.filename)
        if f.is_dir(): continue
        if len(p.parts)!=1 or p.name in ('','.','..') or '\\\\' in f.filename or f.filename in names or stat.S_ISLNK(f.external_attr>>16): raise ValueError('Unsafe artifact entry')
        names.add(f.filename)
    z.extractall(target)
`, archive, directory, String((platform === 'runtime-source' ? 2048 : 512) * 1024 * 1024)], { stdio: 'pipe' })
  const meta = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8'))
  if (platform === 'runtime-source') {
    if (meta.commit !== commit || meta.kind !== 'corresponding-source') throw new Error('Corresponding source commit mismatch.')
  } else {
    verifyMetadata(meta, platform, commit, version)
    if (meta.runtime?.sourceLockSha256 !== digest(sourceFile('scripts/media-runtime.lock.json')) || meta.runtime?.buildScriptSha256 !== digest(sourceFile('scripts/build-media-runtime.sh'))) throw new Error(`Installer contains a stale media runtime: ${platform}`)
    verifySpeechMetadata(meta.speechRuntime, platform, expectedSpeech)
  }
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const content = await readFile(join(directory, file))
    if (digest(content) !== digest(sourceFile(file))) throw new Error(`Bundled notice differs from the source commit: ${file}`)
    payloads.set(file, content)
  }
  if (platform === 'runtime-source') {
    const entries = sourceChecksums(await readFile(join(directory, 'SHA256SUMS'), 'utf8'))
    const mediaFile = 'open-media-runtime-source.tar.gz'
    const source = await readFile(join(directory, mediaFile))
    verifyDigest(source, `sha256:${entries.get(mediaFile)}`)
    if (!source.length) throw new Error('Empty corresponding source archive.')
    const mediaLock = JSON.parse(sourceFile('scripts/media-runtime.lock.json'))
    const archivedFile = path => execFileSync('tar', ['-xOf', join(directory, mediaFile), `media-runtime-source/${path}`], { maxBuffer: 64 * 1024 * 1024 })
    for (const component of mediaLock.sources) verifyDigest(archivedFile(`.media-runtime/downloads/${component.archive}`), `sha256:${component.sha256}`)
    for (const file of ['scripts/media-runtime.lock.json', 'scripts/media-runtime.mjs', 'scripts/build-media-runtime.sh', 'docs/MEDIA_RUNTIME.md', 'THIRD_PARTY_NOTICES.md']) verifyDigest(archivedFile(file), `sha256:${digest(sourceFile(file))}`)
    const sourceName = `Open-Media_${version}_media-runtime-source.tar.gz`
    payloads.set(sourceName, source)
    verification.mediaSource = { artifactId: artifact.id, artifactDigest: artifact.digest, file: sourceName, sha256: digest(source), size: source.length }
    const speechFile = 'open-media-speech-source.tar.gz'
    const speechSource = await readFile(join(directory, speechFile))
    verifyDigest(speechSource, `sha256:${entries.get(speechFile)}`)
    if (!speechSource.length || speechSource.length >= 2 * 1024 * 1024 * 1024) throw new Error('Speech corresponding source archive is empty or exceeds the asset size limit.')
    const speechFiles = speechSourceRequirements(speechLock)
    for (const file of ['scripts/speech-runtime.lock.json', 'scripts/speech-runtime.mjs', 'scripts/speech-runtime-runner.c', 'scripts/speech-runtime-runner.manifest', 'docs/SPEECH_RUNTIME.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE', ...speechLicenseFiles]) speechFiles.set(file, digest(sourceFile(file)))
    verifySourceContents(join(directory, speechFile), 'speech-runtime-source', speechFiles)
    const speechSourceName = `Open-Media_${version}_speech-runtime-source.tar.gz`
    payloads.set(speechSourceName, speechSource)
    verification.speechSource = { artifactId: artifact.id, artifactDigest: artifact.digest, file: speechSourceName, sha256: digest(speechSource), size: speechSource.length, model: speechLock.model, archives: speechLock.sources.map(({ id, version, archive, sha256, kind }) => ({ id, version, archive, sha256, kind })) }
    console.log('Verified complete corresponding media and speech source artifacts.')
    continue
  }
  const checksums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n')
  if (checksums.length !== 1) throw new Error(`Expected exactly one installer for ${platform}.`)
  const match = checksums[0].match(/^([a-f0-9]{64})  ([^/\\]+)$/)
  if (!match || !match[2].endsWith(platform === 'windows-x64' ? '.exe' : '.dmg')) throw new Error(`Invalid installer checksum entry: ${platform}`)
  const installer = await readFile(join(directory, match[2]))
  verifyDigest(installer, `sha256:${match[1]}`)
  if (!installer.length) throw new Error('Empty installer.')
  const name = `Open-Media_${version}_${platform}${platform === 'windows-x64' ? '-setup.exe' : '.dmg'}`
  payloads.set(name, installer)
  verification.platforms.push({ platform, artifactId: artifact.id, artifactDigest: artifact.digest, file: name, sha256: digest(installer), size: installer.length, speechRuntime: meta.speechRuntime })
  console.log(`Verified ${platform}: source, artifact archive, installer and notices.`)
}

const sourceName = `Open-Media_${version}_source.zip`
execFileSync('git', ['archive', '--format=zip', `--prefix=Open-Media-${version}/`, `--output=${join(output, sourceName)}`, commit])
payloads.set(sourceName, await readFile(join(output, sourceName)))
payloads.set('build-info.json', Buffer.from(`${JSON.stringify(verification, null, 2)}\n`))
payloads.set('SHA256SUMS', Buffer.from([...payloads].map(([name, bytes]) => `${digest(bytes)}  ${name}`).join('\n') + '\n'))
for (const [name, bytes] of payloads) await writeFile(join(output, name), bytes)

let release = await api(`/releases/tags/${tag}`, { allow404: true })
if (release && (!release.draft || release.target_commitish !== commit)) throw new Error('This version already exists or its draft targets another commit; refusing to overwrite it.')
if (!release) release = await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `Open Media ${tag}`, body: notes, draft: true, prerelease: false }) })
else release = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ body: notes, name: `Open Media ${tag}` }) })
const uploadUrl = release.upload_url.replace(/\{.*$/, '')
const existing = await list(`/releases/${release.id}/assets`)
for (const asset of existing) if (!payloads.has(asset.name)) throw new Error(`Unexpected draft asset: ${asset.name}`)
for (const [name, bytes] of payloads) {
  const prior = existing.find(asset => asset.name === name)
  if (prior) { validateAssetMetadata(prior, name, bytes); continue }
  const url = new URL(uploadUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'uploads.github.com') throw new Error('Unexpected release upload endpoint.')
  url.searchParams.set('name', name)
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw new Error(`Asset upload returned ${response.status}: ${name}`)
  validateAssetMetadata(await response.json(), name, bytes)
}
const uploaded = await list(`/releases/${release.id}/assets`)
if (uploaded.length !== payloads.size) throw new Error('Release asset count mismatch.')
for (const [name, bytes] of payloads) validateAssetMetadata(uploaded.find(asset => asset.name === name) || {}, name, bytes)
const beforePublishTag = await api(`/git/ref/tags/${tag}`, { allow404: true })
if (beforePublishTag) {
  let target = beforePublishTag.object
  while (target.type === 'tag') target = (await api(`/git/tags/${target.sha}`)).object
  if (target.type !== 'commit' || target.sha !== commit) throw new Error('Version tag changed before publishing; leaving the release as a draft.')
}
release = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' }) })
const latest = await api('/releases/latest')
if (latest.id !== release.id || latest.draft || latest.prerelease) throw new Error('Published release was not confirmed as the latest stable version.')
const reference = await api(`/git/ref/tags/${tag}`)
let tagged = reference.object
while (tagged.type === 'tag') tagged = (await api(`/git/tags/${tagged.sha}`)).object
if (tagged.type !== 'commit' || tagged.sha !== commit) throw new Error('Release tag does not match the verified source commit.')
await writeFile(join(output, 'verification.json'), `${JSON.stringify({ release: release.html_url, version, commit, assets: uploaded.map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest })) }, null, 2)}\n`)
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `Published [Open Media ${tag}](${release.html_url}) after verifying all three installers, application source, and complete corresponding media and speech sources.\n`)
await rm(temporary, { recursive: true, force: true })
console.log(`Published ${release.html_url}`)
