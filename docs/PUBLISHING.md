# 发布指南

本仓库是**单包仓库**：根 `package.json` 就是唯一可发布包
`@yankeguo/dsh-xcode-mcp`（一个纯 TS 的 DSH bundle 插件：发现会话工作目录所在的
Xcode 项目后，直接以 `xcrun mcpbridge` 启动 MCP stdio server，无 Python/uv 依赖，
包内不含任何 launcher 脚本）。没有 workspace 依赖，但发布工具链与参考仓库
（dsh-devlead / dsh-infini-goal）保持一致：**pnpm 打包 → npm CLI staged publishing
→ 人工 approve → GitHub Release**。

## 发布模型：CI 只 stage，人工 approve，再出 GitHub Release

发布分为三个明确阶段：

| 阶段 | 执行者 | 认证 | 动作 |
| --- | --- | --- | --- |
| **1. Stage（暂存）** | `.github/workflows/publish.yml`（推 tag 或手动 dispatch） | GitHub Actions OIDC 短时 token（`id-token: write`） | 构建、校验、`npm stage publish` 上传本包的暂存版本。**不发布任何东西。** |
| **2. Approve（批准 = 发布）** | 仓库维护者本地 | `npm login` 登录凭据 + 交互式 2FA OTP | `scripts/promote-release.mjs` 审批 staged 版本；npm 批准后该版本立即公开 |
| **3. Release（GitHub Release）** | 同一个本地脚本 | `gh auth login` | 批准后创建/更新 GitHub Release（幂等，`--verify-tag`） |

这样设计的原因：

- **坏包永不外泄**：版本在 stage 完成并且人工批准之前不会公开。构建坏包、CI 中途
  失败、版本错位都不会让用户装到坏版本。
- **CI 没有发布权**：工作流不持有任何长期 npm token，只有短时 OIDC token；npm 只在
  `npm stage publish` / `npm publish` 时接受 OIDC token，`npm stage list/approve/reject`
  **只能由人类登录执行**（approve/reject 还需要交互式 2FA）。即使工作流被篡改，最多
  也只能 stage 一个未批准版本。
- **可重跑、可审计**：stage 产物带 provenance；审批前的 staged id 打印在 CI job
  summary 里；批准人（actor）能在 `npm stage list` 中看到。

**tag 约定（硬性）**：CI 永不创建、移动或删除 tag；tag 由维护者本地创建并推送。
promote 脚本用 `gh release create|edit --verify-tag`，只使用已存在的远端 tag。

PR / push 到 main 由 [`verify.yml`](../.github/workflows/verify.yml) 跑安装、
typecheck、test、build、`check:packages`；它不碰 registry，也不需要任何凭据。

## 前置条件

- Node.js ≥ 24.9、pnpm `12.16.1`（`corepack enable` 或直接安装）。
- **npm ≥ 11.15.0**：staged publishing（`npm stage` 系列命令与
  `npm trust --allow-stage-publish`）从 11.15.0 开始提供；本仓库 CI 固定并校验
  **11.20.0**（`npm install -g npm@11.20.0`）。本地发布/审批前请安装同一版本
  （用 `npm stage --help` 自检）。
- npm 账号对 `@yankeguo` scope 有写权限；包已声明 `publishConfig.access: public`。
- npm 账号已开启 **2FA**：approve / reject 必须交互式输入一次性密码（OTP）。
- 包必须**已存在于 npm registry**：npm 的 trusted publishing 只对已发布的包生效。
  若包尚未首发，首次发布是一次性手工操作（见下文“新包首次发布”；本仓库的首发
  版本是 `0.1.0-rc.1`，dist-tag `next`）。
- GitHub Actions 运行在 **GitHub-hosted runner**（npm 目前不支持 self-hosted
  runner 的 trusted publishing）。
- 仓库公开（`yankeguo/dsh-xcode-mcp`）：provenance 需要公开仓库 + 公开包。
- 本地 approve/建 Release 需要 `gh` ≥ 2.0 已认证（`gh auth status`）且有仓库权限。

## 一次性配置：npm 信任发布者（只允许 staged publishing）

npm 只接受来自“被信任的 CI 工作流”的 OIDC 发布请求。本包要配置一次，把
**本仓库 + `publish.yml` 工作流** 声明为 trusted publisher，并且**只授予
staged publishing 权限**（`--allow-stage-publish`）。

> **从旧配置迁移（重要）**：用 `--allow-publish` 创建的 trust 配置只允许
> `npm publish`，**不会**授权 `npm stage publish`。如果包上已经有旧配置，CI 会报
> 401/403 或 trust 校验错误。必须先 revoke 旧配置再重建：
>
> ```sh
> npm trust list @yankeguo/dsh-xcode-mcp                 # 找到 GitHub Actions 记录的 id
> npm trust revoke @yankeguo/dsh-xcode-mcp --id=<id>     # 撤销旧的 publish-only 配置
> scripts/trusted-publishers.sh                          # 用 --allow-stage-publish 重建
> ```

### 方式 A：脚本配置（推荐）

```sh
npm login                                 # 确认是 @yankeguo 维护者
npm install -g npm@11.20.0                # 仓库固定 11.20.0；npm stage 自 11.15.0 提供
scripts/trusted-publishers.sh --dry-run   # 先看会做什么
scripts/trusted-publishers.sh             # 配置本包（包名从根 package.json 读取）
scripts/trusted-publishers.sh --list      # 校验结果
```

脚本相当于执行：

