/**
 * @lastdreamteam/dsh-gateway-ssh — DSH Host 插件入口。
 *
 * 在 DSH 设置中用浏览器 OAuth 登录一个或多个 Gateway 账号，把当前账号的
 * Gateway SSH 工具以 `mcp__gateway__*` 提供给 Agent 与 DSH Bot，结果在进入会话前脱敏。
 *
 * Anthropic: 插件只负责连接、账号与脱敏；服务器、SSH 凭据、sudo 与审批仍由
 * Gateway 服务端和 DSH 审批策略决定，插件不绕过任何一方。
 *
 * @module @lastdreamteam/dsh-gateway-ssh
 */
import { AccountStore, CREDENTIAL_SCOPE } from './lib/store.js'
import { LoginFlows } from './lib/oauth.js'
import { createConnection } from './lib/connection.js'
import { CALLBACK_PATH, makeRoutes } from './lib/routes.js'
import { createRedactor } from './lib/redact.js'

/** Cordis 插件名。 */
export const name = CREDENTIAL_SCOPE
/** 必需的 Host 服务。 */
export const inject = ['tools', 'webServer', 'credentials']

/** 系统提示中的静态说明（保持不变以利于提示缓存）。 */
const GUIDANCE = 'Gateway SSH（@lastdreamteam/dsh-gateway-ssh）：服务器操作使用 mcp__gateway__* 工具，账号由用户在 DSH「设置 → Gateway SSH」登录并选择；看不到这些工具时请用户去该页面登录，不要索要密码、令牌或私钥，也不要绕过插件直连 Gateway 或读取凭据文件。工具结果中的 IP 与本机名可能已被替换为 [redacted-ip]/[redacted-host]，不要猜测或还原原值。'

/**
 * 与 `@deepseek-ai/dsh-credentials` 的 credentialKey 相同格式的记录键。
 * @param {string} scope - 插件作用域。
 * @param {string} id - 记录 id。
 * @returns {string} `<scope>/<id>`。
 */
function credentialKey(scope, id) {
  for (const segment of [scope, id]) if (!/^[a-z][a-z0-9-]*$/.test(segment)) throw new TypeError(`invalid credential key segment ${segment}`)
  return `${scope}/${id}`
}

/**
 * 计算本机回调地址。
 * @param {any} webServer - Host webServer 服务。
 * @returns {string} `http://127.0.0.1:<port>/api/.../oauth/callback`。
 */
function resolveCallbackUrl(webServer) {
  let port = typeof webServer.port === 'number' ? webServer.port : undefined
  if (port === undefined && typeof webServer.getOrigin === 'function') {
    try { port = Number(new URL(webServer.getOrigin()).port) || undefined } catch { /* Anthropic: 取不到时用下方报错 */ }
  }
  if (port === undefined) throw new Error('无法确定 DSH 网页端口，Gateway 登录回调不可用。')
  // Anthropic: 回调固定走 127.0.0.1，避免把局域网地址注册到 Gateway 客户端。
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`
}

/**
 * 插件入口。
 * @param {any} ctx - Host 插件上下文。
 * @param {{ announceToAgent?: boolean, redact?: { ip?: boolean, host?: boolean } }} config - 行配置。
 */
export function apply(ctx, config) {
  const store = new AccountStore(ctx.credentials, credentialKey)
  const flows = new LoginFlows()
  // Anthropic: 脱敏固定开启（设置页不提供开关），按行配置 redact 可在 cordis.patch.yml 中调整。
  const redact = createRedactor({ ip: config?.redact?.ip !== false, host: config?.redact?.host !== false })

  const connection = createConnection({ ctx, store, redactor: () => redact })

  ctx.effect(() => {
    const disposers = makeRoutes({
      store,
      flows,
      connection,
      callbackUrl: () => resolveCallbackUrl(ctx.webServer),
      hostGate: () => {
        // Anthropic: 每次请求现取，宿主 connection 服务可能晚于本插件挂载。
        const hostConnection = ctx.get('connection')
        const gate = hostConnection?.requestRejection
        return typeof gate === 'function' ? (req) => gate.call(hostConnection, req) : undefined
      },
    }).map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'gateway-ssh: routes')

  // Anthropic: 让 DSH 的 list_mcp_resources 等共享资源工具可以选择 "gateway"。
  ctx.inject(['mcpResources'], (inner) => {
    try {
      inner.mcpResources.register('gateway', { request: (request, exec) => connection.resourceRequest(request, exec) })
    } catch (error) {
      // Anthropic: 旧版 serverName=gateway 的 MCP 条目仍启用时名称冲突；工具仍可用，只是资源工具不指向本插件。
      ctx.logger.warn(`gateway-ssh: resource server name "gateway" is taken (${String(error?.message ?? error)}); disable the legacy MCP entry`)
    }
  })

  ctx.inject(['systemPrompt'], (inner) => {
    if (config?.announceToAgent !== false) inner.systemPrompt.section({ name: 'plugin:gateway-ssh', order: 162, text: GUIDANCE })
    inner.systemPrompt.section({
      // Anthropic: 不用 mcp:gateway，避免与仍启用的旧版 mcp-client 条目同名。
      name: 'plugin:gateway-ssh:instructions',
      order: inner.systemPrompt.getSectionOrder?.('MCP_SERVERS') ?? 163,
      interpolate: false,
      text: () => {
        const text = connection.instructions()
        return text === '' ? '' : `### MCP server: gateway\n\n${redact(text)}`
      },
    })
  })

  ctx.effect(() => {
    connection.reconnect().catch(() => {})
    return () => { flows.cancelAll(); connection.dispose().catch(() => {}) }
  }, 'gateway-ssh: connection')
}
