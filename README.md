# dsh-codex-use

把本机 **Codex CLI 的 App Server** 接入 DeepSeek Harness（DSH），作为一个可手动选择的 LLM provider：

- provider id：`codex-chatgpt`
- 显示名：`OpenAI Codex（ChatGPT）`
- 传输：`codex app-server --stdio`（JSON-RPC）
- 不监听本地 HTTP 端口，也不伪装成 OpenAI-compatible API
- DSH 的默认 provider 不会被修改；用户选择前仍使用原来的 DeepSeek provider

> 当前仓库发布的是 source/GitHub 版本，不是 npm 发布包。插件的协议 schema 固定于
> Codex CLI `0.144.1`，升级 Codex CLI 后应先重新生成并审查 schema。

## 标准安装（推荐）

插件市场和 DSH 官方插件 CLI 使用同一条 Bundle 安装路径。对 GitHub source 版本，直接
把 monorepo 中的可安装子包作为 profile 插件加入：

```zsh
dsh plugin --profile web add github:seriousz158/dsh-codex-use#path:/packages/dsh-codex-appserver
```

该命令会把 `dsh-codex-appserver` 加入 profile 的 `dsh.profile.bundles`，并自动读取子包
中的 `cordis.patch.yml`。如果 profile 曾经通过旧安装器安装过本插件，请先按“旧版手工
安装迁移”处理共享 patch，避免同一个 loader 被挂载两次。

## 功能边界

- DSH 会话可以选择 Codex 模型，并复用 DSH 的流式消息、取消和 usage 展示。
- Codex 会话内的命令、文件变更和其它工具由 Codex App Server 自己执行；插件不会把同一批活动翻译成 DSH tool-call 再执行一次。
- 默认使用 `workspace-write` sandbox、`approvalPolicy: never`、临时线程（`ephemeralThreads: true`）。
- 默认不注入 DSH 长期记忆；只有显式设置 `injectMemory: true` 才会读取本地记忆快照。
- 额度行只展示 Codex 官方 `account/rateLimits/read` 数据；读取失败时明确显示不可用，不估算额度。
- 插件不会读取或复制 `~/.codex/auth.json`，登录态由 Codex CLI 管理。
- 不做静默降级或自动切换到 DeepSeek。
- Fast Mode 仅在 `model/list` 声明 `serviceTiers.priority` 时发送 `turn/start.serviceTier`。
- 本地图片只接受 DSH attachment；远程 URL、任意路径和图片生成默认关闭。
- `packages/dsh-codex-search` 是独立且默认关闭的 `codex-search` Bundle，带 SSRF/DNS/MIME/大小边界。
- OAuth 不在本插件实现，保持独立的 `dsh-codex-oauth` 路线。

## 兼容性

| 组件 | 版本/要求 |
| --- | --- |
| Node.js | `>=22` |
| DSH | `>=0.1.0-rc.7 <0.2.0-0`；已验证 `0.1.0-rc.7` |
| Codex CLI | `0.144.1` |
| 运行环境 | macOS + zsh（安装脚本） |

## 旧版手工安装迁移

`integrations/dsh/dsh-codex-install` 仍保留给 DSH `rc.7` 的开发调试场景。它使用共享
`$DSH_HOME/cordis.patch.yml`，写入 `codex-appserver-manual` 条目；当 Bundle 已存在时，
该条目会自动禁用，因此不会与官方 Bundle 重复挂载。

旧版本已经写入 `id: codex-appserver` 的用户，重新运行安装器会：

1. 在同一目录创建带随机后缀的 patch 备份；
2. 将旧条目安全迁移为 `codex-appserver-manual`；
3. 保留原有其它 patch，不覆盖或删除用户配置。

## 安装到已有 DSH（兼容入口）

安装器默认使用 `DSH_HOME=$HOME/.dsh`，也可以显式指定：

```zsh
git clone https://github.com/seriousz158/dsh-codex-use.git
cd dsh-codex-use
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" \
  zsh integrations/dsh/dsh-codex-install
```

安装器会：