```sh
npm trust github @yankeguo/dsh-xcode-mcp \
  --file publish.yml \
  --repo yankeguo/dsh-xcode-mcp \
  --allow-stage-publish \
  --yes
```

- 脚本先用 `npm trust --help` 与 `npm stage --help` 做能力探测（要求 npm ≥ 11.15）；
  `private: true` 的 manifest 会被拒绝（发布形态必须移除 private）；
- 脚本**只会**传 `--allow-stage-publish`，绝不传 `--allow-publish`：直发权限对 CI
  没有用处，stage 权限才是工作流需要的；
- `--file` 必须只是工作流文件名（`publish.yml`），不能带路径，且文件必须位于
  `.github/workflows/` 下（npm trusted publishing 的硬性要求）；
- 若使用 GitHub Environments 做发布审批，加 `--env <环境名>`，并同时在工作流 job
  上写 `environment: <环境名>`，两边必须一致（本仓库默认不使用 environment）；
- 每个包最多 10 个 trusted publisher；已有冲突配置时先 `npm trust list` 找到 id，
  再 `npm trust revoke --id=<id>`，然后重建。

### 方式 B：npmjs.com 网页配置

包的 npmjs.com 页面 → **Settings → Trusted Publisher → GitHub Actions**，填写：

| 字段 | 值 |
| --- | --- |
| Organization or user | `yankeguo` |
| Repository | `dsh-xcode-mcp` |
| Workflow filename | `publish.yml` |
| Environment name | 留空（或与工作流 `environment` 一致） |
| Allowed actions | 勾选 **npm stage publish**（不要依赖旧的 npm publish 配置） |

### 校验

```sh
scripts/trusted-publishers.sh --list
# 或
npm trust list @yankeguo/dsh-xcode-mcp
```

输出应指向 `publish.yml` / `yankeguo/dsh-xcode-mcp`，且授权动作只包含 staged
publishing（不允许旧的 `--allow-publish` 直发记录残留）。

## 新包首次发布（一次性手工操作）

npm 的 trusted publishing 要求包**已经存在**于 registry，因此第一个版本只能人工
发布（此时还没有 trust 配置可匹配，不能用 OIDC）。首发可以是稳定版，也可以是
预发布版；**dist-tag 必须与版本形态匹配**：

- 稳定版（`x.y.z`）：`--tag latest`；
- 预发布版（`x.y.z-rc.N` 等）：`--tag next`，**绝不 latest**。注意 npm 对预发布
  版本**同样默认 latest**，必须显式传 `--tag next`，否则 `npm install <pkg>`
  会解析到预发布版本。

下面以首发 `0.1.0-rc.1`（预发布，dist-tag `next`）为例；稳定版首发只需替换
版本号、并把 `--tag next` 换成 `--tag latest`：

```sh
# 0) 发布形态就绪：package.json 已移除 private、含 publishConfig.access=public、
#    repository/homepage/bugs 与 release:* scripts（pnpm check:packages 全绿）。
pnpm install --frozen-lockfile
pnpm verify                # typecheck + test + build
pnpm check:packages        # 单包发布不变式
pnpm release:dry           # 打包 + npm 预检（不上传；预发布版本自动按 next 预检）

# 1) 写 release notes 并提交推送 main
#    docs/releases/v0.1.0-rc.1.md（promote 的硬性前置条件）
git add -A && git commit -m "release: v0.1.0-rc.1" && git push origin main

# 2) 现构建并打包（lib/ 被 gitignore，必须现构建）
pnpm build
mkdir -p /tmp/dsh-xcode-mcp-first-publish
pnpm pack --pack-destination /tmp/dsh-xcode-mcp-first-publish

# 3) 手工发布 tarball（npm 会提示 2FA OTP）。
#    在中性目录执行，避免 npm 读到仓库里 pnpm 专用的 .npmrc 键。
#    预发布必须 --tag next；稳定版首发才用 --tag latest。
cd /tmp/dsh-xcode-mcp-first-publish
npm login
npm publish ./*.tgz --access public --tag next

# 4) 回到仓库，配置只允许 staged publishing 的 trusted publisher。
#    trust 按包配置（repo + 工作流文件名），与版本/dist-tag 无关，
#    对 rc 与稳定版同样适用，首发后配置一次即可。
cd /Users/guoyk/Workspace/src/dsh-xcode-mcp
scripts/trusted-publishers.sh --dry-run
scripts/trusted-publishers.sh
scripts/trusted-publishers.sh --list

# 5) 打 tag 并推送（tag 只能由人创建；CI 与 promote 都不会创建 tag）
git tag -a v0.1.0-rc.1 -m "v0.1.0-rc.1"
git push origin v0.1.0-rc.1

# 6) 用 promote 幂等地补建首个 GitHub Release：
#    预检发现“0 条 staged 但版本已发布”→ 跳过 approve，只建 Release
#    （--verify-tag；预发布版本自动标记 --prerelease，且不会成为 Latest）
node scripts/promote-release.mjs --version 0.1.0-rc.1
```

> **预期中的一次红色 CI（仅首个版本如此）**：第 5 步推送 tag 会触发
> `publish.yml`，它会完整走完 checkout、tag 校验、安装、typecheck、test、build 与
> check-packages，但**必然在 “Stage the package on npm” 一步失败**：该版本已在
> 第 3 步手工发布，`npm stage publish` 不允许对已发布版本再 stage。这**无害**：
> CI 不会 stage 任何东西，更不会发布。稳定版首发与预发布首发都一样，红色点只在
> stage 步骤；前面的安装/typecheck/test/build/check-packages 全部通过。
>
> 无需处理，**不要移动或重建 tag**。第 6 步的 promote 仍能正确收尾：预检发现
> “0 条 staged 但版本已发布” → 跳过 approve，只创建 GitHub Release（预发布自动
> `--prerelease --latest=false`，且不会成为 Latest）。
>
> **仅首个版本如此**：包存在于 registry 之后，此后每个 rc 与稳定版都走正常的
> **CI stage → 人工 approve** 流程（下节）；rc 由 CI 以 `next` stage，稳定版以
> `latest` stage。

