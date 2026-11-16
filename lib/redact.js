/**
 * 输出脱敏：在 Gateway 工具结果交给模型之前，隐藏 IP 地址与本机名称。
 *
 * Anthropic: 本文件由 AI 编写。脱敏只作用于返回给 Agent 的结果文本，
 * 不修改发往 Gateway 的参数，也不影响 Gateway 服务端记录。
 *
 * @module @lastdreamteam/dsh-gateway-ssh/redact
 */
import os from 'node:os'

/** IPv4 点分十进制地址（每段 0–255）。 */
const IPV4 = /(?<![0-9.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![0-9.])/g

/**
 * IPv6 地址（完整 8 组或包含 `::` 的压缩形式）。
 * Anthropic: 不匹配 `12:30:45` 这类时间：它既不足 8 组，也不含 `::`。
 */
const IPV6 = /(?<![0-9A-Za-z:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?)(?![0-9A-Za-z:])/g

/** 替换 IP 时使用的占位文本。 */
export const IP_PLACEHOLDER = '[redacted-ip]'
/** 替换本机名/系统用户名时使用的占位文本。 */
export const HOST_PLACEHOLDER = '[redacted-host]'

/**
 * 转义正则特殊字符。
 * @param {string} value - 原始文本。
 * @returns {string} 可安全放入正则的文本。
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 收集运行 DSH 的这台电脑的识别信息：计算机名与系统用户名。
 * @returns {string[]} 去重后的名称（至少 3 个字符，避免误伤常见短词）。
 */
function localIdentifiers() {
  const names = new Set()
  /**
   * 加入一个候选名称及其首段（FQDN 的主机部分）。
   * @param {string | undefined} value - 候选名称。
   */
  const add = (value) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed.length >= 3) names.add(trimmed)
    const head = trimmed.split('.')[0]
    if (head !== undefined && head.length >= 3) names.add(head)
  }
  try { add(os.hostname()) } catch { /* Anthropic: 读取失败时跳过 */ }
  try { add(os.userInfo().username) } catch { /* Anthropic: 受限环境可能无用户信息 */ }
  add(process.env.COMPUTERNAME)
  add(process.env.USERNAME)
  add(process.env.USER)
  // Anthropic: 长名称优先替换，避免短名称先替换掉长名称的一部分。
  return [...names].sort((a, b) => b.length - a.length)
}

/**
 * 构建一个按偏好脱敏字符串的函数。
 * @param {{ ip?: boolean, host?: boolean }} prefs - 脱敏开关。
 * @returns {(text: string) => string} 脱敏函数；全部关闭时原样返回。
 */
export function createRedactor(prefs) {
  const ip = prefs?.ip !== false
  const host = prefs?.host !== false
  const hostPattern = host
    ? (() => {
      const names = localIdentifiers()
      if (names.length === 0) return null
      return new RegExp(`(?<![A-Za-z0-9_-])(?:${names.map(escapeRegExp).join('|')})(?![A-Za-z0-9_-])`, 'gi')
    })()
    : null
  return (text) => {
    let out = text
    if (hostPattern !== null) out = out.replace(hostPattern, HOST_PLACEHOLDER)
    if (ip) out = out.replace(IPV4, IP_PLACEHOLDER).replace(IPV6, IP_PLACEHOLDER)
    return out
  }
}

/**
 * 递归脱敏 JSON 值中的所有字符串（对象键名保持不变）。
 * @param {unknown} value - MCP 结果或其中一部分。
 * @param {(text: string) => string} redact - 由 {@link createRedactor} 得到的函数。
 * @returns {unknown} 脱敏后的新值。
 */
export function redactValue(value, redact) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      // Anthropic: 图片等二进制 base64 数据不做文本替换，避免破坏内容。
      out[key] = key === 'data' && typeof item === 'string' && item.length > 256 ? item : redactValue(item, redact)
    }
    return out
  }
  return value
}