1. 在 `$DSH_HOME/profiles/node_modules/` 建立 `dsh-codex-appserver` 软链；
2. 在插件目录建立指向同一 DSH profile modules 的忽略软链；
3. 在 `$DSH_HOME/cordis.patch.yml` 注册一次带 Bundle 重复保护的 `codex-appserver-manual`；
4. 迁移可识别的旧 `codex-appserver` 条目并先创建备份；
5. 拒绝 Web patch 中的重复注册，避免 DSH 的 duplicate loader id 启动错误。

安装器不会复制 `.dsh` 运行时、凭据、会话、长期记忆或浏览器数据。安装后重启 DSH，
在模型/Provider 选择器中显式选择 `OpenAI Codex（ChatGPT）`。如果不选择，默认仍是
DeepSeek。

## 可选设置

将 `examples/dsh/settings.yaml.example` 中的 `llm-codex-appserver` 段合并到
`$DSH_HOME/settings.yaml`。不要把 `agent-default-model` 改成 Codex，除非你明确希望
所有新会话默认使用 Codex；推荐按会话手动选择。

## 只读协议探针

探针只调用以下接口，不发送 `thread/start`、`turn/start` 或任何模型请求：

- `initialize`
- `account/read`
- `account/rateLimits/read`
- `model/list`

```zsh
node tools/codex-appserver-probe.mjs
```

输出默认写入系统临时目录，并对账号、路径、邮箱、token 等字段做脱敏。真实模型回合
需要用户显式授权，并可能消耗 ChatGPT/Codex 配额；本仓库的 CI 不执行真实模型回合。

## 开发与测试

```zsh
npm ci
npm test
```

测试覆盖：

- adapter 的线程、增量输入、取消、恢复和重复提交保护；
- JSON-RPC 帧、协议校验、重启和最小环境变量；
- Codex 额度归一化与稀疏更新；
- Web 额度 UI 的可访问性和主题样式；
- 只读探针与敏感字段脱敏；
- 便携安装器的幂等性和重复注册拒绝；
- 仓库公开边界与秘密扫描。

## 目录

```text
packages/dsh-codex-appserver/   # DSH host/client plugin
integrations/dsh/                # portable installer
examples/dsh/                    # patch/settings examples
tools/codex-appserver-probe.mjs # read-only Codex probe
tools/fixtures/                 # sanitized protocol fixtures
tests/                           # unit, contract, UI and install tests
docs/provider-design.md          # architecture and protocol decisions
```

## 安全与隐私

请勿提交以下内容：

- `$DSH_HOME/.credentials.yaml`、`$DSH_HOME/sessions/`、`$DSH_HOME/storages/`；
- `~/.codex/auth.json` 或任何 OAuth/API token；
- 本机日志、浏览器 profile、真实 transcript、`.env` 文件；
- `node_modules/` 或构建缓存。

提交前运行：

```zsh
npm run scan:secrets
```

当前插件只保留本机 stdio 边界；它不会启动 `127.0.0.1:57321` 一类自定义 HTTP provider，
也不会把 DSH 的凭据环境变量传给 Codex 子进程。

## 发布形态

- `packages/dsh-codex-appserver/package.json` 声明 `dsh.bundle.patch` 和 `dsh.client`；
- `packages/dsh-codex-appserver/cordis.patch.yml` 只插入一个 host loader；
- 官方精选目录条目应指向
  `https://github.com/seriousz158/dsh-codex-use/tree/main/packages/dsh-codex-appserver`，
  不要把仓库根 workspace 当成可安装插件；
- 当前不发布 npm 包，市场使用 GitHub `#path:/packages/dsh-codex-appserver` source 安装。

## 版本说明

`0.2.x` 增加官方 DSH Bundle、doctor、revision-fenced 设置卡、额度状态模型、Fast Mode 和本地图片输入，并保留旧版手工安装迁移。协议 schema 来自 Codex CLI `0.144.1`；如果
Codex App Server 协议发生变化，应先更新 schema、fixture 和协议测试，再发布新版本。