## 发版流程（首发之后）

### 1. 准备干净的 main

```sh
git checkout main
git pull
git status                 # 必须干净
```

### 2. 升级版本并同步 lockfile

单包只需改根 `package.json`（示例 `0.1.1`）：

```sh
export VERSION=0.1.1
node -e '
  const fs = require("node:fs")
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"))
  manifest.version = process.env.VERSION
  fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\n")
  console.log("bumped to", process.env.VERSION)
'
pnpm install                # 同步 lockfile（纯版本号 bump 通常不改变 lockfile 内容；
                            # 依赖规格变化时必须同步，CI 用 --frozen-lockfile 安装）
```

### 3. 写 release notes（promote 的硬性前置条件）

新建 `docs/releases/v<VERSION>.md`（参考 [`v0.1.0-rc.1.md`](releases/v0.1.0-rc.1.md)）。
`scripts/promote-release.mjs` 会用它作为 GitHub Release 正文，**文件不存在或为空时
拒绝批准**（避免包已公开却没有发布说明）。

### 4. 发布前检查

```sh
pnpm install --frozen-lockfile     # 锁文件一致
pnpm verify                        # typecheck + test + build（lib/ 被 gitignore，必须现构建）
pnpm check:packages                # 单包不变式：manifest/engines/files/exports/locale/icon/
                                   #   依赖放置/构建产物/lockfile/CI pin/staged 契约
pnpm release:dry                   # = pnpm build && node scripts/stage-release.mjs --dry-run
                                   #   本地打包 + npm 预检，不上传、不创建 stage id
```

`release:dry` 的本地预检说明：

- 脚本用 `pnpm pack` 把根包打包到系统临时目录，校验 tarball 内 `package.json` 的
  name/version、不含 `workspace:`、关键文件齐全（`lib/index.js`、`lib/index.d.ts`、
  `cordis.patch.yml`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`LICENSE`、
  `README.md`），且 `src/`、`tests/`、`scripts/`、`node_modules/` 不泄漏进 tarball；
- 然后以临时目录为 cwd 调用
  `npm stage publish <tarball> --access public --tag <dist-tag> --dry-run --force --json`
  （dist-tag 默认：稳定版 `latest`，预发布版 `next`）；
- **`--dry-run` 仍会做 registry 的“版本已存在”检查**，所以本地预检加了 `--force`
  跳过该检查（**真实 stage 永远不加 `--force`**）；
- 输出 `DRY RUN OK` 表示打包与 npm CLI 参数校验通过；dry-run 不验证 registry 状态，
  不上传任何内容，也不产生 stage id。

### 5. 触发 CI stage（推荐路径）

```sh
git add -A
git commit -m "release: v0.1.1"
git push origin main
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1                 # 触发 .github/workflows/publish.yml
```

`publish.yml` 的行为：

1. **Checkout 指定 tag**（push：`github.ref`；手动 dispatch：`inputs.release_tag`
   对应的 `refs/tags/<tag>`，`fetch-depth: 0` 取全量历史与 tag）。
2. **Resolve and verify the release tag**：`git fetch --tags`，确认
   `refs/tags/<tag>` 指向的 commit 与当前 `HEAD` 一致，并从 tag 推导版本号；
   不一致直接失败（**CI 不会创建、移动或删除 tag**）。同时按版本推导 dist-tag：
   稳定版 `latest`，prerelease（版本号带 `-rc`/`-alpha` 等后缀）`next`，写入
   `RELEASE_DIST_TAG`——**打 tag 并推送即可触发任一类型的 stage**。这一步在
   安装依赖之前执行，坏 tag 数秒内失败。
3. 安装 pnpm `12.16.1`、Node `24`，并显式安装/校验 **npm 11.20.0**
   （`npm stage --help` 能力探测）。
4. **tag-version 门禁**：`v<version>` 必须与根 `package.json` 的 `version` 完全一致
   （包名也必须是 `@yankeguo/dsh-xcode-mcp`）。
5. `pnpm install --frozen-lockfile` → typecheck → test → build →
   `node scripts/check-packages.mjs`。
6. **Stage**：`node scripts/stage-release.mjs --version "$RELEASE_VERSION" --dist-tag "$RELEASE_DIST_TAG"`
   （稳定版 `latest`，prerelease `next`）。打印真实 stage id 并写入 job summary；
   失败时停止并打印修复提示。
7. **Release summary**：仅在 stage 成功后写入下一步人工审批命令。

工作流权限（已声明）：

```yaml
permissions:
  contents: read      # GitHub Release 由本地 promote 脚本创建，CI 不需要写权限
  id-token: write     # OIDC：npm CLI 换取短时 token（仅能 stage）
```

第三方 action 使用与 `verify.yml` 相同的精确版本（`actions/checkout@v7.0.1`、
`pnpm/action-setup@v6.1.1`、`actions/setup-node@v7.1.0`），
`scripts/check-packages.mjs` 会校验两个工作流 pin 完全一致、pnpm/node/npm 版本、
`id-token: write` 与 `verify.yml` 的只读权限。

