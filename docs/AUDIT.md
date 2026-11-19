# 审计清单

## DeepSeek v4.1 Flash / Max 独立审计（2026-11-19，基线 commit 8460647）

对 `src/index.ts`、`tests/`、`package.json`、`cordis.patch.yml`、`README.md`、
`docs/`、`scripts/` 与 workflows 做第二遍独立审计。工作树从 `8460647` 干净开始，
未假设前序审计改动存在。运行时基准 DSH `0.2.2-rc.5`；真实环境为 macOS +
Xcode 27.2，实测 `xcrun mcpbridge` 暴露 54 个工具（3 个并发 bridge 各自 54 个），
`xcrun agent skills export` 导出 11 个 skill（共 892 KiB，约 0.09s）。

### 高（已修复）

**H1. Apple skills 的 `when_to_use` 被静默丢弃。**
真实导出中 Apple 使用 snake_case 的 `when_to_use`（Xcode 27.2 的
`adopt-c-bounds-safety` 即如此），而解析器只读 DSH 风格的 `whenToUse`，导致该
skill 的路由提示不进入 `SkillSummary.whenToUse`。
**修复**：两种拼写都接受并校验类型；新增 snake_case + camelCase 测试。

**H2. backfill 与 `agent/created` 竞态会让 Agent 创建先于挂载完成。**
`seen` 在 backfill 任务仍在进行时就让事件监听器立即返回，serial
`agent/created` 因此不等待挂载；Agent 可能在工具注册前就完成创建。
**修复**：用 `WeakMap<Agent, Promise<void>>` 复用 in-flight 任务，事件路径等待
同一个任务；新增“事件等待 backfill 挂载”测试（先前的 `seen` 实现会失败）。

### 中（已修复）

**M1. `startupTimeoutMs: NaN` 通过 schema，看门狗立即触发。**
Schemastery 的 `.min()/.max()` 对 `NaN` 的比较均为 false；YAML 的 `.nan` 会让
每次挂载立刻超时。
**修复**：`.step(1)`（同时拒绝小数毫秒）；新增 NaN/小数测试。

**M2. 初次 backfill 期间卸载要等满 30s 看门狗。**
Cordis 把 effect teardown 推迟到 apply settle；README 声称“卸载会打断 in-flight
启动”只在创建路径成立。初次回填的挂载仍在飞时，禁用 bundle 会一直等到
`startupTimeoutMs`。
**修复**：注册 `internal/plugin` 卸载观察者立即 abort lifecycle；看门狗改为
abort-aware 并 `unref()` 定时器；新增“backfill 期间卸载 <5s”测试。README 的
teardown 表述同步修正。

**M3. `$DSH_HOME` 的空值/波浪号/相对路径处理与 DSH 不一致。**
`DSH_HOME=''` 会得到相对路径 `cache/dsh-xcode-mcp/skills`（相对 Host 启动目录），
`DSH_HOME='~/x'` 不展开，相对值不 `resolve`。
**修复**：按 `resolveDshHome` 的规则处理空/空白、`~`、相对路径；新增 6 组断言。

**M4. skills 导出忽略 `env` 与自定义 xcrun 路径。**
`config.env`（典型如 `DEVELOPER_DIR`）只作用于 `mcpbridge`，导出仍用 PATH 上的
`xcrun`，多 Xcode 安装时 skills 与 MCP 可能来自不同 Xcode。
**修复**：probe 与 export 接收同一套 command/env；自定义路径 basename 为 `xcrun`
时复用之，否则仍用系统 `xcrun`；新增 probe/export 的 env 测试。

**M5. 不可读的 skill 缓存被当成空目录/空 bundle，静默无日志。**
`readdir`/`readFile` 的所有错误都被吞掉，只有 YAML/frontmatter 解析错误才 warn。
**修复**：只有 `ENOENT`（以及读文件时的 `ENOTDIR`）视为正常缺失；其余错误
warn，并区分“不可读或格式错误”；新增 EISDIR、cache 路径为文件的测试。

**M6. README 的 Xcode 授权流程与实际行为不符。**
Xcode 27.2 中仅“连接”不会触发授权；除 `XcodeOpenWorkspace`/`XcodeNewProject`
外的工具会返回 “This agent isn't approved to use Xcode's tools yet”。README 与
release notes 原称首次连接即弹授权，用户会误判为插件故障。
**修复**：README 的 Behavior、Troubleshooting、Verify 与 v0.1.0-rc.1 release
notes 明确“先调用 `XcodeOpenWorkspace`（绝对 `.xcodeproj`/`.xcworkspace` 路径）
并批准”。

