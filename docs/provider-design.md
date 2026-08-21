# Codex App Server Provider（codex-chatgpt）设计

## 状态

实现已落地，Phase 1/2 的静态、协议回放、安装 smoke 与本机 Web UI
smoke 已完成（2026-08-21）。这里的“完成”不包含真实模型请求或付费额度消耗；
这两项仍由显式的 live gate 控制。

当前注册边界是一个故意的单一事实源：

- `.dsh/cordis.patch.yml` 是共享 host patch，唯一注册
  `codex-appserver` / `dsh-codex-appserver`。
- `.dsh/profiles/web/cordis.patch.yml` 保持 `[]`。Web 会继承共享 host patch；
  再在 Web patch 注册同一个 id 会触发 rc.7 的 duplicate loader entry。
- 2026-08-21 本机 Web smoke 已确认 HTTP 200，设置页出现 Codex Provider/额度；
  该 smoke 没有发送模型请求。

关键协议与架构事实均已用本机环境实证：`codex app-server generate-json-schema`
（codex-cli 0.144.1）离线导出的完整 JSON Schema，以及对本机
`codex app-server --stdio` 的只读探针（initialize / account/read /
account/rateLimits/read / model/list，未发送任何模型请求）。

## 背景与目标

DSH（`@deepseek-ai/dsh@0.1.0-rc.6`）当前只有 DeepSeek 官方 API 一个正式
provider（另有 pi-ai 多 provider 桥）。本机 Codex CLI 已通过 ChatGPT 账号登录
（探针实证：`account/read` 返回 `type: "chatgpt"`, `planType: "prolite"`），
其 App Server 提供 stdio JSON-RPC 编码代理协议，含 `model/list` 与
`account/rateLimits/read` 等官方接口。

目标：把本机 Codex 作为 DSH 的新 provider（id `codex-chatgpt`，显示名
"OpenAI Codex（ChatGPT）"），让用户在 DSH 会话里手动选择 Codex 模型，
消耗 ChatGPT 套餐额度（非 API 按量付费），并在 UI 显示真实、官方的额度
窗口数据。

### 核心边界（与用户确认过的前提）

- 做成"本机 Codex App Server 适配器"，不伪装成 OpenAI 兼容 API。
- 插件只 spawn `codex app-server --stdio`；不监听端口；不读取、不复制
  `~/.codex/auth.json`——登录态由 codex CLI 自己加载（探针实证 initialize
  返回 `codexHome: ~/.codex`）。
- Codex 会话内，DSH 自己的 Bash/MCP/子代理/文件工具不注入、不执行；
  Codex 全权负责自己的工具调用。
- DeepSeek 保持默认 provider；Codex 按会话手动选择；不做静默降级或
  自动切换。

## 关键架构事实（已验证）

### DSH 侧（源码实证，`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`）

- **LLM 抽象**：provider 实现抽象类 `LlmAdapter`
  （`dsh-llm/lib/types/index.d.ts:113-150`），核心是唯一抽象方法
  `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`，
  外加 `listModels()` / `resolveModel()` / `providerInfo()`。
  通过 `ctx.llm.registerAdapter([provider], adapter)` 注册。
- **agent loop**：`ReactLoopAgent.step()`
  （`dsh-agent-loop/lib/index.js:606-664`）——模型只做带 tool schema 的
  单步 completion，**工具由 DSH 执行**（`tool-call` 块 →
  `executeToolCalls()` → `tool-result` 回灌）。
- **StreamChunk 形状**：`block-start / text-delta / reasoning-delta /
  tool-call-delta / block-end / usage / finish`；`finish.reason` 为
  `stop | tool-calls | max-tokens | aborted | error`。
  `LlmRuntime.adapterStream()` 会把 adapter 异常归一化为终止 chunk。
- **取消**：`GenerateOptions.signal`（AbortSignal），adapter 必须遵守。
- **粒度错配的处理空间**：adapter 可以在一次 `stream()` 内跑完整个外部
  turn，只要**不向外 yield `tool-call` 块**，DSH 就不会尝试执行任何工具。
- **插件免改宿主加载**：`$DSH_HOME/profiles/<name>/` +
  `profiles/node_modules/<name>` 软链 + `$DSH_HOME/cordis.patch.yml` 的
  `insert` 追加（boot 链路 `dsh/lib/profile-boot-*.js`；patch 语义
  `dsh-app-boot/lib/index.js:57-106`）。本机 `dsh-memory` 插件即此模式，
  路径已走通。对于 Codex，host patch 是共享注册入口，Web patch 必须保持空，
  否则 rc.7 会拒绝重复 loader id。host 包的 peer 依赖（dsh-llm、cordis 等）由
  `healProfilesModuleFallback()` 自动软链到宿主同一份实例。