**手动 dispatch（补发/重跑）**：Actions → `publish` → Run workflow，`release_tag`
必须填**已存在**的 tag（例如 `v0.1.1`）。工作流只认既有 tag；**不要删除、重建或
移动 tag**。dispatch 与 tag push 共用并发组 `publish`（`cancel-in-progress: false`），
不会交错 stage。

### 6. 人工批准（本地，2FA）

维护者在本机执行：

```sh
npm login                                  # 确认是 @yankeguo 维护者，账号已开 2FA
npm install -g npm@11.20.0                 # 若尚未安装（仓库固定 11.20.0）

node scripts/promote-release.mjs --dry-run # 预检 + 打印计划，不做任何变更
node scripts/promote-release.mjs           # approve（npm 会提示输入 OTP），然后建 GitHub Release
```

`promote-release.mjs` 的两阶段行为：

**阶段 A：只读预检**（任一失败都不会批准）

- 验证 `package.json` 版本与 `--version` 一致、npm 已登录、npm 支持 `npm stage`；
- 若版本是 prerelease 且传了 `--tag latest`，在**任何 registry 读取/npm 登录检查
  之前**直接失败（`--dry-run` 同样生效）：approve 会按 stage 时记录的 dist-tag
  公开，prerelease 一旦挂 latest 就成了默认安装；
- 执行 `npm stage list @yankeguo/dsh-xcode-mcp --json`，过滤出
  `packageName` 与 `version` 都匹配的记录：
  - **恰好 1 条**：批准它；
  - **0 条但该版本已发布**：视为已完成（重跑/断点续传/手工首发幂等），跳过；
  - **0 条且未发布**：先对 `npm view` 做有限次重试（最多 4 次、间隔约 1.5s）再判定
    —— 刚 approve 的版本可能还没出现在读路径里，避免把“已发布但尚未传播”误判为
    缺失；仍不存在才失败，提示先跑发布工作流；
  - **多于 1 条**：失败并列出全部 staged id（必须人工决定 reject 哪一条）；
- 若版本是 prerelease 且匹配到的 staged 记录 `tag` 为 `latest`（记录没有 `tag`
  时按 npm 默认的 `latest` 处理），在 approve 之前**直接失败**，并打印
  `npm stage reject <stage-id>` 与
  `node scripts/stage-release.mjs --version <version> --dist-tag next` 的修复命令；
- 预检还会校验 staged 记录的 `tag` 与 `--tag` 一致（记录带 `tag` 时）：不一致则
  在 approve 之前失败，并打印 `npm stage reject <stage-id>` 与
  `node scripts/stage-release.mjs --version <version> --dist-tag <distTag>` 的修复
  命令；记录不带 `tag` 时对稳定版放行（npm 默认 `latest` 可能省略该字段），对
  prerelease 仍按 `latest` 拒绝（见上一条）；
- 验证 `gh` 已认证、有仓库权限、`gh release view` 可查（结果缓存给阶段 B 使用）；
- 验证 release tag **已在远端存在**（`gh api repos/<repo>/git/ref/tags/<tag>`，
  本脚本不会创建 tag），验证 release notes 文件存在且非空；
- 打印 approve 计划与 GitHub Release 动作。

**阶段 B：批准 + Release**

- 执行 `npm stage approve <stage-id>`，stdio 继承，npm 自己提示并读取 OTP；
- 批准后**立即公开**；中途失败会停止并打印：是否已公开、仍处于 staged 的 id、
  `npm stage reject <id>` 清理提示、以及重跑命令；
- 如果版本是 prerelease 且本次**确实 approve 了至少一个包**，在创建 GitHub Release
  之前执行 `npm view @yankeguo/dsh-xcode-mcp dist-tags --json`，断言
  `dist-tags.latest !== <version>`；若 latest 指向该 rc，立即失败并提示包已公开，
  给出 `npm dist-tag add @yankeguo/dsh-xcode-mcp@<stable-version> latest` 修复命令。
  0 条 staged、版本已发布的幂等重跑（没有 approve 任何包）会跳过该检查；
- 批准后按阶段 A 缓存的 release 存在性执行 `gh release create|edit <tag>
  --repo <repo> --title <tag> --notes-file docs/releases/v<version>.md --verify-tag`
  （幂等；`--verify-tag` 保证只使用已存在的 tag）。

脚本参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--version <x.y.z>` | 根 `package.json` 版本 | 要批准的发布版本 |
| `--release-tag <tag>` | `v<version>` | GitHub Release tag；必须已存在，脚本绝不创建/移动 tag |
| `--tag <dist-tag>` | prerelease 为 `next`，稳定版为 `latest` | 期望的 npm dist-tag；staged 记录的 tag 必须一致（记录带 tag 时）；prerelease + `latest` 在任何 registry 读取前直接失败 |
| `--repo <owner/repo>` | 从 origin remote 推导；无 GitHub origin 时回退 `yankeguo/dsh-xcode-mcp` | GitHub 仓库 |
| `--notes-file <path>` | `docs/releases/v<version>.md` | Release 正文文件（相对路径从仓库根解析） |
| `--dry-run` | 关闭 | 完整只读预检 + 打印计划，不批准、不创建 Release；prerelease×latest 在联网前失败 |
| `--list-only` | 关闭 | 只打印 staged 状态（临时排障/清理用），不检查 gh/notes、不变更 |

### 7. 发布后校验

```sh
npm view @yankeguo/dsh-xcode-mcp@0.1.1 version dist-tags
gh release view v0.1.1 --repo yankeguo/dsh-xcode-mcp
```

npmjs.com 上应显示 **provenance / attestation**（公开仓库 + GitHub-hosted runner
自动生成）。

在 DSH 中安装验证（前提：macOS + Xcode 26+，`xcrun mcpbridge` 可用）：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-xcode-mcp@0.1.1
```

