# 兼容性

本文件记录 `@yankeguo/dsh-xcode-mcp` 已验证的 DSH、Node、平台与 Xcode 兼容面。
发行前请以本文件、`package.json` 的 `engines`/`peerDependencies` 和
`docs/AUDIT.md` 的核对记录为准。

## 支持矩阵

| 维度 | 声明/范围 | 验证状态 |
| --- | --- | --- |
| DSH | `>=0.2.1-rc.1 <0.3.0`（`engines.dsh`） | API/类型面已对照 `dsh-v0.2.1-rc.1` 与 `dsh-v0.2.2-rc.5` 两个 tag；运行时基准 `0.2.2-rc.5` |
| Node.js | `>=24.9`（`engines.node`） | committed CI（verify.yml / publish.yml）只 pin Node 24；Node 26 仅本地开发验证，未在 CI 矩阵；**Node 22.19 未验证** |
| cordis peer | `>=4.0.5 <4.2.0` | rc.1 带 4.0.5，rc.5 带 4.1.0 |
| schemastery peer | `>=3.18.5 <3.20.0` | rc.1 带 3.18.5，rc.5 带 3.19.0 |
| macOS | 必需 | 真实环境验证 macOS + Xcode 27.2 |
| Xcode | 26 或更新 | `xcrun --find mcpbridge` 必须成功；使用工具期间 Xcode 需运行 |

## DSH 0.2.1-rc.1：平台字段被忽略

`dsh.bundle.platforms` 是 DSH **0.2.2+** 才读取并强制执行的 manifest 字段。
0.2.1-rc.1 只读取 `dsh.bundle.patch`，因此：

- 在 0.2.1-rc.1 上，`platforms: ["darwin"]` 不会阻止 Linux/Windows 加载该
  bundle，也不会在安装时给出平台错误；
- 插件仍靠挂载前的 `xcrun --find mcpbridge` 探测兜底：在非 macOS 或没有
  Xcode 的 Host 上探针失败，跳过 MCP 挂载与 skills 导出；
- 从 DSH **0.2.2 系列**（0.2.2-rc.5 已验证）起，Host 才会依据该字段在安装/加载时强制 macOS 限制。

因此 `engines.dsh` 仍保留 rc.1；如果未来要在 rc.1 上也强制平台限制，需要
Host 侧支持，而不是改本插件的 `engines.dsh`。

## Node 22.19：未验证

DSH 0.2.1-rc.1 官方支持 Node `^22.19.0 || >=24.0.0`，但本插件的
`engines.node` 是 `>=24.9`。仓库 committed CI（`verify.yml` / `publish.yml`）
只 pin Node 24；Node 26 只在本地开发时跑过，仓库没有 Node 26 CI 矩阵。插件代码
没有刻意使用 24.9 专属 API，但也没有在 Node 22.19 上跑过完整测试，因此：

- 不声明 Node 22 兼容；
- 不为了避免 peer 警告而放宽 `engines.node`；
- 如需在 Node 22 上使用，应先补 Node 22 的 CI/测试矩阵，再调整 engines。

## Xcode 与 MCP

- Xcode 26+ 提供 `xcrun mcpbridge`；Xcode 27.2 实测暴露 54 个工具，3 个并发
  bridge 各自 54 个。
- 首次使用某个 Session 的 Xcode 工具前，必须先调用
  `XcodeOpenWorkspace`（绝对 `.xcodeproj`/`.xcworkspace` 路径）并在 Xcode 中
  批准授权；仅建立 MCP 连接不会触发授权。
- `xcrun agent skills export` 在 Xcode 27.2 上导出 11 个 skill（约 892 KiB）；
  Apple 的 `SKILL.md` 可能使用 `when_to_use`，插件同时接受该拼写与 DSH 的
  `whenToUse`。
- 自定义 `command` 的 basename 是 `xcrun` 时，skills 导出复用该路径；其他
  launcher 会回退到系统 `xcrun`。`config.env` 会同时传给 MCP 与导出，但只有
  xcrun 类 launcher 能保证两者选中同一个 Xcode。

## 已知边界

- 创建时决策：`workingDirectory.set` 不重新评估挂载，旧项目的工具/skills 会
  附着到该 Agent 重建为止。
- 插件激活时若某个 Agent 的 `agent/created` 派发已开始（监听器快照已定），
  仍有极窄的残余竞态；DSH 没有 announcement barrier。
- discovery 没有超时，probe 上限 10s；二者不随 abort 中断，因此卸载/创建可能
  被慢文件系统或 probe 拖住。
- 只识别 `*.xcodeproj`；`.xcworkspace`-only 仓库不会挂载。
- `toolCallTimeoutMs` 未暴露；大构建可在自定义 mcp-client 设置中调整。