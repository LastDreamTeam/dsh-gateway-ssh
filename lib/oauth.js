/**
 * Gateway OAuth：浏览器授权码 + PKCE 登录、令牌刷新、旧版 mcp-remote 登录导入。
 *
 * Anthropic: 授权服务器、动态客户端注册与 PKCE 都按 MCP 授权规范由 SDK 辅助函数完成；
 * 每次登录都注册新的公共客户端，使回调地址始终与当前 DSH 网页端口一致。
 *
 * @module @lastdreamteam/dsh-gateway-ssh/oauth
 */
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'

/**
 * Gateway SSH 的 MCP 服务地址。
 * Anthropic: 环境变量只供离线测试指向本机假服务，正常使用无需设置。
 */
export const GATEWAY_MCP_URL = process.env.DSH_GATEWAY_SSH_MCP_URL || 'https://trygateway.sh/mcp'
/** 待完成登录的有效期（毫秒）。 */
const PENDING_TTL_MS = 10 * 60 * 1000
/** 令牌提前刷新的余量（毫秒）。 */
const REFRESH_MARGIN_MS = 60 * 1000

/**
 * 读取并缓存 Gateway 的资源与授权服务器元数据。
 * @returns {Promise<{ resource: string, authServer: string, metadata: object | undefined, scope: string }>} 发现结果。
 */
let discoveryCache = null
export async function discover() {
  if (discoveryCache !== null && Date.now() - discoveryCache.at < 30 * 60 * 1000) return discoveryCache.value
  const resourceMeta = await discoverOAuthProtectedResourceMetadata(GATEWAY_MCP_URL)
  const authServer = resourceMeta.authorization_servers?.[0] ?? new URL(GATEWAY_MCP_URL).origin
  const metadata = await discoverAuthorizationServerMetadata(authServer)
  const scopes = resourceMeta.scopes_supported ?? metadata?.scopes_supported ?? []
  const value = {
    resource: resourceMeta.resource ?? GATEWAY_MCP_URL,
    authServer,
    metadata,
    // Anthropic: 申请服务端声明的全部权限，具体能做什么仍由 Gateway 账号权限与审批决定。
    scope: scopes.join(' '),
  }
  discoveryCache = { at: Date.now(), value }
  return value
}

/**
 * 把 SDK 返回的令牌转成持久形式（记录绝对过期时间）。
 * @param {object} tokens - OAuthTokens。
 * @param {object} [previous] - 旧令牌（刷新时保留未返回的 refresh_token）。
 * @returns {object} 持久令牌。
 */
function persistTokens(tokens, previous) {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? previous?.refresh_token,
    token_type: tokens.token_type ?? 'Bearer',
    scope: tokens.scope ?? previous?.scope,
    expires_at: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined,
  }
}

/**
 * 管理进行中的浏览器登录。
 */
export class LoginFlows {
  constructor() {
    /** @type {Map<string, { state: string, verifier: string, client: object, redirectUrl: string, startedAt: number, label?: string }>} */
    this.pending = new Map()
  }

  /** 清理过期登录。 */
  sweep() {
    for (const [state, flow] of this.pending) if (Date.now() - flow.startedAt > PENDING_TTL_MS) this.pending.delete(state)
  }

  /**
   * 开始一次登录：注册客户端并生成授权地址。
   * @param {string} redirectUrl - 本机回调地址。
   * @param {string} [label] - 新账号显示名。
   * @returns {Promise<{ authorizeUrl: string, state: string }>} 打开浏览器所需的地址。
   */
  async begin(redirectUrl, label) {
    this.sweep()
    if (this.pending.size >= 4) throw new Error('同时进行的登录过多，请先完成或等待 10 分钟后重试。')
    const info = await discover()
    const client = await registerClient(info.authServer, {
      metadata: info.metadata,
      clientMetadata: {
        client_name: 'DSH Gateway SSH',
        redirect_uris: [redirectUrl],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: info.scope,
      },
    })
    const state = randomUUID()
    const { authorizationUrl, codeVerifier } = await startAuthorization(info.authServer, {
      metadata: info.metadata,
      clientInformation: client,
      redirectUrl,
      scope: info.scope,
      state,
      resource: new URL(info.resource),
    })
    this.pending.set(state, { state, verifier: codeVerifier, client, redirectUrl, startedAt: Date.now(), label })
    return { authorizeUrl: authorizationUrl.toString(), state }
  }

  /**
   * 是否还有进行中的登录。
   * @returns {boolean} 有未过期的登录时为 true。
   */
  hasPending() {
    this.sweep()
    return this.pending.size > 0
  }