**M7. 发布状态文档与实际 registry/CI 不符。** 实际 npm `latest` 与 `next` 都指向
`0.1.0-rc.1`，且更早还有 `0.0.0-stage`；GitHub Release 尚未创建。`v0.1.0-rc.1`
的 tag push run `44498942152` 在 “Resolve and verify the release tag” 步骤就失败
（tag commit `d96f65d` 早于支持 prerelease staging 的 `44ea5b1`），并非文档所称
“跑到 stage 步骤才因版本已发布而失败”；dispatch 同一 tag 也不会重新 stage 已发布
版本。**修复**：README / release notes / PUBLISHING 记录实况与 dist-tag 纠正建议；
`promote-release.mjs` 的 edit 路径补 `--latest=false`；publish.yml 与
trusted-publishers.sh 的“尚未发布”注释更正。

**M8. README 称不可读项目树会记录日志。** 实际 `firstXcodeProject` 静默把
`readdir` 错误当作“无项目”并继续向上走，没有 logger。**修复**：README 与 release
notes 改为“按无项目处理、继续向上”，不再声称会记录日志；代码保持 fail-soft。

**M9. peerDependencies 与 0.2.1-rc.1 的宿主版本不匹配。** 原 `@deepseek-ai/cordis
~4.1.0`、`@deepseek-ai/schemastery ~3.19.0` 只覆盖 0.2.2-rc.5；rc1 实际带
cordis 4.0.5 / schemastery 3.18.5。子代理在 rc1 包集下跑通 typecheck 与当时的 59 个
测试，但 pnpm 会报 unmet peer，严格 peer 配置会安装失败。**修复**：放宽为
`>=4.0.5 <4.2.0` / `>=3.18.5 <3.20.0`（engines.dsh 不变）；devDependencies 仍
固定 0.2.2-rc.5 作为类型/测试基准。

### 低（已修复）

- **L1. 仅 macOS 的 bundle 未声明平台。** 加 `dsh.bundle.platforms: ["darwin"]`，
  避免 Linux/Windows 安装一个必然无效的 bundle；`check-packages` 增加不变式。
- **L2. README 的 `docs/PUBLISHING.md` 相对链接在 npm tarball 中失效**
  （`docs/` 不在 `files`）；改为 GitHub 绝对链接。
- **L3. 失败导出的缓存表述过强。** `--replace-existing` 是逐项替换，失败时
  可能已替换一部分；README/release notes 改为“未被本次替换的缓存仍可用”。
- **L4. `check-packages.mjs` 注释称“无任何运行时依赖”**，实际依赖 `yaml`；
  已修正。
- **L5. `Config` 注释称无 `skills` 服务时导出会被跳过**，实际导出仍会运行、
  provider 保持 pending；已修正注释，避免与代码不符。
- **L6. `startupTimeoutMs` 文档补上“整数毫秒”。**
- **L7. “mounted” 日志可能误导。** `failOnStartupError: false` 时 mcp-client
  初次连接失败也会正常返回，插件原先仍记 “mounted”；改为 “registered”，连接
  失败由 mcp-client 自己 warn。
- **L8. skills 优先级表述易误解。** README/release notes 原先把“同层
  project/user roots 优先”与“agent 层覆盖全局层”并列，读者可能以为 project/user
  总能覆盖导出的 Xcode skill；已改为明确说明 DSH 默认把这些 roots 注册在全局层，
  因此 agent 层 provider 按 nearest-layer-wins 覆盖它们，rank 600 只在同层内生效。

### 未改项与理由

- **创建时决策 / 单次尝试 / 目录变更后残留**：`workingDirectory.set` 不重新评估
  挂载，瞬时失败不重试；移动到新目录后旧项目的工具与 skills 仍附着在该 Agent 上，
  直到新建 Agent。DSH 未向本插件暴露简洁的 per-session 目录变更挂载点；重挂载会
  引入 dispose/remount 竞态与工具名冲突。README 已明确该语义（本次补充“旧挂载
  会残留”，避免“no project, no mount”被误读为动态保证）。
- **engines.node 保持 >=24.9**：rc1 的 DSH 允许 Node ^22.19，本插件代码也未使用
  24.9 专属 API，但没有在 Node 22 上跑过完整测试；为避免扩大未验证支持面，保持
  rc5 基线。DSH rc1 的 API 兼容性由 peer 范围覆盖，Node 版本仍是独立要求。