- **设置与凭证**：provider 插件惯例 `installSettingsSection(ctx, ns,
  Config, ...)`（`dsh-settings`），用户配置落在 `$DSH_HOME/settings.yaml`
  同名 section，热更新；凭证经 `ctx.credentials` 引用（本方案不需要新凭证）。
- **UI 扩展**：客户端 slot 体系（`dsh-client-ui-slots`）。设置页可用
  `settings.general.item`（本机 `dsh-memory-ui` 的 MemoryRow 即此模式）；
  数据面用 typert Remote 从 host 侧拉取。
- **辅助调用**：`GenerateOptions.purpose` 可为 `'compaction' |
  'session-title'`，适配器需要处理或明确拒绝。

### Codex 侧（0.144.1 JSON Schema + 只读探针实证）

- 传输：`codex app-server --stdio`，换行分隔 JSON-RPC 2.0。
- 握手：`initialize`（clientInfo）→ `initialized` 通知。
- 账户：`account/read` → `{account:{type:"chatgpt", planType:"prolite"}}`。
- 额度：`account/rateLimits/read` 原始响应可能包含主窗口、Spark 等多个
  bucket 与 `credits`；当前协议归一化和 UI 只公开 `codex` 聚合 bucket，
  不承诺展示 Spark/其他 bucket。通知 `account/rateLimits/updated`；另有
  `account/usage/read` 可补充。
- 模型：`model/list` → 每模型含 `id`、`displayName`、
  `supportedReasoningEfforts[]`（含每档描述）、`defaultReasoningEffort`、
  `inputModalities`、`isDefault`（实测返回 `gpt-5.6-sol` 等）。
   stderr 可能出现模型缓存告警，adapter 须容忍并沿用上次成功结果。
- 会话协议支持 `thread/start`（含 `model`、`sandbox`、`approvalPolicy`、
  `developerInstructions`、`baseInstructions`、`cwd`、`ephemeral`）以及按
  threadId 恢复的 `thread/resume`；当前 adapter 只发送实现契约中允许的字段，
  不发送 `developerInstructions`/`baseInstructions`。
- 回合：`turn/start`（参数含 `threadId`、`input[]`（text/image 等）、
  `model`、`effort`（自由字符串）、`sandboxPolicy`、`approvalPolicy`）；
  `turn/interrupt {threadId, turnId}`；`turn/steer`（v2 候选）。
