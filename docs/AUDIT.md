# 审计清单（2026-11-19，基线 commit 6757b43）

全面审计 `src/index.ts`、`tests/`、`cordis.patch.yml`、`package.json`、README、locale、icon 的分级发现与处置。
修复提交：`2de9ba0`（refactor!）、`8f61394`（docs）、`1f61a37`（chore）。

## 高（已修复）

### H1. 失败隔离缺口：清理失败会拒绝 Agent 注册
`attach` 的 catch 分支中 `await mounted.dispose()` 若再抛错，错误沿 task 传播到 serial
`agent/created` 监听器。`dsh-agent` 的 `register()` 明确「Rejects if a serial `agent/created`
listener fails」——即一次失败的 MCP 清理会导致 **Agent 注册本身失败**，违背「失败绝不影响
Agent 创建」的设计承诺。
**修复**：dispose 包 try/catch 并记 warn；新增测试「cleaning up a failed mount also fails」。

## 中（已修复）

### M1. 架构冗余：uv/Python launcher（lead 决策，破坏性默认值变更）
Python launcher 是全局 profile 条目时代的产物：插件已做 per-workspace 发现（无项目不挂载），
dummy 分支不可达；桥接分支无非 `exec xcrun mcpbridge`。
**修复**：纯 TS 直挂，默认 `command: xcrun`、`args: [mcpbridge]`、`env: {}`；包内不含 Python。
新增挂载前预检 `xcrun --find mcpbridge`（10s 上限）：失败跳过挂载并记清晰诊断，避免 McpClient
连接失败/重试噪音；自定义 command/args 不预检，交由 McpClient 校验（取舍：预检只覆盖默认
launcher，通用性交给 `failOnStartupError: false` + 看门狗兜底）。

### M2. `setTimeout` 溢出
`startupTimeoutMs` 无上限；> 2^31−1 时 Node 定时器溢出立即触发，看门狗变成即时失败。
**修复**：schema `.max(2_147_483_647)`；新增边界测试（0、2^31、2^31−1）。

### M3. 符号链接 `*.xcodeproj` 不识别
`readdir(withFileTypes)` 的 `dirent.isDirectory()` 对符号链接为 false，链接指向的项目目录被漏掉。
**修复**：符号链接候选项经 `stat` 判定目标是否为目录；新增 4 个测试（链接目录、链接到文件、
悬空链接、真实/链接混合的字典序）。

## 低（已修复）

- **L1. backfill 串行**：逐个 await 每个 Agent 的 MCP 启动，激活时间为总和。改为
  `Promise.allSettled` 并发，激活时间 = 最慢一个。
- **L2. 误导性 teardown 注释**：原注释声称 teardown 总能打断 in-flight 启动；cordis 源码
  （`disposeAfter(waitForSetup())`）证实 **apply 未 settle 时 effect teardown 被推迟**，
  backfill 期间的挂起启动只能由看门狗兜底。注释已修正；新增事件路径的 teardown 打断测试
  （10s 看门狗下 <5s 完成卸载）。
- **L3. 冗余 import**：重复的 `import type {} from '@deepseek-ai/dsh-agent'` 删除。
- **L4. 诊断信息**：mount 失败日志补充项目根路径；预检失败日志给出 Xcode 26+ /
  `xcode-select` 修复指引。

## 已知边界（保持现状，文档化）

- **创建时决策**：`workingDirectory.set` 不重新评估挂载；`seen` WeakSet 失败后不重试——
  两者语义一致，README 已声明。
- **权限错误**：`readdir` 失败（含 EACCES）静默视为无项目并继续向上走；发现函数是纯函数，
  无 logger 注入点。README troubleshooting 覆盖。
- **路径解析**：`resolve()` 为词汇解析，不跟随符号链接 cwd；`ensure` 返回绝对路径，向上走
  使用逻辑路径（与 git 行为一致）。
- **预检与 abort**：预检子进程不随 scope abort 被 kill（10s 上限兜底），probe 后复查
  `scope.aborted`。
- **重复挂载防护**：backfill 与 `agent/created` 双路径经 `seen` WeakSet 去重（新增竞态测试）；
  插件卸载时 fibers 两轮 dispose 覆盖 in-flight task 后补挂的 fiber。

## 文档与元数据（已修复）

- README 重写：纯 TS 架构、新默认值表、预检行为、安装方式（`dsh plugin --profile desktop add`
  / Web Plugins / 本地 link）、**Xcode 授权门**（首次连接需在运行中的 Xcode 内批准）、
  troubleshooting；删除 uv/PyPI 镜像与「private 不发布」表述。
- `package.json`：移除 `private`，加 `publishConfig.access: public`、repository/homepage/bugs、
  `check:packages` 与 `release:*` scripts。版本 0.1.0、包名不变 → desktop link 安装保持有效。
- locale en/zh、icon.svg（725 B ≤ 256 KiB）、cordis.patch.yml 审计无问题。

## 测试

23 → **37**（3 个 spec 全过）：预检跳过/失败、清理失败隔离、backfill+事件去重竞态、
in-flight teardown 打断、符号链接发现 ×4、config 边界 ×3、`probeMcpBridge` 单元 ×3。
测试不依赖真实 Xcode（probe seam 默认 true，CI 无 Xcode 亦可全绿）。

## 兼容面

临时 worktree 核对 `dsh-v0.2.1-rc.1`（用完已清理）：McpClient stdio Config 全部所用字段
（transport/serverName/command/args/env/cwd/toolCallTimeoutMs/failOnStartupError）存在；
`workingDirectory.ensure(agent, signal?)` 签名一致；`agent/created` serial 语义一致。
rc.1 无 `startupTimeoutMs`（插件自带看门狗正是为此）。运行基准 0.2.2-rc.5 实测：
deepcal 真实链路冒烟 54 个 `mcp__xcode__*` 工具，dispose 后子进程退出。
`engines.dsh >=0.2.1-rc.1 <0.3.0` 不变。