/**
 * 设置页使用的本机 HTTP 接口与 OAuth 回调页。
 *
 * Anthropic: 除回调外全部要求本机同源请求；回调允许 Gateway 授权页跨站跳回，
 * 但仍要求请求来自本机，并在 LoginFlows 中校验 state。
 *
 * @module @lastdreamteam/dsh-gateway-ssh/routes
 */
import { parseCallbackUrl, readLegacyLogins } from './oauth.js'

/** 接口根路径。 */
export const API_BASE = '/api/lastdreamteam/gateway-ssh'
/** OAuth 回调路径。 */
export const CALLBACK_PATH = `${API_BASE}/oauth/callback`
/** 请求体上限。 */
const MAX_BODY = 16 * 1024

/**
 * 请求是否来自本机地址。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 来自本机且 Host 为回环名称时为 true。
 */
function fromLoopback(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  try {
    const host = new URL(`http://${req.headers.host}`).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * 普通接口的同源校验。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 本机同源时为 true。
 */
function sameOriginLoopback(req) {
  if (!fromLoopback(req)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * 输出 JSON。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 响应体。
 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/**
 * 输出简单的回调结果页（文本已转义）。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {boolean} ok - 是否成功。
 * @param {string} message - 说明文字。
 */
function page(res, status, ok, message) {
  const esc = (v) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const title = ok ? 'Gateway 登录成功' : 'Gateway 登录未完成'
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0}main{max-width:460px;padding:28px 32px;border:1px solid #8884;border-radius:12px}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;line-height:1.7;margin:0}</style></head><body><main><h1>${title}</h1><p>${esc(message)}</p></main>${ok ? '<script>setTimeout(()=>window.close(),1500)</script>' : ''}</body></html>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(html)
}

/**
 * 读取 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>>} 解析结果；无效时为空对象。
 */
async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return {}
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 生成全部路由。
 * @param {object} deps - 依赖。
 * @param {import('./store.js').AccountStore} deps.store - 账号仓库。
 * @param {import('./oauth.js').LoginFlows} deps.flows - 登录流程。
 * @param {ReturnType<typeof import('./connection.js').createConnection>} deps.connection - 连接监督器。
 * @param {() => string} deps.callbackUrl - 本机回调地址。
 * @param {() => ((req: any) => number | undefined) | undefined} deps.hostGate - DSH 宿主的请求栅栏（含网页登录校验）。
 * @returns {Array<object>} webServer 路由列表。
 */
export function makeRoutes({ store, flows, connection, callbackUrl, hostGate }) {
  /**
   * 设置页看到的状态（不包含任何令牌）。
   * @returns {Promise<object>} 状态视图。
   */
  const view = async () => {
    const index = await store.readIndex()
    const legacy = index.legacyImported ? [] : await readLegacyLogins()
    for (const account of index.accounts) {
      // Anthropic: 非当前账号首次显示时后台握手一次，设置页轮询即可拿到它自己的连接结果。
      if (account.id !== index.activeId && connection.accountStatus(account.id).state === 'unknown') connection.probe(account.id).catch(() => {})
    }
    return {
      accounts: index.accounts.map((a) => ({ id: a.id, label: a.label, createdAt: a.createdAt, active: a.id === index.activeId, status: connection.accountStatus(a.id) })),
      activeId: index.activeId,
      connection: connection.status(),
      loginPending: flows.hasPending(),
      legacyAvailable: legacy.length,
    }
  }

  /**
   * 包装需要本机同源的 POST/GET 接口。
   * @param {string} method - 允许的方法。
   * @param {(input: Record<string, unknown>) => Promise<object>} action - 处理函数。
   * @returns {(req: any, res: any) => Promise<void>} 路由处理器。
   */
  const guarded = (method, action) => async (req, res) => {
    if (!sameOriginLoopback(req)) return json(res, 403, { error: '仅允许在本机 DSH 设置页中操作。' })
    // Anthropic: 再交给 DSH 宿主栅栏校验网页登录状态；栅栏抛错按拒绝处理（fail-closed）。
    const gate = hostGate()
    if (gate !== undefined) {
      let rejection
      try { rejection = gate(req) } catch { rejection = 403 }
      if (rejection !== undefined && rejection !== null) return json(res, typeof rejection === 'number' ? rejection : 403, { error: rejection === 401 ? '需要先登录 DSH 网页。' : '请求被 DSH 拒绝。' })
    }
    if (req.method !== method) return json(res, 405, { error: `不支持 ${req.method}` })
    try {
      const input = method === 'POST' ? await body(req) : {}
      const extra = await action(input)
      json(res, 200, { ok: true, ...extra, view: await view() })
    } catch (error) {
      json(res, 200, { ok: false, error: String(error?.message ?? error), view: await view().catch(() => undefined) })
    }
  }

  /**
   * 完成登录并保存账号。
   * @param {string} code - 授权码。
   * @param {string} state - state。
   * @returns {Promise<string>} 新账号 id。
   */
  const finish = async (code, state) => {
    const { secret, label } = await flows.complete(code, state)
    const id = await store.addAccount({ label, source: 'oauth', secret, makeActive: true })
    await connection.reconnect()
    return id
  }

  const id = (input) => (typeof input.id === 'string' ? input.id : '')

  return [
    { kind: 'exact', path: `${API_BASE}/status`, handler: guarded('GET', async () => ({})) },
    {
      kind: 'exact',
      path: `${API_BASE}/login`,
      handler: guarded('POST', async (input) => {
        const label = typeof input.label === 'string' ? input.label.slice(0, 40) : undefined
        const { authorizeUrl } = await flows.begin(callbackUrl(), label)
        return { authorizeUrl }
      }),
    },
    {
      kind: 'exact',
      path: CALLBACK_PATH,
      handler: async (req, res) => {
        if (!fromLoopback(req)) return page(res, 403, false, '回调请求不是来自本机，已拒绝。')
        const url = new URL(req.url ?? '', 'http://localhost')
        const error = url.searchParams.get('error')
        if (error) return page(res, 400, false, `Gateway 返回：${error}。可以回到 DSH 设置页重试。`)
        const code = url.searchParams.get('code') ?? ''
        const state = url.searchParams.get('state') ?? ''
        try {
          await finish(code, state)
          page(res, 200, true, '账号已添加。此页面会自动关闭，回到 DSH 即可使用。')
        } catch (failure) {
          page(res, 400, false, String(failure?.message ?? failure))
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/login/finish`,
      handler: guarded('POST', async (input) => {
        const parsed = parseCallbackUrl(typeof input.url === 'string' ? input.url : '')
        if (parsed === null) throw new Error('请粘贴浏览器地址栏中完整的回调地址（包含 code 和 state）。')
        await finish(parsed.code, parsed.state)
        return {}
      }),
    },
    { kind: 'exact', path: `${API_BASE}/login/cancel`, handler: guarded('POST', async () => { flows.cancelAll(); return {} }) },
    {
      kind: 'exact',
      path: `${API_BASE}/accounts/activate`,
      handler: guarded('POST', async (input) => { await store.activate(id(input)); await connection.reconnect(); return {} }),
    },
    {
      kind: 'exact',
      path: `${API_BASE}/accounts/rename`,
      handler: guarded('POST', async (input) => { await store.renameAccount(id(input), String(input.label ?? '')); return {} }),
    },
    {
      kind: 'exact',
      path: `${API_BASE}/accounts/remove`,
      handler: guarded('POST', async (input) => {
        const before = (await store.readIndex()).activeId
        await store.removeAccount(id(input))
        connection.forget(id(input))
        if (before === id(input)) await connection.reconnect()
        return {}
      }),
    },
    {
      kind: 'exact',
      path: `${API_BASE}/accounts/import-legacy`,
      handler: guarded('POST', async () => {
        const logins = await readLegacyLogins()
        if (logins.length === 0) throw new Error('没有找到旧版登录。')
        const index = await store.readIndex()
        for (const [n, secret] of logins.entries()) {
          await store.addAccount({ label: `已导入的 Gateway 账号${logins.length > 1 ? ` ${n + 1}` : ''}`, source: 'legacy', secret, makeActive: index.activeId === null && n === 0 })
        }
        await connection.reconnect()
        return { imported: logins.length }
      }),
    },
    {
      kind: 'exact',
      path: `${API_BASE}/accounts/check`,
      handler: guarded('POST', async (input) => {
        // Anthropic: 当前账号重新连接；其他账号只做一次握手检查。
        const index = await store.readIndex()
        if (id(input) === index.activeId) await connection.reconnect()
        else await connection.probe(id(input))
        return {}
      }),
    },
  ]
}
