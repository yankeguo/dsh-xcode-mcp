# 设计说明

本文件记录 `@yankeguo/dsh-xcode-mcp` 的内部设计与生命周期，面向维护者与贡献者。
使用者安装、配置与排障见根 [README](../README.md)；已验证的 DSH/Node/Xcode
兼容面见 [COMPATIBILITY.md](./COMPATIBILITY.md)；发布流程见
[PUBLISHING.md](./PUBLISHING.md)。

## 为什么需要这个插件

DSH 没有 workspace 级 MCP 配置：`mcp-client` 是 profile 级条目，只按固定工作目录
启动一个 server，无法随每个 Session 的项目切换。本插件以 bundle 形式补齐这个
缺口：读取每个活跃 Agent 的工作目录，向上找到最近的 Xcode 项目祖先，在那个
Agent **自己的 Context** 里挂载一个 `mcp-client` 实例，以项目根为 cwd 启动
`xcrun mcpbridge`。工具因此只对该 Agent 可见，Agent dispose 时子进程一并断开。
同一批 Agent 还会收到本地 Xcode 导出的官方 skills。

## 组成

单包、纯 TypeScript，主体在 `src/index.ts`：

- Cordis 插件 `xcode-mcp-autoload`（`name` / `inject: ['agents', 'workingDirectory']`）
  与 `Config` schema；
- 项目发现 `findXcodeProjectRoot`；
- `mcp-client` 挂载配置 `createMountConfig`；
- 每个 Agent 的 attach task（发现 → probe → 挂载 → skills provider）；
- 激活时一次的 skills 导出 `exportXcodeSkills` 与 per-Agent skill provider；
- 生命周期与失败隔离。

运行时只依赖 `yaml`（解析导出的 `SKILL.md` frontmatter）；无 Python、无 `uv`、
无 launcher 脚本。

## 生命周期

### 激活

- `startAutoloader` 先对 `ctx.agents.list()` 中已有的 Agent **并发** backfill
  （`Promise.allSettled`：一个慢启动不拖累其他），再处理之后的 `agent/created`。
- 每次激活只做一次 skills 导出（异步，见下）。
- 注册 `internal/plugin` 卸载观察者：Cordis 会把 effect teardown 推迟到 apply
  settle，卸载开始时该观察者立即 abort 共享 lifecycle，让 in-flight 的启动在
  watchdog 的 abort 路径上结算，不必等满 `startupTimeoutMs`（审计 M2）。

### 每个 Agent 的 attach task

1. 等待 `ctx.workingDirectory.ensure(agent)` 解析工作目录；
2. `findXcodeProjectRoot` 发现项目；
3. 对默认 launcher 做 `xcrun --find mcpbridge` probe；
4. `skills` 开启时先注册 per-Agent skill provider（与 MCP 挂载相互独立；挂载
   失败不影响已注册的 skills）；
5. 通过 `agent.ctx.plugin(McpClient, createMountConfig(config, root))` 挂载 MCP，
   并用 `startupTimeoutMs` 包一个 abort-aware watchdog 等 handshake；
6. 任一步失败：记录诊断、清理已挂载资源，**不抛出**。attach task 背后是串行的
   `agent/created` 监听器，抛出会让 Agent 注册本身失败。

`attach` 用 `WeakMap<Agent, { task, controller }>` 复用 in-flight task：
backfill 和 `agent/created` 可能对同一个 Agent 竞争，事件路径等待同一个 task
而不是立即返回，因此串行创建也一定等到挂载完成。创建 signal abort 时，通过
task 自己的 controller 连带中止 mount/probe，并 dispose 已挂载的 handshake。

### 卸载

- 卸载观察者 abort lifecycle；生命周期 effect 先立即 dispose 已知 fibers
  （打断 in-flight startup），再等待 pending tasks，最后再 dispose 一次兜底。
- MCP handshake 与 skills 导出是 abort-aware 的；项目发现与 10s probe **不响应
  abort**，卸载可能被这两者拖住（probe 最多 10s）。
- dispose Agent 或禁用 bundle 会 dispose 对应 `mcp-client` fiber 与 skill
  provider：关闭 stdio transport、移除 skills。

### 创建时决策

发现与挂载只在 Agent 创建（或插件激活 backfill）时执行一次。瞬时失败不重试；
`workingDirectory.set` 不会重新评估挂载，旧项目的 `mcp__xcode__*` 与 skills 会
留在该 Agent 上，直到 Agent 重建。

## 项目发现

`findXcodeProjectRoot(start)`：

- 从 `resolve(start)` 开始逐级向上检查；
- 命中条件：当前目录中存在名为 `*.xcodeproj` 的**目录**（symlink 项目目录也算）；
- 检查完当前目录后再检查 `.git` 标记：有 `.git` 则停止（不越出仓库）；到文件
  系统根也停止；
- 多个项目共用一层目录时取字典序第一个；返回 `{ root, project }`，`root` 作为
  MCP 子进程 cwd；
