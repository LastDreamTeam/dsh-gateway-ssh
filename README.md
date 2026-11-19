# dsh-gateway-ssh

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 插件：在 DSH **设置 → Gateway SSH** 里用浏览器登录绑定一个或多个 [Gateway SSH](https://trygateway.sh/docs/) 账号，Agent 和 DSH Bot 就能通过 Gateway 使用你在 Gateway 网站管理的服务器。服务器、SSH 凭据、sudo 授权和审批都留在 Gateway，DSH 只保存登录令牌。

[English quick start](#english-quick-start)

## 先确认连的是哪个账号

安装后在 **设置 → Gateway SSH** 绑定自己的 Gateway 账号。账号显示「已连接」并标记「使用中」后，可以问：

> 列出当前 Gateway 账号能看到的服务器，只显示名称。

将结果与 Gateway 网站中该账号的服务器列表对照。绑定多个账号时，先在设置页点「使用」选中目标，再查列表。如果旧的 Gateway MCP 也启用了同名工具，按[共存说明](#与其他-gateway-接入方式共存)处理。

## 安装

需要 Node.js 22.12 或更高版本，以及 DSH 0.2.1-rc.2 起的 0.2 系列版本。

**从源码目录安装**

```powershell
git clone https://github.com/LastDreamTeam/dsh-gateway-ssh.git
Set-Location dsh-gateway-ssh
npm install --omit=dev --ignore-scripts
```

然后在 DSH 中让 Agent 用插件管理器安装这个目录（`plugin_manager` → `install_bundle`，目标填目录绝对路径）；或完全退出 DSH Desktop 后运行 `dsh plugin --profile desktop add "link:<目录绝对路径>"`，再重新打开 DSH。目录链接安装会直接使用该目录及其 `node_modules`，所以要先执行 `npm install`，并保留这个目录。

**从 npm 安装**：发布到 npm 后，可直接用 `dsh plugin --profile desktop add @lastdreamteam/dsh-gateway-ssh`，或在插件市场中安装。

安装后打开 **设置 → Gateway SSH**，点「绑定账号」。可以问 Agent「列出我的 Gateway 服务器，仅显示名称」，核对结果与 Gateway 网站一致。

### 与其他 Gateway 接入方式共存

如果 profile 里还有 `serverName: gateway` 的 `@deepseek-ai/dsh-mcp-client` 条目，两者工具同名，账号会显示「工具注册冲突」。先在设置页导入旧登录，再到 DSH 插件页停用那个条目，然后点账号旁的「重试」。

## 功能

- **一键绑定**：点「绑定账号」，在打开的 Gateway 页面登录并授权，自动跳回本机，设置页随即更新。使用 OAuth 授权码 + PKCE，不用复制令牌或运行命令。
- **多账号**：每个账号单独显示连接状态（已连接 / 连接失败及原因）。Agent 用标记「使用中」的账号，点「使用」立即切换；也可改名、移除。
- **结果脱敏**：工具结果写入会话、交给模型之前，IP 地址替换为 `[redacted-ip]`，这台电脑的计算机名与系统用户名替换为 `[redacted-host]`。默认开启，设置页不提供开关；确需关闭可在 profile 的 `cordis.patch.yml` 中把本插件行的 `redact.ip` / `redact.host` 改为 `false`。
- **工具名**：`mcp__gateway__<工具名>`，与把 Gateway 当作普通 MCP 服务（`serverName: gateway`）接入时一致。
- **导入旧登录**：用 `mcp-remote` 命令行登录过的账号会在设置页提示导入（只读旧文件，不修改、不删除）。

## 安全与隐私

- 令牌保存在 DSH 凭据存储（记录名 `gateway-ssh/*`），不写入配置文件或本仓库。设置页接口只返回账号名称与状态，从不返回令牌。
- 设置页接口只接受本机同源请求，并经过 DSH 网页登录校验；OAuth 回调只接受本机请求并校验 `state`。
- 脱敏只作用于交给 Agent 的结果，不改变发往 Gateway 的参数；Gateway 服务端的作业记录与审计照常保留，便于第三方监管。脱敏基于规则，不能识别所有敏感信息（例如服务器名称不会被替换）。
- 拥有本机文件与终端权限的 Agent 在技术上仍可能读到 DSH 凭据文件，请配合 DSH 的权限预设与审批使用。
- 移除账号只删除本机令牌；要彻底撤销授权，请同时在 Gateway 网站撤销对应客户端。

## 开发

```powershell
npm install --ignore-scripts
npm run check   # 语法检查
npm test        # 离线测试：本机假 MCP 服务，不访问 Gateway、不读取真实凭据
```

| 文件 | 作用 |
| --- | --- |
| [index.js](index.js) | Host 入口：路由、资源服务、系统提示、连接生命周期 |
| [client.js](client.js) | 设置页（React，使用 DSH 主题变量） |
| [lib/oauth.js](lib/oauth.js) | 发现、动态注册、PKCE 登录、刷新、旧登录读取 |
| [lib/connection.js](lib/connection.js) | 按当前账号连接 Gateway MCP，注册工具、脱敏结果、按账号记录状态 |
| [lib/store.js](lib/store.js) | 多账号索引与令牌（DSH 凭据记录） |
| [lib/routes.js](lib/routes.js) | 设置页接口与 OAuth 回调 |
| [lib/redact.js](lib/redact.js) | IP 与本机名脱敏 |

缺陷与验证流程记录在 [Agentic/DEBUG.md](Agentic/DEBUG.md)（共享维护记忆，修改前先读其头部说明）。

## English quick start

This plugin connects DeepSeek Harness to the servers in your Gateway SSH account. Use DSH 0.2.1-rc.2 or later in the 0.2 series, with Node.js 22.12 or later. Clone this repository, install its dependencies with `npm install --omit=dev --ignore-scripts`, then add the directory as a local plugin in your DSH profile. Open **Settings → Gateway SSH**, authorize in the browser, and select the account to use. Ask for server names and compare them with the list on Gateway before choosing a server. [Gateway documentation](https://trygateway.sh/docs/)

## 许可

AGPL-3.0-only，见 [LICENSE](LICENSE)。Gateway 服务由原厂运营，能力和账户权限以其服务端为准。连接方式参考 [LDAI_GatewaySSHMCP](https://github.com/LastDreamTeam/LDAI_GatewaySSHMCP)。