  /**
   * 用回调中的 code/state 完成登录。
   * @param {string} code - 授权码。
   * @param {string} state - 回调携带的 state，必须与开始时一致。
   * @returns {Promise<{ secret: object, label?: string }>} 新账号的秘密数据。
   */
  async complete(code, state) {
    this.sweep()
    const flow = this.pending.get(state)
    if (flow === undefined) throw new Error('登录已过期或不是从本机发起的，请重新点击「添加账号」。')
    // Anthropic: 先移除再交换，防止同一 code 被重复提交。
    this.pending.delete(state)
    const info = await discover()
    const tokens = await exchangeAuthorization(info.authServer, {
      metadata: info.metadata,
      clientInformation: flow.client,
      authorizationCode: code,
      codeVerifier: flow.verifier,
      redirectUri: flow.redirectUrl,
      resource: new URL(info.resource),
    })
    return {
      label: flow.label,
      secret: { client: flow.client, tokens: persistTokens(tokens), authServer: info.authServer, resource: info.resource },
    }
  }

  /** 取消全部进行中的登录。 */
  cancelAll() {
    this.pending.clear()
  }
}

/**
 * 令牌是否需要刷新。
 * @param {object} secret - 账号秘密。
 * @returns {boolean} 即将过期或已过期时为 true。
 */
export function needsRefresh(secret) {
  const expiresAt = secret?.tokens?.expires_at
  return typeof expiresAt === 'number' && expiresAt - REFRESH_MARGIN_MS <= Date.now()
}

/**
 * 用 refresh_token 刷新访问令牌。
 * @param {object} secret - 账号秘密。
 * @returns {Promise<object>} 新的账号秘密。
 */
export async function refreshSecret(secret) {
  const refreshToken = secret?.tokens?.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken === '') throw new Error('该账号没有刷新令牌，请重新登录。')
  const info = await discover()
  const tokens = await refreshAuthorization(secret.authServer ?? info.authServer, {
    metadata: info.metadata,
    clientInformation: secret.client,
    refreshToken,
    resource: new URL(secret.resource ?? info.resource),
  })
  return { ...secret, tokens: persistTokens(tokens, secret.tokens) }
}

/**
 * 旧版 `node dsh/setup.mjs login`（mcp-remote）保存登录的目录。
 * @returns {string} 绝对路径。
 */
export function legacyAuthDir() {
  return path.join(os.homedir(), '.mcp-auth', 'gateway-ssh', 'mcp-remote-v1')
}

/**
 * 读取旧版登录，转换为账号秘密（不修改、不删除旧文件）。
 * @returns {Promise<object[]>} 可导入的账号秘密列表。
 */
export async function readLegacyLogins() {
  let names
  try {
    names = await readdir(legacyAuthDir())
  } catch {
    return []
  }
  const results = []
  for (const name of names) {
    if (!name.endsWith('_tokens.json')) continue
    const hash = name.slice(0, -'_tokens.json'.length)
    try {
      const tokens = JSON.parse(await readFile(path.join(legacyAuthDir(), name), 'utf8'))
      const client = JSON.parse(await readFile(path.join(legacyAuthDir(), `${hash}_client_info.json`), 'utf8'))
      if (typeof tokens.access_token !== 'string' || typeof client.client_id !== 'string') continue
      const issuedAt = typeof tokens.expires_at === 'number' ? tokens.expires_at : undefined
      results.push({
        client,
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type ?? 'Bearer',
          scope: tokens.scope,
          // Anthropic: mcp-remote 的 expires_at 可能是秒或毫秒；无法判断时视为已过期，使用前先刷新。
          expires_at: issuedAt === undefined ? 0 : issuedAt < 1e12 ? issuedAt * 1000 : issuedAt,
        },
        authServer: undefined,
        resource: undefined,
      })
    } catch {
      // Anthropic: 损坏的旧文件直接跳过，不影响其他账号。
    }
  }
  return results
}

/**
 * 从粘贴的回调地址中解析 code/state。
 * @param {string} url - 浏览器地址栏中的完整回调地址。
 * @returns {{ code: string, state: string } | null} 解析结果。
 */
export function parseCallbackUrl(url) {
  try {
    const parsed = new URL(url.trim())
    const code = parsed.searchParams.get('code') ?? ''
    const state = parsed.searchParams.get('state') ?? ''
    return code !== '' && state !== '' ? { code, state } : null
  } catch {
    return null
  }
}
