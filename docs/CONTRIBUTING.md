# 开发与贡献指南

本文件面向代码贡献者：开发环境、构建与测试、手工验证、仓库结构与文档约定。
使用者文档见根 [README](../README.md)，发布流程见 [PUBLISHING.md](./PUBLISHING.md)，
内部设计见 [DESIGN.md](./DESIGN.md)。

## 环境要求

- macOS + Xcode 26 或更新（只有手工验证需要真实 Xcode；单元测试不需要）。
- Node.js ≥ 24.9；pnpm 12.16.1（与 CI pin 一致，`corepack enable` 或直接安装）。
- 本地 stage 预检（`pnpm release:dry`）需要 npm ≥ 11.15.0（CI 固定 11.20.0），见
  [PUBLISHING.md](./PUBLISHING.md)。

## 初始化与校验

```sh
pnpm install --frozen-lockfile   # 与 CI 一致
pnpm verify       # typecheck + 单元测试 + build，提交前必须全绿
pnpm typecheck    # tsc -p tsconfig.json --noEmit
pnpm test         # vitest run（tests/**/*.spec.ts）
pnpm build        # tsc -p tsconfig.build.json → lib/
pnpm check:packages  # 单包发布不变式（manifest/engines/files/CI/README 契约）
```

`lib/` 被 gitignore，每次发布都现构建；只跑单个测试文件可执行
`pnpm test tests/discovery.spec.ts`。

## 本地安装插件进行手工验证

1. `pnpm build`，确认 `lib/index.js` 与 `lib/index.d.ts` 已生成。
2. 通过 DSH 插件管理器把本仓库目录作为 linked bundle 安装（`install_bundle`
   指向本目录）。
3. 修改源码后重新 `pnpm build`：插件加载的是 `lib/`，不是 `src/`。

## 仓库结构

```
src/index.ts         插件实现：配置、项目发现、bridge probe、MCP 挂载、skills 导出/provider、生命周期
tests/               单元测试（discovery / config / plugin / skills）
cordis.patch.yml     bundle 行（id: xcode-mcp-autoload）
locale/en.json       Plugin Manager 展示元数据（英文）
locale/zh.json       Plugin Manager 展示元数据（中文）
icon.svg             bundle 图标
scripts/             发布与校验工具（stage-release / check-packages / trusted-publishers）
.github/workflows/   verify.yml（CI 校验）与 publish.yml（staged 发布）
docs/                设计、兼容性、发布、审计、开发指南与 release notes
```

## 测试与手工验证清单

单元测试用 vitest，通过 `AutoloaderOptions` 的测试缝替换项目发现、bridge
probe、MCP 挂载与 skills 导出，不依赖真实 Xcode；覆盖配置校验、项目发现、
生命周期/卸载、skills 解析与 provider。

改动行为后，在真实 macOS + Xcode 环境按下面清单手工验证：

1. 安装并启用 bundle。
2. 打开一个**新建** Session，其工作目录（或向上直到 `.git` 根的祖先）包含
   `*.xcodeproj`。
3. 用项目路径调用 `mcp__xcode__XcodeOpenWorkspace` 并在 Xcode 中批准，再调用
   其他 `mcp__xcode__*` 工具（如 `XcodeListSchemes`、`BuildProject`）；工具只应
   出现在该 Session。skill catalog 应列出导出的 Xcode skills（如
   `swiftui-specialist`），可用 `skill` 工具加载。
4. 在没有 Xcode 项目的工作目录新建 Session：不应有 `mcp__xcode__*` 工具，也不应
   有 Xcode skills。
5. 禁用 bundle 或关闭 Agent：确认 `mcpbridge` 子进程退出、Xcode skills 从
   catalog 消失。

## 文档约定

- 根 `README.md` **只面向使用者**：是什么、要求、安装、配置、使用、限制、
  排障/FAQ，加上文档链接。开发环境、构建/测试、仓库结构、发布/CI、兼容性细节、
  审计记录、版本变化与内部架构都放 `docs/`；README 不写版本矩阵、changelog 或
  发布状态。
- `docs/` 文档面向维护者：行为/生命周期变更同步 [DESIGN.md](./DESIGN.md)，兼容面
  变更同步 [COMPATIBILITY.md](./COMPATIBILITY.md)，发布流程变更同步
  [PUBLISHING.md](./PUBLISHING.md)。
- **README 不使用 YAML frontmatter。** npmjs.com 不渲染 frontmatter，会把顶部
  `---` 元数据块当成正文显示。DSH 内部文档规范里的 frontmatter 约定**不适用于
  发布到 npm 的第三方包**；`pnpm check:packages` 会断言 README 没有 frontmatter。
- **README 里的仓库文档/图片链接必须是绝对 GitHub URL**
  （`https://github.com/yankeguo/dsh-xcode-mcp/blob/main/...`；图片用
  `https://raw.githubusercontent.com/yankeguo/dsh-xcode-mcp/main/...`）。npm 包内
  只有 README，仓库相对链接在 npmjs.com 上会失效；`pnpm check:packages` 会断言
  这一点。
- `docs/` 内部互相引用可以使用仓库相对链接（GitHub 上有效）。
- 版本变化写 `docs/releases/v<version>.md`；README 只链接
  [docs/releases](./releases/) 与 GitHub Releases。

## 提交与发布

- 文档改动可直接提交并 push `main`，不需要 bump 版本或打 tag。
- 代码改动提交前保证 `pnpm verify` 与 `pnpm check:packages` 全绿；CI
  （`.github/workflows/verify.yml`）对每次 push/PR 跑同一组检查。
- 发布由维护者按 [PUBLISHING.md](./PUBLISHING.md) 的 staged 流程执行：CI 只
  stage，人工在 npmjs.com approve，再手动创建 GitHub Release。