刷新 Web 页面，开一个工作目录位于 Xcode 项目内的**新**会话，确认出现
`mcp__xcode__*` 工具；再开一个不在 Xcode 项目内的会话，确认没有这些工具。

## 版本与 dist-tag 策略

- 稳定版：默认 `latest`。CI 按版本推导并以 `--dist-tag latest` stage；promote 批准后
  即成为 `latest` 对应的已发布版本。
- 试验版/预发布：**打 prerelease tag 并推送即可**——CI 自动以 `next` dist-tag stage
  （稳定版才用 `latest`），其余流程与稳定版完全一致（人工 approve + GitHub Release
  自动标 prerelease）：
  ```sh
  git tag -a v0.2.0-rc.1 -m "v0.2.0-rc.1"
  git push origin v0.2.0-rc.1                 # CI 以 next stage 本包
  npm login
  node scripts/promote-release.mjs --version 0.2.0-rc.1   # approve（2FA）+ prerelease Release
  ```
  本地 stage 仍可作为 fallback（`node scripts/stage-release.mjs --version 0.2.0-rc.1
  --dist-tag next`，无 provenance），例如 CI 不可用或需要紧急重试时。CI 按版本推导
  dist-tag（稳定版 `latest`、prerelease `next`）是正常流程，**不属于**下面的防误发
  闸门。三道防误发闸门：
  1. `stage-release.mjs` 对 prerelease 版本**默认 `next`**（`--dist-tag` 可省略），并
     **拒绝显式 `--dist-tag latest`**——approve 会按 stage 时记录的 dist-tag 公开，
     prerelease 一旦挂 latest 就成了默认安装；
  2. `promote-release.mjs` 预检**拒绝 approve 任何以 latest stage 的 prerelease
     记录**（`--tag latest` 搭配 prerelease 甚至会在任何 registry 读取之前直接
     失败），并在 approve 后核对 `dist-tags.latest` 不指向该 prerelease；
  3. GitHub Release 自动按版本标记：prerelease → `--prerelease --latest=false`，稳定版
     → `--prerelease=false`（edit 时纠正旧标记），都带 `--verify-tag`；promote 不修改
     stage 时记录的 dist-tag。
  手工 `npm publish` tarball（仅首发）时没有这层保护，必须自己显式传 `--tag next`。
  prerelease 的 tag（`v0.2.0-rc.1`）推送到远端即触发 CI stage，也供 Release 的
  `--verify-tag` 使用。用户安装时需要显式指定版本（DSH 插件市场按版本安装，不受
  dist-tag 影响）。
- `engines.dsh` 当前为 `>=0.2.1-rc.1 <0.3.0`（实测基准 `0.2.2-rc.5`）；DSH 升级到
  0.3 时需更新该范围并回归。`check-packages.mjs` 会校验该范围不被无意改动。
- 破坏性变更遵循 semver；预发布版本使用 `-rc.N` / `-alpha.N` 后缀。
- 每次发版前同步 README 与 `docs/releases/v<version>.md`，并确认根 `package.json`
  的 `version` 已 bump、lockfile 已同步。

## 脚本参考

### `scripts/stage-release.mjs`（CI / 本地 stage）

打包并 stage 根包；不发布任何内容。

| 参数 / 环境变量 | 说明 |
| --- | --- |
| `--version <x.y.z>` | 期望版本；默认根 `package.json` 版本，必须一致，否则失败 |
| `--dist-tag <tag>` | npm dist-tag；默认稳定版 `latest`、预发布版 `next`；预发布版本显式传 `latest` 会被拒绝；不允许写成版本号 |
| `--dry-run` | 打包 + `npm stage publish --dry-run --force` 预检，不上传、不创建 stage id |
| `--no-provenance` | 即使在 GitHub Actions 中也不传 `--provenance` |
| `GITHUB_ACTIONS=true` | 传 `--provenance`（npm 也会对公开包自动启用 provenance） |
| `GITHUB_STEP_SUMMARY` | 设置时把 staged 版本表写进 Actions job summary |

脚本会断言：包名/版本正确、manifest 非 private、`lib/index.js` 与 `lib/index.d.ts`
已现构建、tarball 的 manifest 版本正确、tarball 内不含 `workspace:`、关键发布文件
齐全、源码/测试/发布脚本不泄漏。失败即停止，打印真实 stage id（如有）与修复提示
（**不打印假的 stage id**；只有 npm 真实返回的 stage id 才会被记录）。临时 tarball
目录在结束时删除，不污染仓库。

### `scripts/promote-release.mjs`（维护者本地 approve + Release）

参数见上文“人工批准”一节。要点：

- 预检要求**恰好一条**匹配 staged 记录；已发布视为幂等完成（`npm view` 未命中时会
  做有限次 registry 传播重试）；重试后仍缺失才失败；
- 预检校验 staged 记录的 `tag` 与 `--tag` 一致（记录带 tag 时），并拒绝 prerelease
  以 `latest` stage 的记录（`--tag latest` 搭配 prerelease 会在任何 registry 读取
  前直接失败）；approve 后对 prerelease 执行 `npm view <pkg> dist-tags --json`，
  断言 `latest` 不指向该版本；
