/**
 * 离线测试：本机假 MCP 服务（要求 Bearer 令牌）+ 假凭据存储，验证连接、
 * 401 后刷新重试、工具注册命名、结果脱敏、切换账号与断开时注销工具。
 *
 * Anthropic: 不访问 trygateway.sh，不读取真实凭据。运行：node test/connection.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const VALID = new Set(['token-a2'])

/**
 * 启动一个要求 Bearer 令牌的无状态 MCP 服务。
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} 服务地址与关闭函数。
 */
async function startServer() {
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? ''
    if (!VALID.has(auth.replace(/^Bearer /, ''))) {
      res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' })
      res.end('{}')
      return
    }
    const mcp = new McpServer({ name: 'fake-gateway', version: '0.0.0' }, { instructions: 'Servers live at 10.1.2.3.' })
    mcp.registerTool('list_servers', { description: 'List servers', inputSchema: { team: z.string().optional() } }, async () => ({
      content: [{ type: 'text', text: 'web-1 203.0.113.7 ok' }],
      structuredContent: { servers: [{ name: 'web-1', ip: '203.0.113.7' }] },
    }))
    mcp.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'denied for 198.51.100.9' }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close(); mcp.close() })
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const fake = await startServer()
process.env.DSH_GATEWAY_SSH_MCP_URL = fake.url
const { createConnection } = await import('../lib/connection.js')
const { createRedactor } = await import('../lib/redact.js')

/** 假账号仓库：a1 的令牌已失效，刷新后得到 token-a2；b1 没有可用令牌。 */
const secrets = new Map([
  ['a1', { tokens: { access_token: 'token-a1', refresh_token: 'r1', expires_at: Date.now() + 3600_000 } }],
  ['b1', { tokens: { access_token: 'bad', expires_at: Date.now() + 3600_000 } }],
])
let activeId = 'a1'
let refreshes = 0
const store = {
  readIndex: async () => ({ accounts: [...secrets.keys()].map((id) => ({ id })), activeId, prefs: { redact: { ip: true, host: true } } }),
  updateSecret: async (id, mutate) => {
    const current = secrets.get(id)
    const next = await mutate(current)
    if (next !== undefined) secrets.set(id, next)
    return next ?? current
  },
}
const oauthHooks = {
  refresh: async (secret) => {
    refreshes += 1
    if (secret.tokens.refresh_token !== 'r1') throw new Error('该账号没有刷新令牌，请重新登录。')
    return { ...secret, tokens: { ...secret.tokens, access_token: 'token-a2' } }
  },
}

const registered = new Map()
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  tools: { register(def) { assert.ok(!registered.has(def.name), `duplicate ${def.name}`); registered.set(def.name, def); return () => registered.delete(def.name) } },
}
const redact = createRedactor({ ip: true, host: true })
const connection = createConnection({ ctx, store, redactor: () => redact, oauthHooks })

await connection.reconnect()
assert.equal(connection.status().state, 'connected', connection.status().lastError)
assert.equal(refreshes, 1, '401 后应刷新一次')
assert.deepEqual([...registered.keys()].sort(), ['mcp__gateway__fail', 'mcp__gateway__list_servers'])
assert.equal(connection.instructions(), 'Servers live at 10.1.2.3.', '原始说明由入口在拼接时脱敏')

const signal = new AbortController().signal
const value = await registered.get('mcp__gateway__list_servers').execute({}, { signal })
assert.equal(value.content[0].text, 'web-1 [redacted-ip] ok')
assert.equal(value.structuredContent.servers[0].ip, '[redacted-ip]')
await assert.rejects(registered.get('mcp__gateway__fail').execute({}, { signal }), /denied for \[redacted-ip\]/)

assert.equal(connection.accountStatus('a1').state, 'connected')
assert.equal(connection.accountStatus('a1').toolCount, 2)
// 非当前账号只握手：b1 令牌无效且无刷新令牌，应单独显示失败，且不影响当前账号的工具。
await connection.probe('b1')
assert.equal(connection.accountStatus('b1').state, 'error')
assert.equal(registered.size, 2)

// 切换到无效账号：工具应被注销并报告需要重新登录。
activeId = 'b1'
await connection.reconnect()
assert.equal(connection.status().state, 'error')
assert.equal(registered.size, 0)

// 切回有效账号。
activeId = 'a1'
await connection.reconnect()
assert.equal(connection.status().state, 'connected')
assert.equal(registered.size, 2)

await connection.dispose()
assert.equal(registered.size, 0)
await fake.close()
console.log('connection.test: ok')
