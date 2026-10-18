// External protocol compatibility check against the real native HTTP listener.
// Install the pinned client outside the application dependency graph:
// npm install --prefix /tmp/open-media-mcp-client --no-package-lock --ignore-scripts @modelcontextprotocol/sdk@1.32.1
// node scripts/verify-mcp-protocol.mjs --server-test-binary <native-lib-test-binary> --sdk-directory /tmp/open-media-mcp-client
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const arguments_ = process.argv.slice(2)
function option(name) {
  const index = arguments_.indexOf(name)
  if (index < 0 || !arguments_[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(arguments_[index + 1])
}
const executable = option('--server-test-binary')
const dependencyRoot = option('--sdk-directory')
const require = createRequire(join(dependencyRoot, 'package.json'))
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')))
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')))
const package_ = JSON.parse(await readFile(join(dependencyRoot, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'))
assert.equal(package_.version, '1.32.1', 'Use the audited client version for reproducible protocol evidence.')

const directory = await mkdtemp(join(tmpdir(), 'open-media-mcp-protocol-'))
const handshake = join(directory, 'handshake.json')
const stop = join(directory, 'stop')
let output = '', spawnError
const process_ = spawn(executable, ['mcp::tests::external_protocol_fixture', '--exact', '--ignored', '--nocapture'], {
  env: { ...process.env, OPEN_MEDIA_MCP_HANDSHAKE: handshake, OPEN_MEDIA_MCP_STOP: stop },
  stdio: ['ignore', 'pipe', 'pipe'],
})
process_.on('error', error => { spawnError = error })
for (const stream of [process_.stdout, process_.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32768) })
const exited = new Promise(resolve_ => process_.once('exit', (code, signal) => resolve_({ code, signal })))
const wait = delay => new Promise(resolve_ => setTimeout(resolve_, delay))
const clients = []
let evidence
function connection(url, token) {
  const client = new Client({ name: 'Open Media protocol verification', version: '1' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  clients.push(client)
  return { client, transport }
}
try {
  let ready
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (process_.exitCode !== null || process_.signalCode !== null) throw new Error(`Native fixture exited before readiness:\n${output}`)
    try { ready = JSON.parse(await readFile(handshake, 'utf8')); break }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    await wait(50)
  }
  assert.ok(ready?.url && ready?.token, 'Native listener must report readiness.')
  const { client, transport } = connection(ready.url, ready.token)
  await client.connect(transport, { timeout: 10000 })
  assert.equal(client.getServerVersion()?.name, 'Open Media')
  assert.match(client.getServerVersion()?.version ?? '', /^\d+\.\d+\.\d+$/)
  assert.equal(client.getServerCapabilities()?.tools?.listChanged, false)
  await client.ping({ timeout: 10000 })
  const tools = await client.listTools({}, { timeout: 10000 })
  assert.ok(tools.tools.some(tool => tool.name === 'open_media_echo' && tool.inputSchema.type === 'object'))
  const inputs = [{ text: '轨道、字幕与配音', value: 42 }, { text: '并行请求一', value: 1 }, { text: '并行请求二', value: 2 }]
  const results = await Promise.all(inputs.map(arguments_ => client.callTool({ name: 'open_media_echo', arguments: arguments_ }, undefined, { timeout: 10000 })))
  results.forEach((result, index) => {
    assert.equal(result.isError, false)
    assert.deepEqual(result.structuredContent.echo, inputs[index])
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  })
  await assert.rejects(client.callTool({ name: 'open_media_not_a_tool', arguments: {} }, undefined, { timeout: 10000 }), error => error.code === -32602)
  const unauthorized = connection(ready.url, 'incorrect-token')
  await assert.rejects(unauthorized.client.connect(unauthorized.transport, { timeout: 10000 }), /401|Unauthorized|unauthorized|认证|令牌/)
  await client.ping({ timeout: 10000 })
  evidence = { status: 'passed', client: '@modelcontextprotocol/sdk', clientVersion: package_.version, transport: 'Streamable HTTP', checks: ['initialize', 'initialized notification', 'ping', 'tools/list', 'tools/call with Unicode', 'parallel request correlation', 'structuredContent', 'unknown tool error', 'bearer rejection', 'listener shutdown'] }
} finally {
  await Promise.allSettled(clients.map(client => client.close()))
  await writeFile(stop, 'stop\n')
  const result = await Promise.race([exited, wait(5000).then(() => null)])
  if (!result) process_.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
  if (!result) throw new Error('Native fixture did not stop within five seconds.')
  if (result && result.code !== 0) throw new Error(`Native fixture failed (${result.code ?? result.signal}):\n${output}`)
}
console.log(JSON.stringify(evidence, null, 2))