- approve 由 npm 交互式读取 OTP；失败时给出已公开状态、剩余 staged id、
  `npm stage reject` 与重跑指引；
- GitHub Release 幂等创建/更新，`--verify-tag` 保证不新建 tag；本地 HEAD 与 tag
  不一致时只警告（promote 读取 registry 与 notes 文件，不依赖本地构建产物）；
- prerelease 版本（`-rc.N` 等）的 GitHub Release 自动标记 `--prerelease`
  （create 时同时 `--latest=false`）；稳定版 edit 时显式 `--prerelease=false`，
  幂等重跑不会残留错误的 prerelease 标记。npm dist-tag 本身在 stage/publish
  时已记录，promote 不改 dist-tag。

### `scripts/trusted-publishers.sh`（一次性 trust 配置）

单包版：包名从根 `package.json` 读取；`--dry-run` / `--list` / `--repo` / `--file` /
`--env` 可用；只授予 `--allow-stage-publish`。

### `scripts/check-packages.mjs`（单包不变式校验）

只读、无第三方依赖，CI 在 build 之后运行。覆盖：manifest 身份与发布形态
（name/semver/非 private/`publishConfig.access`/repository/homepage/bugs）、
engines（`dsh` 精确范围、`node` 存在）、files/exports 接线、DSH bundle 契约
（`dsh.bundle.patch` → 存在的 `cordis.patch.yml`、icon ≤ 256 KiB、
`locale/en.json` + `locale/zh.json` 的 `meta.title`/`meta.description` 非空且无
营销最高级）、DSH 依赖放置（host 包必须是 peer、DSH peer 是范围而非精确 rc pin、
每个 peer 都装为 devDependency）、构建产物、lockfile 一致性（仅根 importer、
依赖规格双向核对）、CI 工作流 pin 与 staged-publishing 契约。输出逐项
PASS/FAIL 清单，任一失败以非零码退出。

### 根 `package.json` scripts

| script | 等价命令 | 用途 |
| --- | --- | --- |
| `pnpm check:packages` | `node scripts/check-packages.mjs` | 单包发布不变式 |
| `pnpm release:dry` | `pnpm build && node scripts/stage-release.mjs --dry-run` | 本地打包 + npm 预检（不上传） |
| `pnpm release:stage` | `pnpm build && node scripts/stage-release.mjs` | 本地 stage（需 `npm login`；CI 不需要它） |
| `pnpm release:promote` | `node scripts/promote-release.mjs` | 人工批准 + GitHub Release |

`pnpm verify` 保持 typecheck + test + build；`check:packages` 独立成脚本，
`verify.yml` 与 `publish.yml` 都会在 build 后运行它。不存在任何直发脚本
（`release:publish` 被 check-packages 明确禁止）。

## 故障恢复

### CI stage 失败

1. `stage-release.mjs` 会在失败处停止并打印修复提示；若 npm 已返回 stage id，
   job summary 也会保留一张表；此时**没有任何版本公开**。
2. 修复失败原因（常见：trusted publisher 仍是旧的 `--allow-publish` 配置、
   npm 版本不对、网络、版本已发布）。
3. **推荐恢复方式**：先把这次失败留下的 staged 记录 reject，再从干净状态重跑 CI：
   ```sh
   npm login
   npm stage list @yankeguo/dsh-xcode-mcp --json   # 找出本次失败运行的 staged id
   npm stage reject <stage-id>                     # 不可恢复，谨慎
   ```
   然后 Actions → `publish` → Run workflow → `release_tag` 填**同一个既有 tag**。
   CI 会重新 stage，provenance 也重新生成。
4. 如果上一次运行其实**已经 stage 成功**，不要重跑 stage：直接用
   `node scripts/promote-release.mjs` 完成发布。

> 为什么不能“只补 stage 一次”？重复 stage 同一版本的结果没有保证（可能被 registry
> 拒绝，也可能留下多条同版本 staged 记录）。因此“先 reject 本次残留记录、再用同一
> 既有 tag 全量重跑”是最干净、可预测的恢复路径。

### promote 中途失败

- 已 approve 的版本**已经公开**，无法撤销（见“误发版本”）。`promote-release.mjs`
  重跑是幂等的：已发布版本会被跳过（`npm view` 暂时查不到时会有限次等待 registry
  传播）—— 修复原因后直接重跑同一条命令即可。
- 如果失败发生在最后的 GitHub Release 步骤：包已公开，只需修好 `gh` 认证/网络后
  重跑 promote（会走 `gh release edit/create --verify-tag`），不会重复发布。
- 预检报 “prerelease ... was staged with the latest dist-tag”：先按提示
  `npm stage reject <stage-id>`，再 `node scripts/stage-release.mjs --version
  <version> --dist-tag next` 重新 stage（或通过 workflow_dispatch 指定同一个既有
  release_tag 重跑 CI；CI 按版本自动用 next 重新 stage）；
  **不要**在这种记录上 approve。
- approve 之后报 “the latest dist-tag points at prerelease ...”：包**已经公开**；
  立即 `npm dist-tag add @yankeguo/dsh-xcode-mcp@<stable-version> latest` 把 latest
  指回稳定版，再重跑 `node scripts/promote-release.mjs --version <version>` 完成
  GitHub Release（幂等重跑会跳过 approve 与 latest 检查）。

### 其它典型情况