- `readdir` 不可读的目录视为“无项目”并继续向上（fail-soft，无诊断）；
- 只识别 `*.xcodeproj`：只有 `.xcworkspace` 的仓库不会挂载。

## Bridge 预检与 MCP 挂载

- 仅对默认形态（`basename(command) === 'xcrun'` 且 `args[0] === 'mcpbridge'`）
  执行 `xcrun --find mcpbridge`，上限 10s；自定义 launcher 直接信任，由 MCP
  client 自行校验。
- 预检失败（无 Xcode 26+、`xcode-select` 指向 Command Line Tools）时记录明确
  诊断并跳过 MCP 挂载与 skills 导出，避免 MCP 连接失败/重试噪音。
- `createMountConfig` 组装 `mcp-client` stdio 配置：
  `serverName`/`command`/`args`/`env`/`cwd`=项目根，并设
  `failOnStartupError: false`（启动失败不能拖垮 Agent 创建）。
- 初始连接 + tool sync 由插件自己的 abort-aware watchdog 按
  `startupTimeoutMs`（默认 30s，整数 1–2147483647）超时；单次工具调用超时由
  MCP client 的 `toolCallTimeoutMs`（默认 60s）控制，本插件不暴露该字段。

## Xcode skills 导出与 provider

### 导出

- 每次激活一次，异步执行（不阻塞激活与 Agent 创建）：
  `xcrun agent skills export --output-dir <cache> --replace-existing`，上限 60s，
  abort-aware。
- 导出使用与 MCP 相同的 Xcode：`command` 的 basename 是 `xcrun` 时复用该路径；
  其他自定义 launcher 回退系统 `xcrun`；`config.env`（如 `DEVELOPER_DIR`）同时
  传给 MCP 与导出。只有 xcrun 类 launcher 能保证两者来自同一个 Xcode。
- `skills` 开启且 `mcpbridge` 不可用时跳过导出。
- 缓存目录：`$DSH_HOME/cache/dsh-xcode-mcp/skills`（默认
  `~/.dsh/cache/dsh-xcode-mcp/skills`）。`$DSH_HOME` 语义对齐 DSH 的
  `resolveDshHome`：空/空白视为未设置，`~`/`~/…` 展开，相对路径按 Host 启动
  目录 resolve。
- 只有成功导出才替换缓存；失败/中断的导出可能留下部分替换的缓存。导出失败记录
  一条诊断，未被本次替换的旧 bundle 仍可用。

### provider

- 每个 Xcode Agent 通过自己的 `agent.ctx.plugin(xcodeSkillsProvider, …)` 注册
  provider，注册落在该 Agent 的 scope 层：只有创建时目录位于 Xcode 项目内的
  Session 能看到，subagent 独立注册；冷（未启动）Session 的 catalog 不包含。
- 导出内容按 rank 600（packaged content 级别）注册，并在自己所在的层内胜过同名
  的打包贡献。DSH 默认组合中文件系统 project/user 根在全局层，而本 provider 注册在
  Agent 层；最近层优先（nearest-layer-wins）使导出的 Xcode skill 在 Xcode
  Session 内遮蔽同名全局 project/user skill，与 rank 无关；需要项目本地 skill
  优先时设 `skills: false`。
- 新鲜度：skill body 每次加载都从缓存重读；新导出落地后 invalidator 使所有活跃
  provider 失效，session catalog 自动刷新，无需重启。
- 容错：缺失缓存目录是合法的空状态（导出未完成或失败）；格式错误/不可读的
  bundle 跳过并诊断，不影响同目录其他 bundle；profile 没有 `skills` service 时
  provider 保持 pending，MCP 功能不受影响。
- 解析：Apple 的 `SKILL.md` 可能用 `when_to_use`，DSH 用 `whenToUse`，两者都
  接受并校验类型（审计 H1）。

## 失败隔离与有界写入

- 缺工作目录、probe 失败、导出失败、MCP 启动失败都只记录日志，绝不让 Agent
  创建失败；清理失败挂载时的清理错误也不会逃逸。
- 插件不写任何项目清单/manifest 文件、没有 Web UI；唯一的文件系统写入是上述
  skills 缓存目录。
- 写操作有界：导出最多 60s，probe 最多 10s；discovery 没有超时（受项目文件系统
  速度影响）。

## 已知竞态与边界

- 激活时若某个 Agent 的 `agent/created` 派发已开始（监听器快照已定），仍有极窄
  的残余竞态；DSH 没有 announcement barrier。
- discovery 与 probe 不响应卸载 abort（见“卸载”）。
- 创建 signal abort 与 backfill 共享 task 的联动、以及 watchdog 的 abort-aware
  结算，均有对应单元测试覆盖。

完整兼容面与已知限制见 [COMPATIBILITY.md](./COMPATIBILITY.md)；每次修复的审计
记录见 [AUDIT.md](./AUDIT.md)。
