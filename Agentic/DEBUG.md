# dsh-gateway-ssh 缺陷与验证记录（DEBUG）

> 本文件是本仓库的持久共享记忆，供任何 Agent 或人类维护者阅读，不是临时笔记或某个 Bot 的私有记忆。作用域为整个仓库，入口与模块说明见 [README.md](../README.md)。只记录已验证的缺陷、修复与正确操作流程；新增、修改或删除条目时在末尾变更记录写明日期、条目号和原因。不得写入令牌、IP、计算机名或个人路径。内容为当前理解，遇到反例先标「待复核」再修改。

创建：2026-11-17 · 最近修改：2026-11-17

## D1 目录链接安装时找不到 `@modelcontextprotocol/sdk`（暂定）

- 现象：`install_bundle` 指向源码目录后激活失败，`ERR_MODULE_NOT_FOUND: @modelcontextprotocol/sdk`。
- 原因：目录链接安装时 DSH 从该目录解析依赖，不使用 profile 的 `node_modules`。
- 处理：安装前在仓库目录执行 `npm install --omit=dev --ignore-scripts`。
- 验证：2026-11-17，DSH Desktop 0.2.x，补装后插件行 `gateway-ssh` 为 active。

## D2 修改 Host 代码后行为不变（暂定）

- 现象：编辑 `index.js`/`lib/*.js` 后接口仍按旧代码响应。
- 处理：插件页停用再启用 `gateway-ssh` 行，或重启 DSH。
- 验证：2026-11-17，停用/启用后新代码生效。

## D3 授权成功但设置页一直显示「工具注册冲突」（暂定）

- 现象：浏览器显示登录成功，设置页仍报红 `tool "mcp__gateway__..." is already registered`。
- 原因：profile 里仍启用了 `serverName: gateway` 的 `@deepseek-ai/dsh-mcp-client` 条目，它先注册了同名工具；插件连接成功但注册失败。
- 处理：停用该条目后，点账号旁「重试」（或停用/启用插件行）。
- 验证：2026-11-17，停用旧条目并重新安装插件后，当前账号注册 300+ 个 `mcp__gateway__*` 工具，`list_servers` 返回的地址均为 `[redacted-ip]`。

## D4 深色主题下主按钮文字看不见（暂定）

- 现象：主按钮为 `--dsw-alias-brand-primary` 底色 + 白字，深色主题下该变量接近白色。
- 处理：主按钮改为 `--dsw-alias-label-primary` 底色 + `--dsw-alias-bg-base` 字色（反相），两种主题都可读。
- 验证：代码已修改；深色/浅色主题下的实际显示待人工确认。

## 正确的验收流程

1. `npm run check` 与 `npm test` 通过（离线，不触网）。
2. 设置 → Gateway SSH：点「绑定账号」，浏览器登录授权后自动返回，该账号显示「已连接 · N 个工具」。
3. 问 Agent「列出我的 Gateway 服务器，仅显示名称」，结果应与 Gateway 网站一致；结果中的 IP 显示为 `[redacted-ip]`。
4. 绑定第二个账号：它应显示自己的状态；点「使用」切换后再列出服务器，结果应属于新账号。
5. 深色与浅色主题下检查按钮文字可读。

未验收（截至 2026-11-17）：第 4、5 步需人工在已登录的 DSH 网页中完成。

## 变更记录

- 2026-11-17 D1–D4、验收流程：从 LDAI_GatewaySSHMCP 的 plugin/ 迁入并补充 D3、D4。操作：Claude Opus 5.5。