| 现象 | 处理 |
| --- | --- |
| 出现**多条** matched staged 记录 | 先 `npm stage view <id> --json` 看 createdAt/shasum，再 `npm stage reject <id>` 清掉多余记录；每次运行只保留一条 |
| staged 了**错误 commit** 的版本 | reject 该版本的全部 staged id，确认 tag/commit 后再 dispatch 同一 tag（不会移动 tag） |
| CI 重跑报“版本已 staged / 已发布”或出现重复 staged 记录 | 先 `npm stage list @yankeguo/dsh-xcode-mcp --json` 核对：已 stage → 直接 promote；有残留 → reject 后从同一既有 tag 全量重跑 |
| 版本已经发布 | 不能再次 stage/publish 同版本；升版本重新发版（72 小时内可 `npm unpublish`，见下） |
| 想用 workflow_dispatch 重跑 | `release_tag` 必须是已存在的 tag；工作流校验 tag commit == HEAD。**不要删除/重建/移动 tag** |
| tag 不存在 | `git push origin <tag>` 推送既有 tag；本工作流与 promote 脚本都不会创建 tag |
| 误发版本 | npm 允许 72 小时内 `npm unpublish @yankeguo/dsh-xcode-mcp@<version>`；超过则只能 `npm deprecate` 并升版本 |

### 首次 CI 运行的验证清单

- [ ] `scripts/trusted-publishers.sh --list` 显示本包已配置 `publish.yml` /
      `yankeguo/dsh-xcode-mcp`，且授权动作为 staged publishing（没有旧的
      `--allow-publish` 配置残留）
- [ ] 本地 `npm --version` ≥ 11.15.0（建议与 CI 一致的 11.20.0）；CI 日志出现
      “npm 11.20.0 supports staged publishing”
- [ ] tag 已 push，且 CI 的 “Resolve and verify the release tag” 通过
      （tag commit == HEAD）
- [ ] “Verify the release tag matches the package version” 通过（tag 与根版本一致）
- [ ] “Stage the package on npm (publishes nothing)” 打印 1 个 stage id；
      job summary 有 staged 表
- [ ] 此时 `npm view @yankeguo/dsh-xcode-mcp@<version>` **仍应 404**（还没有公开），
      `npm stage list @yankeguo/dsh-xcode-mcp --json` 恰好一条记录
- [ ] 本地 `node scripts/promote-release.mjs --dry-run` 计划正确
      （1 个 approve + 1 个 Release）
- [ ] approve 后 `npm view @yankeguo/dsh-xcode-mcp@<version> version dist-tags`
      正常，npmjs.com 显示 provenance
- [ ] `gh release view v<version> --repo yankeguo/dsh-xcode-mcp` 指向同一 tag 与 commit
- [ ] 仓库 secrets 中没有 `NPM_TOKEN`（本模型不需要任何 npm secret）

## 安全说明与 provenance

1. 工作流声明 `permissions: id-token: write` 后，GitHub Actions 通过
   `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` 暴露 OIDC
   ID token 获取端点（每个 job/每次运行都是新的短时 token）。
2. npm CLI（不是 pnpm）检测到该环境后，请求受众为 `npm:registry.npmjs.org` 的
   ID token，向 registry 的 `/-/npm/v1/oidc/token/exchange/package/<pkg>` 换取
   **一次性的 stage token**；也可通过 `NPM_ID_TOKEN` 传入。
3. npm 侧校验 OIDC claims（仓库、工作流文件名、可选 environment）与包的 trusted
   publisher 配置一致，并且配置允许 staged publishing，然后接受 stage 请求。
4. token 短时且绑定具体工作流；CI 不能 list/approve/reject（这些需要人类登录，
   approve/reject 还需要交互式 2FA）。
5. provenance 由 npm CLI 在 OIDC token 交换成功后生成（Sigstore）：需要公开仓库 +
   公开包；CI 中 `stage-release.mjs` 显式传 `--provenance`，npm 也会对公开包自动
   启用。本地 stage（`npm login` 凭据）不产生 provenance；如不需要可加
   `--no-provenance`。
6. stage 记录与 provenance 均可在 npmjs.com / registry 审计；GitHub Release 的
   tag 固定指向 CI 构建的 commit。