- 流式通知：`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、
  `item/reasoning/textDelta`、`item/plan/delta`、`item/started`、
  `item/completed`、`turn/completed`、`thread/tokenUsage/updated`。
- 审批（server→client 请求，client 必须应答）：
  `item/commandExecution/requestApproval`、
  `item/fileChange/requestApproval`、`item/permissions/requestApproval`。
- 动态工具（server→client）：`item/tool/call`（`DynamicToolCallParams`）——
  官方预留的工具桥接点，Phase 4 实验用。
- 协议类型生成：`codex app-server generate-ts` / `generate-json-schema`，
  可按本机 CLI 版本离线产出类型。

## 核心决策

### 决策 1：v1 不保留 DSH 的 Bash/MCP/子代理执行语义（仅 Codex 会话内）

架构上不能保留：DSH 的 loop 看到 assistant message 里的 `tool-call` 块就会
用 `ctx.tools` 执行它们。Codex 已经在自己的 loop 里执行过同一批命令，
若 adapter 把 Codex 的工具活动翻译成 `tool-call` 块，必然双重执行、
重复写文件、重复计费。

因此 adapter 在一次 `stream()` 内跑完整个 Codex turn，只向 DSH 暴露
`text-delta / reasoning-delta / usage / finish`；`GenerateOptions.tools`
直接忽略。v1 保留的是 provider 无关的会话契约：session 事件持久化、
UI 流式渲染、取消、模型选择、usage 计量。DeepSeek 路径语义完全不变。

### 决策 2：实现层级选 LlmAdapter，不动 AgentFactory

备选 `ctx.agents.setFactory()` 整体替换 agent 驱动能把 Codex 工具活动映射成
DSH 一等工具事件，但要重新满足整个 `Agent` 接口与 session 事件契约，工作量
与风险是 adapter 路径的数倍。LlmAdapter 路径让取消、流式、usage、模型选择、
session 持久化全部复用现有机制。AgentFactory 留作远期选项。

### 决策 3：插件落地形态——本仓库 `packages/` + 运行时软链，零改动宿主

- 开发位置：本仓库 `packages/dsh-codex-appserver/`（单包，含 host 面
  `lib/index.js` 与客户端面 `lib/client.js`，package.json 声明
  `dsh.client` 与 `./client` 导出；若客户端 bundling 有障碍再拆成
  `dsh-codex-appserver-ui`，仿 `dsh-memory`/`dsh-memory-ui` 双包先例）。
- 安装：`bin/dsh-codex-install`（幂等脚本）建立
  `.dsh/profiles/node_modules/dsh-codex-appserver -> ../../../packages/dsh-codex-appserver`
  软链（相对路径基准是 `.dsh/profiles/node_modules`），并确保共享
  `.dsh/cordis.patch.yml` 只有一个
  `- insert: [{id: codex-appserver, name: dsh-codex-appserver}]` 注册。
  Web patch 保持 `[]`，不得追加重复条目。
- 卸载即移除软链与 patch 条目，宿主包与 DeepSeek 配置不受影响。

### 决策 4：额度数据只展示官方字段，失败明确标记

`account/rateLimits/read` 的 `usedPercent / windowDurationMins / resetsAt`
直接渲染；读取失败显示"暂时无法读取"，绝不伪造或估算。

## 详细设计

### 插件结构

```
packages/dsh-codex-appserver/
├── package.json            # name: dsh-codex-appserver, dsh.client, exports ./client
├── lib/
│   ├── index.js            # cordis 插件入口：apply(ctx, config)
│   ├── adapter.js          # CodexAppServerAdapter extends LlmAdapter
│   ├── rpc.js              # stdio JSON-RPC client（spawn/帧解析/请求复用/看门狗）
│   ├── threadmap.js        # sessionId→threadId 持久化
│   ├── ratelimits.js       # 额度读取/节流/订阅，暴露 typert Remote
│   ├── protocol/           # generate-ts 产物（随 CLI 版本固定）
│   └── client.js           # 设置页额度行（settings.general.item slot）
└── README.md
```

插件入口结构对照 `dsh-llm-deepseek/lib/index.js:719-779`：
`ctx.llm.registerConfigurableProviders([{provider: "codex-chatgpt",
displayName: "OpenAI Codex（ChatGPT）", settingsNs: "llm-codex-appserver"}])`
+ `ctx.llm.registerAdapter(["codex-chatgpt"], adapter)`
+ `installSettingsSection(ctx, "llm-codex-appserver", Config, ...)`。

### stream() 契约映射

| DSH `LlmAdapter` | Codex app-server |
|---|---|
| `stream()` 开始（已知 sessionId） | 默认 `ephemeralThreads=true`：查/更新 host-side 状态并用 `thread/start` 开一次临时线程；显式设为 `false` 且已有持久线程时才调用 `thread/resume`。`thread/start` 不发送 `developerInstructions` |
| 本回合输入 | 只取 DSH 消息里**自上次回合后新增的 user 消息**，组成 `turn/start` 的 `input`（Codex thread 自己保留上下文，杜绝重复计费） |
| `reasoningEffort` | `turn/start.effort`（字符串直通，值域来自 `model/list`） |
| 会话级模型切换 | `turn/start.model`（逐回合生效，已验证协议支持） |
| 流式正文 | `item/agentMessage/delta` → `text-delta` |
| 推理摘要 | `item/reasoning/summaryTextDelta` → `reasoning-delta` |
| usage | `turn/completed` 的 tokenUsage → `usage` chunk（Phase 1 探针确认字段名；fallback `thread/tokenUsage/updated` 末值） |
| 正常结束 | `turn/completed` → `finish: stop` |
| 取消 `signal` | `turn/interrupt {threadId, turnId}`（adapter 跟踪当前 turnId）；随后让流终止，由 `LlmRuntime` 归一化为 `aborted` |
| Codex 工具活动（commandExecution 等） | v1 不翻译、不展示（仅 server 侧执行）；v1.1 可用只读 session projection 做活动指示 |
| `purpose: compaction / session-title` | `thread/start {ephemeral: true}` 开一次性线程跑单回合，不污染主 thread |
| turn 级错误 | 映射为 `finish: error`，**不映射进默认可重试集合**（避免重复执行已部分执行的 turn） |

### 审批与安全映射

spawn 参数与 `thread/start` 固定保守策略：

- `sandbox: "workspace-write"`（与 `bin/dpsk` 的
  `DSH_PERMISSION_MODE=workspace-write` 对齐）；配置只接受
  `read-only` / `workspace-write`，不提供 `danger-full-access`。
- `approvalPolicy: "never"` 是唯一接受的值。少数仍到达 adapter 的审批请求
  （`item/commandExecution/requestApproval` 等）一律**拒绝**并记录；
  v1 不提供 approval UI 或 `untrusted`/`on-request` 配置。
- `turn/start.cwd` = DSH 会话的 workspace 目录。
- 永不读取/复制 `~/.codex/auth.json`；`codexBin` 从 PATH 或设置的绝对
  路径解析。

### 增量输入与会话切换

- host-side thread 状态持久化在 `$DSH_HOME/storages/codex-appserver/threads.json`：
  `sessionId → {threadId, lastSeenUserMsgId, model, updatedAt}`。但默认
  `ephemeralThreads=true`，Codex 线程不跨进程保留；只有显式设置
  `ephemeralThreads=false` 时才使用该映射并在需要时 `thread/resume`。
- 会话从 DeepSeek 切到 Codex 的首回合：Codex thread 没有历史，adapter
  生成一份压缩转录（最近 N 条、去除 tool 块、标注角色，默认 N=20）作为
  首条 user 消息的前缀上下文，再接本次输入。
- 反向切换（Codex → DeepSeek）无需处理：DeepSeek 走 DSH log 全量历史，
  天然完整。

### System prompt 边界

DSH 的 system prompt 含 DSH 工具说明，不转发给 Codex。`injectMemory` 默认
关闭；只有显式设为 `true` 且能读取到快照时，adapter 才把记忆放入
`turn/start.additionalContext["dpsk-memory"]`，并标记为 `kind: "untrusted"`。
它不会进入 `developerInstructions`，也不会把 DSH system prompt 转发给 Codex。

### 模型与 reasoning effort

- `listModels()` = 进程内缓存的 `model/list`（TTL 5 分钟 + 启动时刷新 +
  `llm/adapters-updated` 时失效），直接映射 `id/displayName/
  supportedReasoningEfforts/defaultReasoningEffort`，不硬编码任何模型名。
- `resolveModel()` 返回所选模型的 efforts 列表与默认档；
  `contextWindow` 协议未提供时省略（不编造）。
- `model/list` 失败（见过 stderr 缓存告警）：沿用上次成功缓存；无缓存则
  返回空目录并在额度行同级位置提示。

### 额度显示

- host 侧 `ratelimits.js`：启动、打开模型选择器（经 RPC 调用触发）、
  每回合结束、收到 `account/rateLimits/updated` 通知时读取
  `account/rateLimits/read`；30 秒节流。
- 客户端 `client.js` 注册 `settings.general.item` slot（仿
  `.dsh/profiles/dsh-memory-ui` 的 MemoryRow），经 typert Remote 拉取，
  仅渲染归一化后的 Codex 聚合窗口；失败或没有可用 bucket 显示
  "暂时无法读取"。Remote 返回 `{ ok: true, value }` 或
  `{ ok: false, error: { code } }`。
- v1.1：模型选择器（`conversation.input.model`，single 型 slot）内嵌额度
  摘要，需 priority 遮蔽现有 occupant，单独评估。

### 进程生命周期

- 懒启动：首个 Codex 请求到来时 spawn `codex app-server --stdio`；
  全 host 共享一个进程，JSON-RPC 按 id 复用。
- 看门狗：进程退出 → 在途 turn 全部以 `aborted` 结束，下次请求按需重启
  （指数退避，最多 3 次后进入明确错误态）。
- `ctx.on('dispose')` 时优雅终止子进程。
- 兼容性检查：启动时读 `codex --version`，与插件内置类型生成时的版本
  比对；minor 不一致 → 明确警告（协议标记 experimental，不静默硬撑）；
  initialize 失败 → adapter 注册但不提供模型，额度行显示原因。

### 设置 schema（namespace `llm-codex-appserver`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `codexBin` | string | `""`（PATH 自动探测） | codex 可执行文件绝对路径 |
| `sandbox` | enum | `workspace-write` | `read-only / workspace-write` |
| `approvalPolicy` | enum | `never` | 唯一接受值；协议审批请求在 adapter 侧拒绝 |
| `ephemeralThreads` | boolean | `true` | 默认不保留 Codex history；设为 `false` 才启用持久 thread/resume |
| `injectMemory` | boolean | `false` | 记忆经 `turn/start.additionalContext["dpsk-memory"]` 以 `untrusted` 传入 |
| `historyBootstrap` | number | `20` | 切换 provider 首回合携带的压缩转录条数 |
| `rateLimitRefreshSec` | number | `30` | 额度读取节流 |
| `requestTimeoutMs` | number | `600000` | turn 级超时 |

## 不在范围内（v1）

- DSH 工具（Bash/MCP/子代理/文件/todo 等）在 Codex 会话内的任何注入或
  执行；双向工具桥接（Phase 4 实验，`item/tool/call` + dynamicTools）。
- 把 Codex 工具活动映射为 DSH 工具事件（那是 AgentFactory 路线的事）。
- 审批请求的 UI 化（v1 一律按策略自动应答）。
- 多 Codex 账户、API key 模式、远程 app-server（ws/unix socket）。
- 模型选择器内嵌额度显示（v1.1）。
- `turn/steer`、`thread/fork`、`review/start` 等高级能力的暴露。

## 分期实施与验收

### Phase 1：只读探针（不发送模型请求，已完成）

- `tools/codex-appserver-probe.mjs`（由 /tmp 探针固化而来）：initialize →
  `account/read` → `account/rateLimits/read`（含订阅一次
  `account/rateLimits/updated` 的注册路径）→ `model/list`，全程实录
  JSON-RPC 帧到 `tools/fixtures/`（脱敏）。
- 确认项：usage 在 `turn/completed` 的确切字段名（从 schema 静态确认，
  不发请求）；记忆边界改为 adapter 的 `additionalContext` 契约；
  `generate-ts` 产物与 0.144.1 的对应关系。
- 验收：脚本零模型请求跑通，实录文件作为 provider 回放测试 fixture。

### Phase 2：provider 插件（实现已落地）

- `packages/dsh-codex-appserver/` 全部代码 + `bin/dsh-codex-install`。
- 已验收：静态契约、协议回放、线程状态、UI descriptor、安装脚本和
  shared-host/Web 注册唯一性测试；本机 Web HTTP 200 且设置页显示
  Codex Provider/额度。
- 尚未执行（显式 live gate）：真实模型多轮/取消、真实套餐额度消耗，以及
  `ephemeralThreads=false` 的跨重启 `thread/resume`。默认模式保持临时线程。

### Phase 3：回归

- `tests/` 现有 7 个脚本全部通过；DeepSeek 默认 provider、记忆插件、
  DPSK 启动不受影响。
- 新增 `tests/test_dsh_codex_appserver_adapter.mjs`：用回放 fixture 的假
  app-server 覆盖 stream 映射/取消/错误/审批拒绝/额度节流，无需活 Codex。
- 活测试 `tests/test_dsh_codex_live.sh` 门控在 `DSH_CODEX_LIVE=1`
  （消耗真实套餐额度，默认不跑）。

### Phase 4：工具桥接可行性实验

- 验证 `item/tool/call`（dynamicTools）与 DSH `ctx.tools` 三级 waterfall
  的兼容性：DSH 工具 schema 注入 Codex、Codex 发起的调用路由回 DSH 执行
  （保留 DSH 权限/审计语义）。
- 未通过则维持"Codex 自带工具"模式，不影响 v1 稳定性。

## 风险与取舍

- **协议 experimental**：以版本固定（vendored 类型 + 运行时版本比对 +
  明确警告）对冲；不试图跨版本兼容未知字段。
- **额度共享池**：DSH 消耗与 codex CLI 消耗同一份套餐周额度（当前已用
  88%）；联调期控制测试轮次。
- **取消粒度**：`turn/interrupt` 后 Codex 侧已执行的工具效果（文件改动）
  不会回滚——与 codex CLI 行为一致，属预期。
- **长 turn 无中间活动显示**：v1 只流式正文与推理摘要，工具执行期间
  UI 仅显示"运行中"；v1.1 用 projection 改善。
- **DSH log 与 Codex thread 双份历史**：两侧各自持久化属有意设计
  （增量输入依赖 thread 侧上下文）；DSH log 始终是 UI 的唯一事实源。

## 备选方案记录

- **AgentFactory 整体替换**：能映射 Codex 工具活动为 DSH 一等事件，但需
  重实现 `Agent` 全接口与 session 事件契约；工作量大、回归面广。远期可选。
- **pi-ai Codex OAuth route**：`@earendil-works/pi-ai` 内置
  "OpenAI Codex (ChatGPT)" provider，可保住 DSH 自有 agent loop。但走
  HTTPS responses 后端，无 `account/rateLimits/read`，拿不到官方额度数据，
  且需触碰 `~/.codex/auth.json` 的 OAuth token，越过既定边界。排除。

## 开放问题（实现后的剩余验证）

1. 真实模型请求与取消行为（需要显式 `DSH_CODEX_LIVE=1`，会消耗套餐额度）。
2. `ephemeralThreads=false` 的真实跨进程恢复保真度；默认临时线程不依赖该
   行为，隐私优先。
3. rc.8+ runtime 的非阻断兼容探测。

（`thread/resume` 仅属于显式持久化模式，不是默认行为。）