- **probe 不随 abort 被杀**：`xcrun --find mcpbridge` 有 10s 上限，实测约 3.7ms；
  为它增加 signal 贯穿会扩大测试 seam，收益小。看门狗路径已 abort-aware。
- **插件激活与“已在派发中”的 `agent/created` 的残余竞态**：Cordis `serial` 在
  调用时快照监听器；若插件在某个 Agent 的创建派发已开始后才注册监听器，backfill
  会看到该 Agent 并开始挂载，但创建路径不会等待它。插件侧没有 DSH announcement
  barrier 可用；窗口很窄（启用/HMR/激活与 Agent 创建重叠）。本次修复覆盖的是
  “监听器已注册、backfill 先启动”的常见路径。
- **Cordis config restart 不触发 `internal/plugin`**：若 restart 时 backfill 挂载
  仍卡住，卸载/重启仍需等看门狗（默认 30s）。普通 dispose 路径已覆盖；restart
  属于罕见运维动作，未改。
- **skills 导出在无 Xcode Agent 时也执行**：实测 0.09s / 892 KiB，每次激活一次；
  延后到首个 Xcode Agent 会让冷启动目录更晚出现 skills，收益不足。
- **`XCODE_SKILL_RANK = 600` 硬编码而不 import `BUNDLED_SKILL_RANK`**：`dsh-skill`
  是 optional peer，运行时 import 会让没有 skills 服务的 profile 在加载期失败；
  该常量在 rc1/rc5 一致，硬编码是刻意的取舍。
- **不向 mcp-client 转发 `startupTimeoutMs`**：rc1 的 mcp-client 没有该字段；插件
  自带 abort-aware 看门狗（默认 30s）覆盖 initial connect + tool sync，rc5 下不
  再叠加客户端 deadline。
- **每个 Agent 各跑一次 probe**：实测约 3.7ms；缓存失败结果又会阻碍 Xcode
  安装后的恢复，故不缓存。
- **skills 缓存的多 Host 并发导出**：`--replace-existing` 的并发窗口很窄，且
  两个 DSH Host 共享同一 `$DSH_HOME` 的情况罕见；未引入锁。
- **只识别 `*.xcodeproj`**：这是当前公开契约；`.xcworkspace`-only 仓库不会被
  挂载，README 已按现状描述。若未来要支持，应作为独立功能变更并补充测试。
- **不可读项目树 fail-soft 继续向上走**：与“发现失败不影响 Agent 创建”一致；
  旧审计已记录。
- **probe 与 discovery 的非 abort 子步骤**：均有 10s/文件系统粒度上限；项目树
  位于挂死的网络卷时仍可能拖慢卸载，属于已知残余风险。
- **`toolCallTimeoutMs` 未暴露**：属于 mcp-client 的配置面；本插件只负责挂载。
  README 已说明大构建可在自定义 mcp-client 设置中调整。

### 验证

- `pnpm install --frozen-lockfile`、`pnpm verify`（61 tests / 4 files）、
  `pnpm check:packages`（136 checks）全绿。
- 真实环境：Xcode 27.2 的 `xcrun mcpbridge` 握手 54 tools；3 个并发 bridge 均
  54 tools；`xcrun agent skills export` 11 skills；导出的 `when_to_use` 已由新增
  测试覆盖。
- `pnpm pack` tarball 内容检查（lib/cordis/locale/icon/README/LICENSE，无
  src/tests/scripts/node_modules）。
- 推送后 `verify.yml` 的 run URL / conclusion 见本次交付回复。

## 初版审计（Qwen 4 Max，2026-11-19，基线 commit 6757b43）

> 以下保留初版记录；其中被本次审计推翻或更新的结论（如 `seen` 去重、Xcode 授权门）以上文对应条目为准。

全面审计 `src/index.ts`、`tests/`、`cordis.patch.yml`、`package.json`、README、locale、icon 的分级发现与处置。
修复提交：`2de9ba0`（refactor!）、`8f61394`（docs）、`1f61a37`（chore）。

### 高（初版已修复）

#### H1. 失败隔离缺口：清理失败会拒绝 Agent 注册
`attach` 的 catch 分支中 `await mounted.dispose()` 若再抛错，错误沿 task 传播到 serial
`agent/created` 监听器。`dsh-agent` 的 `register()` 明确「Rejects if a serial `agent/created`
listener fails」——即一次失败的 MCP 清理会导致 **Agent 注册本身失败**，违背「失败绝不影响
Agent 创建」的设计承诺。
**修复**：dispose 包 try/catch 并记 warn；新增测试「cleaning up a failed mount also fails」。

