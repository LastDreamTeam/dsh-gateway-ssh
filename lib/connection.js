/**
 * Gateway MCP 连接：按当前账号连接 trygateway.sh/mcp，把服务端工具注册为
 * `mcp__gateway__<原名>`，结果在交给 Agent 前脱敏。
 *
 * Anthropic: 工具名与旧版 stdio 配置（serverName=gateway）保持一致，
 * 已有会话历史、审批规则和 Bot 提示无需改动。
 *
 * @module @lastdreamteam/dsh-gateway-ssh/connection
 */
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { GATEWAY_MCP_URL, needsRefresh, refreshSecret } from './oauth.js'
import { redactValue } from './redact.js'

/** 模型可见工具名前缀。 */
export const PUBLIC_PREFIX = 'mcp__gateway__'
/** 单次工具调用超时（毫秒）。Gateway 的 wait_seconds 最长 180 秒。 */
const TOOL_CALL_TIMEOUT_MS = 200 * 1000
/** 服务端说明最大字节数。 */
const MAX_INSTRUCTION_BYTES = 32 * 1024

/**
 * 生成 DSH 工具名（与 dsh-mcp-client 的命名算法一致）。
 * @param {string} rawName - Gateway 原始工具名。
 * @returns {string} 公开名。
 */
export function publicToolName(rawName) {
  const joined = `${PUBLIC_PREFIX}${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`gateway\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`
}

/**
 * MCP 内容块转模型文本。
 * @param {unknown} content - MCP content 数组。
 * @param {string} rawName - 工具原名，用于空结果提示。
 * @returns {string} 文本。
 */
function contentText(content, rawName) {
  const parts = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'resource_link') parts.push(`Resource link: ${block.name} (${block.uri})`)
    else if (typeof block?.type === 'string') parts.push(`[MCP ${block.type} content omitted]`)
  }
  return parts.length > 0 ? parts.join('\n') : `(${rawName} returned no model-visible content)`
}

/**
 * 创建连接监督器。
 * @param {object} deps - 依赖。
 * @param {any} deps.ctx - 插件上下文（tools、logger）。
 * @param {import('./store.js').AccountStore} deps.store - 账号仓库。
 * @param {() => (text: string) => string} deps.redactor - 返回当前脱敏函数。
 * @param {{ refresh?: (secret: object) => Promise<object> }} [deps.oauthHooks] - 测试用的刷新替身。
 * @returns {object} 监督器句柄。
 */
export function createConnection({ ctx, store, redactor, oauthHooks = {} }) {
  const refresh = oauthHooks.refresh ?? refreshSecret
  const label = 'gateway-ssh'
  let client = null
  let accountId = null
  let disposers = new Map()
  let instructions = ''
  let lastError = ''
  let state = 'idle'
  let syncChain = Promise.resolve()
  let connectChain = Promise.resolve()
  let disposed = false
  let retryTimer = null
  let failures = 0
  /**
   * 每个账号最近一次的连接结果。
   * Anthropic: 设置页按账号显示「已连接/失败」，不再只显示一个全局状态。
   * @type {Map<string, { state: string, error: string, checkedAt: string }>}
   */
  const accountStates = new Map()

  /**
   * 记录某账号的连接结果。
   * @param {string} id - 账号 id。
   * @param {string} next - 状态。
   * @param {string} [error] - 已脱敏的错误。
   */
  function mark(id, next, error = '') {
    accountStates.set(id, { state: next, error, checkedAt: new Date().toISOString() })
  }

  /** 注销当前一代工具。 */
  function clearTools() {
    for (const dispose of disposers.values()) dispose()
    disposers = new Map()
  }

  /**
   * 带令牌的 fetch：请求前按需刷新令牌，遇到 401 时刷新一次后重试。
   * @param {string} id - 账号 id。
   * @returns {(url: string | URL, init?: RequestInit) => Promise<Response>} fetch 函数。
   */
  function authorizedFetch(id) {
    /**
     * 取得可用令牌。
     * @param {boolean} force - 是否强制刷新。
     * @returns {Promise<string>} access_token。
     */
    const token = async (force) => {
      const secret = await store.updateSecret(id, async (current) => (force || needsRefresh(current) ? refresh(current) : undefined))
      if (secret?.tokens?.access_token === undefined) throw new Error('账号凭据不存在，请在设置中重新登录。')
      return secret.tokens.access_token
    }
    return async (url, init = {}) => {
      const send = async (accessToken) => {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${accessToken}`)
        return fetch(url, { ...init, headers })
      }
      let response = await send(await token(false))
      if (response.status === 401) {
        // Anthropic: 401 通常是服务端提前吊销或时钟误差，刷新一次再试；仍失败交给上层报错。
        response = await send(await token(true))
      }
      return response
    }
  }

  /**
   * 把一代 MCP 工具同步到 DSH 工具注册表。
   * @param {Client} generation - 已连接的客户端。
   * @returns {Promise<void>}
   */
  function syncTools(generation) {
    const run = syncChain.then(async () => {
      if (generation !== client) return
      const tools = []
      let cursor
      do {
        const page = await generation.listTools(cursor === undefined ? undefined : { cursor })
        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor !== undefined)
      if (generation !== client) return
      const definitions = new Map()
      for (const tool of tools) {
        const name = publicToolName(tool.name)
        if (definitions.has(name)) throw new Error(`Gateway 返回了重复的工具名 ${tool.name}`)
        definitions.set(name, buildDefinition(generation, tool, name))
      }
      clearTools()
      try {
        for (const [name, definition] of definitions) disposers.set(name, ctx.tools.register(definition))
      } catch (error) {
        clearTools()
        throw new Error(`工具注册冲突：${String(error?.message ?? error)}。若配置里还有旧版 serverName=gateway 的 MCP 条目，请在插件页停用它。`)
      }
    })
    syncChain = run.catch(() => {})
    return run
  }

  /**
   * 生成单个 DSH 工具定义。
   * @param {Client} generation - 所属客户端。
   * @param {object} tool - MCP 工具定义。
   * @param {string} name - 公开名。
   * @returns {object} DSH ToolDefinition。
   */
  function buildDefinition(generation, tool, name) {
    return {
      name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      timeoutMs: TOOL_CALL_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: contentText(value?.content, tool.name) }],
      },
      execute: async (args, exec) => {
        if (generation !== client) throw new Error('Gateway 连接已切换或断开，请重试。')
        const redact = redactor()
        let result
        try {
          result = await generation.callTool({ name: tool.name, arguments: args && typeof args === 'object' ? args : {} }, undefined, {
            signal: exec.signal,
            timeout: TOOL_CALL_TIMEOUT_MS,
          })
        } catch (error) {
          throw new Error(redact(String(error?.message ?? error)))
        }
        // Anthropic: 整个结果（文本与结构化内容）都脱敏后才进入会话记录，模型和日志都看不到原值。
        const safe = redactValue({ content: result.content ?? [], ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) }, redact)
        if (result.isError === true) throw new Error(contentText(safe.content, tool.name))
        return safe
      },
    }
  }

  /**
   * 计划一次自动重连（指数退避，最多 8 次）。
   */
  function scheduleRetry() {
    if (disposed || retryTimer !== null || failures >= 8) return
    const delay = Math.min(30_000, 1000 * 2 ** failures)
    failures += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      reconnect().catch(() => {})
    }, delay)
    retryTimer.unref?.()
  }

  /**
   * 断开当前客户端并注销工具。
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const current = client
    client = null
    instructions = ''
    await syncChain
    clearTools()
    if (current !== null) await current.close().catch(() => {})
  }

  /**
   * 按当前账号（重新）连接。
   * @returns {Promise<void>}
   */
  function reconnect() {
    const run = connectChain.then(async () => {
      if (disposed) return
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
      await disconnect()
      const index = await store.readIndex()
      accountId = index.activeId
      if (accountId === null) {
        state = 'signed-out'
        lastError = ''
        return
      }
      state = 'connecting'
      mark(accountId, 'connecting')
      const connectedId = accountId
      const generation = new Client({ name: 'dsh-gateway-ssh', version: '1.0.0' }, { capabilities: {} })
      client = generation
      generation.onclose = () => {
        if (client !== generation || disposed) return
        state = 'disconnected'
        mark(connectedId, 'disconnected')
        client = null
        syncChain.then(() => { if (client === null) clearTools() })
        scheduleRetry()
      }
      generation.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        syncTools(generation).catch((error) => ctx.logger.warn(`${label}: tool re-sync failed: ${String(error?.message ?? error)}`))
      })
      try {
        await generation.connect(new StreamableHTTPClientTransport(new URL(GATEWAY_MCP_URL), { fetch: authorizedFetch(accountId) }))
        const text = generation.getInstructions()?.trimEnd() ?? ''
        instructions = Buffer.byteLength(text) <= MAX_INSTRUCTION_BYTES ? text : ''
        await syncTools(generation)
        state = 'connected'
        lastError = ''
        failures = 0
        mark(connectedId, 'connected')
      } catch (error) {
        lastError = redactor()(String(error?.message ?? error))
        state = 'error'
        mark(connectedId, 'error', lastError)
        ctx.logger.warn(`${label}: connection failed: ${lastError}`)
        if (client === generation) {
          client = null
          await generation.close().catch(() => {})
          clearTools()
        }
        // Anthropic: 需要用户处理的问题（重新登录、旧版条目冲突）不自动重试，避免反复打扰服务端。
        if (!/凭据|重新登录|冲突|invalid_grant/i.test(lastError)) scheduleRetry()
      }
    })
    connectChain = run.catch(() => {})
    return run
  }

  /**
   * 检查一个非当前账号能否连上 Gateway（只握手，不注册工具）。
   * @param {string} id - 账号 id。
   * @returns {Promise<void>}
   */
  async function probe(id) {
    if (disposed || id === accountId) return
    mark(id, 'connecting')
    const probeClient = new Client({ name: 'dsh-gateway-ssh-probe', version: '1.0.0' }, { capabilities: {} })
    try {
      await probeClient.connect(new StreamableHTTPClientTransport(new URL(GATEWAY_MCP_URL), { fetch: authorizedFetch(id) }))
      mark(id, 'connected')
    } catch (error) {
      mark(id, 'error', redactor()(String(error?.message ?? error)))
    } finally {
      await probeClient.close().catch(() => {})
    }
  }

  return {
    reconnect,
    probe,
    /**
     * 某账号最近一次连接结果；当前账号已连上时附带工具数。
     * @param {string} id - 账号 id。
     * @returns {{ state: string, error: string, toolCount: number }} 账号状态。
     */
    accountStatus: (id) => {
      const known = accountStates.get(id) ?? { state: 'unknown', error: '' }
      return { state: known.state, error: known.error, toolCount: id === accountId && state === 'connected' ? disposers.size : 0 }
    },
    /** 账号被移除时丢弃它的状态。 @param {string} id - 账号 id。 */
    forget: (id) => { accountStates.delete(id) },
    /** @returns {{ state: string, accountId: string | null, toolCount: number, lastError: string }} 状态。 */
    status: () => ({ state, accountId, toolCount: disposers.size, lastError }),
    /** @returns {string} 服务端说明文本（已连接时）。 */
    instructions: () => instructions,
    /**
     * 资源请求（供 DSH 的 list_mcp_resources 等共享工具使用）。
     * @param {{ method: string, cursor?: string, uri?: string }} request - 资源操作。
     * @param {{ signal: AbortSignal }} exec - 工具执行上下文。
     * @returns {Promise<unknown>} 脱敏后的结果。
     */
    async resourceRequest(request, exec) {
      const generation = client
      if (generation === null || state !== 'connected') throw new Error('Gateway 未连接，请在设置 → Gateway SSH 中登录。')
      const options = { signal: exec.signal, timeout: TOOL_CALL_TIMEOUT_MS }
      const params = request.cursor === undefined ? undefined : { cursor: request.cursor }
      const hasResources = generation.getServerCapabilities()?.resources !== undefined
      let value
      if (request.method === 'resources/list') value = hasResources ? await generation.listResources(params, options) : { resources: [] }
      else if (request.method === 'resources/templates/list') value = hasResources ? await generation.listResourceTemplates(params, options) : { resourceTemplates: [] }
      else value = await generation.readResource({ uri: request.uri }, options)
      return redactValue(value, redactor())
    },
    /** 释放连接。 */
    async dispose() {
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      await connectChain
      await disconnect()
    },
  }
}
