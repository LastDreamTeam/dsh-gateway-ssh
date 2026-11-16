/**
 * 账号存储：多个 Gateway 账号的 OAuth 客户端注册、令牌与非敏感偏好。
 *
 * Anthropic: 秘密只写入 DSH 凭据服务（ctx.credentials 记录），不写入
 * cordis.patch.yml 或插件目录；对外只提供去除令牌后的视图。
 *
 * @module @lastdreamteam/dsh-gateway-ssh/store
 */
import { randomUUID } from 'node:crypto'

/** 凭据记录的作用域，同时也是插件的注册名。 */
export const CREDENTIAL_SCOPE = 'gateway-ssh'
/** 保存账号列表与偏好的索引记录 id。 */
const INDEX_ID = 'index'

/**
 * 默认偏好。
 * @returns {{ redact: { ip: boolean, host: boolean } }} 新对象。
 */
function defaultPrefs() {
  return { redact: { ip: true, host: true } }
}

/**
 * 生成短账号 id（凭据 key 只允许小写字母、数字和连字符）。
 * @returns {string} 例如 `a1b2c3d4e5f6`。
 */
function newAccountId() {
  return 'a' + randomUUID().replace(/-/g, '').slice(0, 11)
}

/**
 * 基于 DSH 凭据服务的账号仓库。
 */
export class AccountStore {
  /**
   * @param {any} credentials - `ctx.credentials` 服务。
   * @param {(scope: string, id: string) => string} keyOf - `credentialKey` 函数。
   */
  constructor(credentials, keyOf) {
    this.credentials = credentials
    this.keyOf = keyOf
    /** Anthropic: 所有写操作串行，避免并发授权回调互相覆盖索引。 */
    this.chain = Promise.resolve()
  }

  /**
   * 串行执行一次读改写。
   * @template T
   * @param {() => Promise<T>} task - 需要独占的操作。
   * @returns {Promise<T>} 操作结果。
   */
  exclusive(task) {
    const run = this.chain.then(task)
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * 读取索引（账号顺序、当前账号、偏好）。
   * @returns {Promise<{ accounts: Array<{ id: string, label: string, createdAt: string, source: string }>, activeId: string | null, prefs: { redact: { ip: boolean, host: boolean } }, legacyImported: boolean }>} 索引副本。
   */
  async readIndex() {
    const record = await this.credentials.readRecord(this.keyOf(CREDENTIAL_SCOPE, INDEX_ID))
    const payload = record?.kind === 'grant' && record.payload && typeof record.payload === 'object' ? record.payload : {}
    const prefs = defaultPrefs()
    if (payload.prefs?.redact) {
      prefs.redact.ip = payload.prefs.redact.ip !== false
      prefs.redact.host = payload.prefs.redact.host !== false
    }
    return {
      accounts: Array.isArray(payload.accounts) ? payload.accounts.filter((a) => typeof a?.id === 'string') : [],
      activeId: typeof payload.activeId === 'string' ? payload.activeId : null,
      prefs,
      legacyImported: payload.legacyImported === true,
    }
  }

  /**
   * 修改索引。
   * @param {(index: Awaited<ReturnType<AccountStore['readIndex']>>) => void} mutate - 原地修改回调。
   * @returns {Promise<void>}
   */
  async updateIndex(mutate) {
    const index = await this.readIndex()
    mutate(index)
    // Anthropic: 当前账号失效时退回第一个账号，保证工具路由始终有目标。
    if (!index.accounts.some((a) => a.id === index.activeId)) index.activeId = index.accounts[0]?.id ?? null
    await this.credentials.modifyRecord(this.keyOf(CREDENTIAL_SCOPE, INDEX_ID), async () => ({ kind: 'grant', payload: index }))
  }

  /**
   * 读取一个账号的秘密部分。
   * @param {string} id - 账号 id。
   * @returns {Promise<{ client: object, tokens: object, authServer: string, resource: string } | undefined>} 秘密数据。
   */
  async readSecret(id) {
    const record = await this.credentials.readRecord(this.keyOf(CREDENTIAL_SCOPE, id))
    return record?.kind === 'grant' ? record.payload : undefined
  }

  /**
   * 写入一个账号的秘密部分。
   * @param {string} id - 账号 id。
   * @param {object} secret - 客户端注册、令牌与授权服务器信息。
   * @returns {Promise<void>}
   */
  async writeSecret(id, secret) {
    await this.credentials.modifyRecord(this.keyOf(CREDENTIAL_SCOPE, id), async () => ({ kind: 'grant', payload: secret }))
  }

  /**
   * 新增账号并设为当前账号（第一个账号或调用方要求时）。
   * @param {{ label?: string, source: string, secret: object, makeActive?: boolean }} input - 新账号信息。
   * @returns {Promise<string>} 新账号 id。
   */
  addAccount(input) {
    return this.exclusive(async () => {
      const id = newAccountId()
      await this.writeSecret(id, input.secret)
      await this.updateIndex((index) => {
        const label = input.label?.trim() || `Gateway 账号 ${index.accounts.length + 1}`
        index.accounts.push({ id, label, createdAt: new Date().toISOString(), source: input.source })
        if (input.makeActive || index.activeId === null) index.activeId = id
        if (input.source === 'legacy') index.legacyImported = true
      })
      return id
    })
  }

  /**
   * 删除账号及其令牌。
   * @param {string} id - 账号 id。
   * @returns {Promise<void>}
   */
  removeAccount(id) {
    return this.exclusive(async () => {
      await this.updateIndex((index) => { index.accounts = index.accounts.filter((a) => a.id !== id) })
      await this.credentials.deleteRecord(this.keyOf(CREDENTIAL_SCOPE, id))
    })
  }

  /**
   * 重命名账号（仅本机显示用）。
   * @param {string} id - 账号 id。
   * @param {string} label - 新名称，最长 40 字符。
   * @returns {Promise<void>}
   */
  renameAccount(id, label) {
    return this.exclusive(() => this.updateIndex((index) => {
      const account = index.accounts.find((a) => a.id === id)
      if (account !== undefined && label.trim() !== '') account.label = label.trim().slice(0, 40)
    }))
  }

  /**
   * 设置当前账号。
   * @param {string} id - 账号 id。
   * @returns {Promise<void>}
   */
  activate(id) {
    return this.exclusive(() => this.updateIndex((index) => {
      if (index.accounts.some((a) => a.id === id)) index.activeId = id
    }))
  }

  /**
   * 串行更新某账号令牌（刷新令牌时使用，避免并发刷新丢失新 refresh_token）。
   * @param {string} id - 账号 id。
   * @param {(secret: object) => Promise<object | undefined>} mutate - 返回新秘密或 undefined 表示不写。
   * @returns {Promise<object | undefined>} 写入后的秘密。
   */
  updateSecret(id, mutate) {
    return this.exclusive(async () => {
      const current = await this.readSecret(id)
      if (current === undefined) return undefined
      const next = await mutate(current)
      if (next !== undefined) await this.writeSecret(id, next)
      return next ?? current
    })
  }
}
