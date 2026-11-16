/**
 * @lastdreamteam/dsh-gateway-ssh — DSH 设置页（Web Client）。
 *
 * Anthropic: 纯 JavaScript + 宿主提供的 React；只用 --dsw-alias-* 主题变量，
 * 不加载任何 DSH 内部 UI 包。页面只做一件事：绑定、切换、移除 Gateway 账号，
 * 并按账号显示各自的连接状态。
 */
window.__ModuleLoader__.load({
  id: '@lastdreamteam/dsh-gateway-ssh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/api/lastdreamteam/gateway-ssh'

    /** 中文文案。 */
    const zh = {
      nav: 'Gateway SSH',
      title: 'Gateway SSH 账号',
      intro: '绑定 Gateway 账号后，Agent 和 DSH Bot 可以使用你在 Gateway 网站管理的服务器。结果中的 IP 和本机名会自动隐藏。',
      add: '绑定账号',
      waiting: '请在打开的浏览器页面中登录并授权，完成后这里会自动更新。',
      openAgain: '没有打开浏览器？点这里',
      pasteHint: '授权后页面打不开？粘贴浏览器地址栏的完整地址',
      finish: '完成',
      cancel: '取消',
      empty: '还没有绑定账号。',
      inUse: '使用中',
      use: '使用',
      retry: '重试',
      rename: '改名',
      remove: '移除',
      removeConfirm: '移除这个账号？只删除本机保存的登录，Gateway 网站上的服务器不受影响。',
      renamePrompt: '账号显示名：',
      legacy: (n) => `发现 ${n} 个以前用命令行登录的账号，可直接导入。`,
      importLegacy: '导入',
      status: {
        connected: (n) => (n > 0 ? `已连接 · ${n} 个工具` : '已连接'),
        connecting: '连接中…',
        disconnected: '已断开，正在重连…',
        error: '连接失败',
        unknown: '检查中…',
      },
      failed: '操作失败：',
    }
    /** English copy. */
    const en = {
      nav: 'Gateway SSH',
      title: 'Gateway SSH accounts',
      intro: 'Bind a Gateway account so agents and DSH Bots can use the servers you manage on Gateway. IP addresses and this computer\'s name are hidden in results.',
      add: 'Bind account',
      waiting: 'Sign in and approve in the browser page that opened. This updates automatically.',
      openAgain: 'Browser did not open? Click here',
      pasteHint: 'Page did not load after approving? Paste the full address',
      finish: 'Finish',
      cancel: 'Cancel',
      empty: 'No account bound yet.',
      inUse: 'In use',
      use: 'Use',
      retry: 'Retry',
      rename: 'Rename',
      remove: 'Remove',
      removeConfirm: 'Remove this account? Only the sign-in saved on this computer is deleted; servers on Gateway are not affected.',
      renamePrompt: 'Account display name:',
      legacy: (n) => `Found ${n} account(s) signed in earlier from the command line. Import them directly.`,
      importLegacy: 'Import',
      status: {
        connected: (n) => (n > 0 ? `Connected · ${n} tools` : 'Connected'),
        connecting: 'Connecting…',
        disconnected: 'Disconnected, reconnecting…',
        error: 'Connection failed',
        unknown: 'Checking…',
      },
      failed: 'Failed: ',
    }

    /**
     * 选择当前语言的文案。
     * @param {any} locale - ctx.locale 服务。
     * @returns {typeof zh} 文案表。
     */
    function copyFor(locale) {
      const active = String(locale?.getLocale?.()?.active ?? navigator.language ?? 'zh')
      return active.toLowerCase().startsWith('zh') ? zh : en
    }

    /**
     * 调用 Host 接口。
     * @param {string} path - 接口子路径。
     * @param {object} [payload] - POST 内容；省略时 GET。
     * @returns {Promise<any>} JSON 结果。
     */
    async function call(path, payload) {
      const init = payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      const response = await fetch(API + path, init)
      return response.json()
    }

    const base = { padding: '5px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap' }
    const css = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      h: { margin: 0, fontSize: 16, fontWeight: 600 },
      sub: { margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', padding: '4px 14px', display: 'flex', flexDirection: 'column' },
      item: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', flexWrap: 'wrap' },
      divider: { borderTop: '1px solid var(--dsw-alias-border-l1)' },
      grow: { flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 3 },
      nameRow: { display: 'flex', alignItems: 'center', gap: 8 },
      name: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', display: 'flex', alignItems: 'center', gap: 6 },
      badge: { fontSize: 11, padding: '0 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' },
      // Anthropic: 主按钮用「正文色底 + 页面底色字」反相，浅色/深色主题下都清晰可读。
      primary: { ...base, border: '1px solid var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)', fontWeight: 600 },
      button: { ...base, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
      danger: { ...base, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)' },
      input: { flex: 1, minWidth: 200, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: 12 },
      dot: (color) => ({ width: 7, height: 7, borderRadius: 4, background: color, flex: 'none' }),
      link: { color: 'var(--dsw-alias-label-primary)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    }

    /**
     * 账号连接状态的颜色。
     * @param {string} state - 状态。
     * @returns {string} CSS 颜色。
     */
    function stateColor(state) {
      if (state === 'connected') return 'var(--dsw-alias-state-success-primary)'
      if (state === 'error') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-state-warn-primary)'
    }

    /**
     * 一行账号。
     * @param {{ t: typeof zh, account: any, busy: boolean, first: boolean, act: Function }} props - 属性。
     * @returns {any} React 元素。
     */
    function AccountRow({ t, account, busy, first, act }) {
      const status = account.status ?? { state: 'unknown', error: '', toolCount: 0 }
      const text = status.state === 'connected' ? t.status.connected(status.toolCount) : (t.status[status.state] ?? t.status.unknown)
      return h('div', { style: first ? css.item : { ...css.item, ...css.divider } },
        h('div', { style: css.grow },
          h('div', { style: css.nameRow }, h('span', { style: css.name }, account.label), account.active && h('span', { style: css.badge }, t.inUse)),
          h('span', { style: css.meta }, h('span', { style: css.dot(stateColor(status.state)) }), text),
          status.state === 'error' && status.error && h('span', { style: css.error }, status.error)),
        status.state === 'error' && h('button', { style: css.button, disabled: busy, onClick: () => act('/accounts/check', { id: account.id }) }, t.retry),
        !account.active && h('button', { style: css.button, disabled: busy, onClick: () => act('/accounts/activate', { id: account.id }) }, t.use),
        h('button', {
          style: css.button,
          disabled: busy,
          onClick: () => {
            const label = window.prompt(t.renamePrompt, account.label)
            if (label) act('/accounts/rename', { id: account.id, label })
          },
        }, t.rename),
        h('button', { style: css.danger, disabled: busy, onClick: () => { if (window.confirm(t.removeConfirm)) act('/accounts/remove', { id: account.id }) } }, t.remove))
    }

    /**
     * 设置页主体。
     * @param {{ locale: any }} props - 属性。
     * @returns {any} React 元素。
     */
    function GatewaySettings({ locale }) {
      const t = copyFor(locale)
      const [view, setView] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [authorizeUrl, setAuthorizeUrl] = useState('')
      const [pasted, setPasted] = useState('')

      const refresh = useCallback(async () => {
        try {
          const result = await call('/status')
          if (result.view) setView(result.view)
          else if (result.error) setError(t.failed + result.error)
        } catch (failure) {
          setError(t.failed + String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])
      // Anthropic: 登录中或有账号仍在连接/检查时每 2 秒刷新，浏览器授权完成后无需手动操作。
      useEffect(() => {
        const pendingStates = new Set(['connecting', 'disconnected', 'unknown'])
        const live = view?.loginPending || (view?.accounts ?? []).some((a) => pendingStates.has(a.status?.state))
        if (!live) return undefined
        const timer = setInterval(refresh, 2000)
        return () => clearInterval(timer)
      }, [view, refresh])
      useEffect(() => { if (view !== null && !view.loginPending) setAuthorizeUrl('') }, [view])
      useEffect(() => {
        const onFocus = () => { refresh() }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [refresh])

      /**
       * 执行一次操作并更新视图。
       * @param {string} path - 接口。
       * @param {object} payload - 请求体。
       * @returns {Promise<any>} 结果。
       */
      const act = async (path, payload = {}) => {
        setBusy(true)
        setError('')
        try {
          const result = await call(path, payload)
          if (result.view) setView(result.view)
          if (!result.ok) setError(t.failed + (result.error ?? ''))
          return result
        } catch (failure) {
          setError(t.failed + String(failure?.message ?? failure))
          return { ok: false }
        } finally {
          setBusy(false)
        }
      }

      const bind = async () => {
        const result = await act('/login')
        if (result.ok && result.authorizeUrl) {
          setAuthorizeUrl(result.authorizeUrl)
          window.open(result.authorizeUrl, '_blank', 'noopener')
        }
      }

      const accounts = view?.accounts ?? []
      return h('div', { style: css.page },
        h('div', null, h('h2', { style: css.h }, t.title), h('p', { style: css.sub }, t.intro)),

        view && view.legacyAvailable > 0 && h('div', { style: { ...css.card, ...css.item, padding: '10px 14px' } },
          h('span', { style: { flex: 1 } }, t.legacy(view.legacyAvailable)),
          h('button', { style: css.button, disabled: busy, onClick: () => act('/accounts/import-legacy') }, t.importLegacy)),

        h('div', { style: css.card },
          accounts.length === 0 && h('div', { style: { ...css.item, ...css.meta } }, t.empty),
          ...accounts.map((account, n) => h(AccountRow, { key: account.id, t, account, busy, first: n === 0, act }))),

        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { style: { ...css.primary, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: bind }, t.add),
          view?.loginPending && h('button', { style: css.button, onClick: () => act('/login/cancel') }, t.cancel)),

        view?.loginPending && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('span', { style: css.meta }, t.waiting),
          authorizeUrl && h('a', { style: css.link, href: authorizeUrl, target: '_blank', rel: 'noopener noreferrer' }, t.openAgain),
          h('details', null,
            h('summary', { style: { ...css.meta, cursor: 'pointer', display: 'list-item' } }, t.pasteHint),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('input', { style: css.input, value: pasted, placeholder: 'http://127.0.0.1:…/oauth/callback?code=…&state=…', onChange: (e) => setPasted(e.target.value) }),
              h('button', { style: css.button, disabled: busy || pasted.trim() === '', onClick: async () => { const r = await act('/login/finish', { url: pasted }); if (r.ok) setPasted('') } }, t.finish)))),

        error && h('div', { style: css.error }, error))
    }

    /**
     * 设置导航图标（终端提示符造型）。
     * @param {{ size?: number }} props - 属性。
     * @returns {any} SVG 元素。
     */
    function NavIcon({ size = 16 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M7 10l3 2.5L7 15' }),
        h('path', { d: 'M12.5 15H17' }))
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * 注册设置页与导航图标。
       * @param {any} ctx - Client 根上下文。
       */
      apply(ctx) {
        const locale = ctx.locale
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'gateway-ssh',
          order: 330,
          label: () => copyFor(locale).nav,
        }, () => h(GatewaySettings, { locale })))
        try {
          ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'gateway-ssh' }, (owner = {}) => h(NavIcon, { size: owner.size ?? 16 })))
        } catch (error) {
          // Anthropic: 旧版 DSH 没有导航图标槽位时只显示文字，不影响设置页。
          console.warn('[gateway-ssh] settings icon slot unavailable:', error)
        }
      },
    }
  },
})