### 中（初版已修复）

#### M1. 架构冗余：uv/Python launcher（lead 决策，破坏性默认值变更）
Python launcher 是全局 profile 条目时代的产物：插件已做 per-workspace 发现（无项目不挂载），
dummy 分支不可达；桥接分支无非 `exec xcrun mcpbridge`。
**修复**：纯 TS 直挂，默认 `command: xcrun`、`args: [mcpbridge]`、`env: {}`；包内不含 Python。
新增挂载前预检 `xcrun --find mcpbridge`（10s 上限）：失败跳过挂载并记清晰诊断，避免 McpClient
连接失败/重试噪音；自定义 command/args 不预检，交由 McpClient 校验（取舍：预检只覆盖默认
launcher，通用性交给 `failOnStartupError: false` + 看门狗兜底）。

#### M2. `setTimeout` 溢出
`startupTimeoutMs` 无上限；> 2^31−1 时 Node 定时器溢出立即触发，看门狗变成即时失败。
**修复**：schema `.max(2_147_483_647)`；新增边界测试（0、2^31、2^31−1）。

#### M3. 符号链接 `*.xcodeproj` 不识别
`readdir(withFileTypes)` 的 `dirent.isDirectory()` 对符号链接为 false，链接指向的项目目录被漏掉。
**修复**：符号链接候选项经 `stat` 判定目标是否为目录；新增 4 个测试（链接目录、链接到文件、
悬空链接、真实/链接混合的字典序）。

### 低（初版已修复）

- **L1. backfill 串行**：逐个 await 每个 Agent 的 MCP 启动，激活时间为总和。改为
  `Promise.allSettled` 并发，激活时间 = 最慢一个。
- **L2. 误导性 teardown 注释**：原注释声称 teardown 总能打断 in-flight 启动；cordis 源码
  （`disposeAfter(waitForSetup())`）证实 **apply 未 settle 时 effect teardown 被推迟**，
  backfill 期间的挂起启动只能由看门狗兜底。注释已修正；新增事件路径的 teardown 打断测试
  （10s 看门狗下 <5s 完成卸载）。
- **L3. 冗余 import**：重复的 `import type {} from '@deepseek-ai/dsh-agent'` 删除。
- **L4. 诊断信息**：mount 失败日志补充项目根路径；预检失败日志给出 Xcode 26+ /
  `xcode-select` 修复指引。

### 已知边界（初版保持现状，文档化）

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

### 文档与元数据（初版已修复）

- README 重写：纯 TS 架构、新默认值表、预检行为、安装方式（`dsh plugin --profile desktop add`
  / Web Plugins / 本地 link）、**Xcode 授权门**（首次连接需在运行中的 Xcode 内批准）、
  troubleshooting；删除 uv/PyPI 镜像与「private 不发布」表述。
- `package.json`：移除 `private`，加 `publishConfig.access: public`、repository/homepage/bugs、
  `check:packages` 与 `release:*` scripts。版本 0.1.0、包名不变 → desktop link 安装保持有效。
- locale en/zh、icon.svg（725 B ≤ 256 KiB）、cordis.patch.yml 审计无问题。

### 初版测试

23 → **37**（当时，3 个 spec 全过；本次为 61）：预检跳过/失败、清理失败隔离、backfill+事件去重竞态、
in-flight teardown 打断、符号链接发现 ×4、config 边界 ×3、`probeMcpBridge` 单元 ×3。
测试不依赖真实 Xcode（probe seam 默认 true，CI 无 Xcode 亦可全绿）。

### 初版兼容面

临时 worktree 核对 `dsh-v0.2.1-rc.1`（用完已清理）：McpClient stdio Config 全部所用字段
（transport/serverName/command/args/env/cwd/toolCallTimeoutMs/failOnStartupError）存在；
`workingDirectory.ensure(agent, signal?)` 签名一致；`agent/created` serial 语义一致。
rc.1 无 `startupTimeoutMs`（插件自带看门狗正是为此）。运行基准 0.2.2-rc.5 实测：
deepcal 真实链路冒烟 54 个 `mcp__xcode__*` 工具，dispose 后子进程退出。
`engines.dsh >=0.2.1-rc.1 <0.3.0` 不变。