> pnpm 版本要求：本仓库 CI 固定 `pnpm@12.16.1`，但 staged publishing / OIDC /
> provenance 全部由 **npm CLI** 完成；CI 因此显式安装并固定 `npm@11.20.0`。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| CI 报 401/403 / `no trust evidence` / trust 校验错误 | trusted publisher 配置与本次运行不匹配，或配置是旧的 `--allow-publish`（不允许 stage）。核对 repo、**工作流文件名**、environment；必要时 `npm trust list` → `npm trust revoke --id` → `scripts/trusted-publishers.sh` 重建 |
| CI 报 `ENEEDAUTH`（stage 阶段） | 工作流缺少 `id-token: write`，或本包还没有匹配的 trusted publisher（先手动首次发布再配置） |
| CI 报 `npm stage` 不存在 | runner 上的 npm < 11.15.0（工作流已显式安装并校验 11.20.0）；若仍失败检查 npm 安装步骤日志 |
| `npm stage list` 报 401/ENEEDAUTH | 本地未 `npm login`，或登录凭据不可用于该操作；list 需要人类登录，approve/reject 还需要交互式 2FA；OIDC token 无效 |
| approve 报 `EOTP` / OTP 错误 | OTP 输错或过期；重跑 `node scripts/promote-release.mjs` 重新输入。也可手工 `npm stage approve <id>` 后重跑 promote（会跳过已批准项） |
| promote 报 “no staged version and no published version” | CI 未运行或 stage 失败；先跑发布工作流（tag push 或 dispatch 既有 tag），看到 stage id 后再 promote |
| promote 报 “has N staged records” | 同一版本存在多条 staged 记录：`npm stage view <id> --json` 比较，`npm stage reject` 清掉旧记录后重试 |
| promote 报 “prerelease ... was staged with the latest dist-tag” / `--tag latest` 搭配 rc 直接失败 | 该 rc 的 staged 记录以 latest 暂存。按提示 `npm stage reject <stage-id>`，再 `node scripts/stage-release.mjs --version <version> --dist-tag next` 重新 stage；或通过 workflow_dispatch 指定同一个既有 release_tag 重跑 CI（CI 按版本自动用 next）。不要在 latest 记录上 approve |
| approve 后发现 `dist-tags.latest` 指向 rc | 包已公开；立即 `npm dist-tag add @yankeguo/dsh-xcode-mcp@<stable-version> latest` 把 latest 指回稳定版，再重跑 `node scripts/promote-release.mjs --version <version>` 完成 GitHub Release |
| `Cannot publish over the previously published versions` | 该版本已发布，不能覆盖；升版本后再发。**首个版本**手工发布后，推送其 tag 触发的 CI 也会在 stage 步骤报此错误：这是首发的一次性预期现象（仅首个版本如此，见“新包首次发布”），不要移动 tag |
| promote 报 `release tag ... does not exist` | 先把既有 tag push 到 origin；promote 与 CI 都不会创建/移动 tag |
| promote 报 notes 文件不存在/为空 | 先写 `docs/releases/v<version>.md`，或用 `--notes-file` 指定 |
| GitHub Release 创建失败 | 包已公开；修好 `gh auth`/网络后重跑 promote，或手工 `gh release create <tag> --verify-tag --title <tag> --notes-file <file>` |
| provenance 未生成 | 仓库非公开、runner 非 GitHub-hosted、或本地 stage（本地不生成）；公开仓库 + hosted runner 会在 CI 中生成 |
| 想改用新工作流文件名/环境 | 先 `npm trust list` + `npm trust revoke --id`，再用 `scripts/trusted-publishers.sh` 重建 |
| 误发版本 | npm 允许 72 小时内 `npm unpublish`；超过则只能废弃（deprecate）并升版本 |

## 发布后的用户安装方式

```sh
# CLI（稳定版发布后；省略版本时 npm 解析 latest）
dsh plugin --profile desktop add @yankeguo/dsh-xcode-mcp

# 或在 Web：Plugins → Add plugin → 输入 @yankeguo/dsh-xcode-mcp
```

> 只有预发布版本（如首发 `0.1.0-rc.1`，dist-tag `next`）时**没有 `latest`
> 可用**，必须显式指定版本：
> `dsh plugin --profile desktop add @yankeguo/dsh-xcode-mcp@0.1.0-rc.1`。

运行前提：**macOS + Xcode 26 或更新**（`xcrun mcpbridge` 可用，`xcode-select`
指向该 Xcode），使用工具期间 Xcode 处于运行状态。本插件是纯 TS 实现：发现
Xcode 项目根后直接以 `xcrun mcpbridge` 启动 MCP stdio server，**不需要
Python/uv，也不需要在包外准备任何 launcher 脚本**。

默认配置（`serverName: xcode`、`command: xcrun`、`args: ["mcpbridge"]`、
`env: {}`、`startupTimeoutMs: 30000`，cwd 为发现的项目根）通常无需改动；
确有需要时可通过 profile patch 中 bundle 行的 `config` 覆盖：

```yaml
- id: xcode-mcp-autoload
  name: '@yankeguo/dsh-xcode-mcp'
  config:
    serverName: xcode
    command: xcrun
    args:
      - mcpbridge
    env: {}
    startupTimeoutMs: 30000
```

## 插件展示元数据（`locale/*.json`）

DSH 插件管理器与插件市场显示的是**用户友好标题与一句话描述**，而不是 npm 包名和
技术性 `description`。DSH 的 `readPluginMeta` 在**不执行插件代码**的前提下读取：

1. `@yankeguo/dsh-xcode-mcp/locale/en.json`（必须能通过 Node ESM `exports` 解析）；
2. 同目录其它 `<语言>.json` 作为翻译（语言 ID 取文件名小写，例如 `zh.json`）；
3. 字段缺失时回落到 `package.json` 的 `name` / `description`；manifest `icon`
   字段提供图标（相对路径、位于包目录内、≤ 256 KiB、SVG/PNG/JPEG/WebP）。

本包的展示标题：**Xcode MCP autoload**（中文：**Xcode MCP 自动挂载**）。
接线方式（已由 `pnpm check:packages` 强制）：

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "LICENSE"]
}
```

约束：`locale/en.json` + `locale/zh.json` 同时具备；`meta.title`、
`meta.description` 均为非空字符串，中英文语义一致；描述是一句准确的功能说明，
**不使用营销词 / 最高级**（check-packages 内置禁用词表）；`icon.svg` ≤ 256 KiB。

发布后验证展示效果：安装插件 → 刷新 Web 页面 → **Plugins / 插件**：应显示
**Xcode MCP autoload**（中文界面为 **Xcode MCP 自动挂载**）与一句话描述、icon。

## 参考

- npm staged publishing：[npm stage](https://docs.npmjs.com/cli/v11/commands/npm-stage)、`npm help stage`
- npm 文档：[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- `npm trust` 命令：`npm help trust` / [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- pnpm：[pnpm pack](https://pnpm.io/cli/pack)
- OpenSSF [Trusted Publishers](https://repos.openssf.org/trusted-publishers) 标准
