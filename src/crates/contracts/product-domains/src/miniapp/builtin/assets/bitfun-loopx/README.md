# bitfun-loopx（内置 MiniApp）

内置版 **bitfun-loopx**：粘贴 GitHub Issue 链接，由 OpenBitFun 宿主 Agent 驱动本机
LoopX 引擎持续修复，心跳调度、人工审批、中途插话。

本目录就是该内置 MiniApp 的**唯一权威源码**，不依赖任何外部仓库快照。五件套
`index.html` / `style.css` / `ui.js` / `worker.js` / `esm_dependencies.json` 由
`src/crates/contracts/product-domains/src/miniapp/builtin.rs` 的 `BUILTIN_APPS`
以 `include_str!` 嵌入二进制，注册 id 为 `builtin-bitfun-loopx`（同文件契约测试
含 id 顺序断言）；`meta.json` 的权限与注册条目保持一致。

## 高效修改流程

### 先判断改动属于哪一层

| 修改文件 | 改动类型 | 开发期最小动作 | 何时需要 Desktop 编译 |
|---|---|---|---|
| `index.html` / `style.css` | MiniApp 结构、布局、样式 | 集中完成一批修改，不跑 Rust 检查 | 真机验证前编译一次 |
| `ui.js` | MiniApp 交互和宿主桥调用 | `node --check <本目录>/ui.js` | 真机验证前编译一次 |
| `worker.js` | 兼容占位（必须保持无业务逻辑） | `node --check <本目录>/worker.js` | 不单独启动 Worker |
| `meta.json` | 权限、版本、运行方式 | 检查 JSON 和权限差异 | 必须编译并 reseed |
| `esm_dependencies.json` | 浏览器 ESM 依赖 | 检查 JSON；确认 import map | 必须编译并 reseed |
| `src/crates/contracts/product-domains/src/miniapp/loopx/**` | LoopX DTO、状态、端口、纯策略 | 集中完成修改，不跑 Cargo 预检查 | 联调前单次编译 binary |
| `src/crates/services/services-integrations/src/miniapp/loopx_*.rs` | GitHub、Git workspace、CLI 等宿主服务 | 集中完成修改，不跑 Cargo 预检查 | 联调前单次编译 binary |
| `src/crates/assembly/core/src/miniapp/loopx/**` | controller、Agent 编排、持久状态 | 集中完成修改，不跑 Cargo 预检查 | 联调前单次编译 binary |
| `scripts/build-loopx.mjs` 或 LoopX pin | 随包 sidecar | `pnpm run build:loopx` | 只在 sidecar/pin 变化时 |

这里的 `<本目录>` 是：

```text
src/crates/contracts/product-domains/src/miniapp/builtin/assets/bitfun-loopx
```

### 纯 UI 快速循环

内置 MiniApp 资源由 `include_str!` 嵌入 Desktop 二进制。当前没有一个既能热替换
source、又能继续通过受信任 built-in 校验的免编译入口。因此正确的快速循环是
“多次编辑，一次编译”，而不是每保存一次就启动 Desktop 构建。

1. 保持 Web UI Vite 常驻；没有运行时才启动：

   ```bash
   pnpm --dir src/web-ui dev
   ```

2. 连续修改 `index.html`、`style.css`、`ui.js`，先把一轮视觉交互做完整。
3. JS 变化只做秒级语法检查：

   ```bash
   node --check src/crates/contracts/product-domains/src/miniapp/builtin/assets/bitfun-loopx/ui.js
   ```

4. 需要在真实 MiniApp bridge 中验收时，停止正在运行的 `openbitfun-desktop`，只构建
   一次 Desktop executable（配方见下方「统一构建配方」，不要换用别的环境变量）：

   ```bash
   cargo build -p openbitfun-desktop --bin openbitfun-desktop
   ```

5. 保持 Vite 不退出，直接启动刚生成的 executable：

   ```text
   target/debug/openbitfun-desktop.exe
   ```

   > Debug 构建直接启动时**默认使用隔离 dev 数据根**
   > `%APPDATA%/com.openbitfun.desktop.dev/openbitfun`(与 `scripts/dev.cjs` 一致)，与安装
   > 版互不可见，跨构建 schema 冲突从结构上不可能；需要显式覆盖时设置
   > `OPENBITFUN_USER_ROOT`。Release 构建仍使用默认根 `%APPDATA%/openbitfun/`。

6. 新二进制启动后会根据 built-in 内容哈希自动 reseed，并重新生成
   `compiled.html`。此时再进入 LoopX MiniApp 验收。

快速循环中不要使用 `pnpm run desktop:dev` 反复启停。该入口会执行资源准备、
Cargo watch 和 target GC；在 Windows 上可能导致本来可增量的 UI 修改退化为大范围
冷编译。它适合需要持续修改 Desktop Rust 的完整开发会话，不适合只调 MiniApp CSS。

### 为什么不能直接改 AppData

不要把下面的运行目录当成源码：

```text
%APPDATA%/openbitfun/data/miniapps/builtin-bitfun-loopx/source/**
%APPDATA%/openbitfun/data/miniapps/builtin-bitfun-loopx/compiled.html
```

- `compiled.html` 是生成物，刷新、recompile 或重启后会被覆盖；
- `source/**` 必须与二进制内嵌的 built-in source 一致；直接修改会使
  `builtin_source_matches` 失败，受信任的 LoopX controller bridge 将被禁用；
- `miniapp_sync_from_fs` 适用于普通 MiniApp 或明确的本地定制流程，不能作为受信任
  built-in LoopX 的临时热补丁；
- 只改运行目录会造成“代码已经改了，但界面仍旧”或“界面变了，但 bridge 不可用”。

唯一权威源码始终是本 README 所在目录。

### 宿主行为修改

GitHub 认证/限流、Git workspace、环境预检、Agent 会话、任务恢复和持久状态不是
纯 MiniApp UI。这些改动需要修改对应 Rust owner。快速真机反馈不跑前置
`cargo check`；最终 binary build 会完成同一份 Rust 编译验证并直接产生可试用结果。
不要同时运行多个 Cargo 命令，也不要在 `desktop:dev` 正在自动编译时再手动启动
Cargo；它们会争用同一个 target 锁。

完成所有宿主改动后再执行一次：

```bash
cargo build -p openbitfun-desktop --bin openbitfun-desktop
```

### 统一构建配方（重要）

`openbitfun-desktop` 的默认 features 为空，`--no-default-features` 没有实际差异。增量
指纹的权威来源是仓库 `[profile.dev]` 基线：`Cargo.toml` 固定
`debug = "line-tables-only"`，dev profile 默认 `incremental=true`、
`codegen-units=256`。**任何 `CARGO_PROFILE_DEV_*` 覆盖都会改变指纹并触发整棵
依赖树重编**（2026-09-03 实测：裸 `cargo run` 与旧 `DEBUG=0` 配方互踩，同一天内
连续两次全量冷编译）。统一配方就是仓库基线本身，不再设置任何 profile 环境变量：

```powershell
$env:CARGO_BUILD_JOBS = "1"
cargo build -p openbitfun-desktop --bin openbitfun-desktop
```

`CARGO_BUILD_JOBS=1` 只限制并发 rustc 数量（16 GB 内存约束），不改变指纹。
`scripts/dev.cjs` 的快速重建默认值已与该基线对齐
（`DEBUG=line-tables-only`、`INCREMENTAL=true`、`CODEGEN_UNITS=256`），手动 build
与 `desktop:dev` / `desktop-preview` 共享同一指纹，互相增量。

- **不要**设置 `CARGO_PROFILE_DEV_DEBUG=0` 或其他 profile 覆盖；需要断点调试时按
  `Cargo.toml` 注释临时使用 `CARGO_PROFILE_DEV_DEBUG=2`（接受一次全量重编，用完
  清除该环境变量再回到基线）；
- 快速反馈不要在 build 前追加 `cargo check`、测试或 Web UI type-check。指定
  `--bin openbitfun-desktop` 明确请求 binary target；但当前同包 lib 同时声明
  `staticlib/cdylib/rlib`，Cargo 仍会生成并链接 `openbitfun_desktop_lib.dll`。要去掉该阶段，
  需要把移动端/FFI wrapper 与 Desktop rlib 拆成独立 package/target；
- `src/web-ui/**` 由 Vite HMR 直接刷新，不需要 Rust build；内嵌 MiniApp source
  仍须一次 binary build 才能 reseed；
- 需要同时持续改 Desktop Rust 时，改用 `pnpm run desktop:dev` 完整会话，不要在同一
  target 上混跑；
- 装 sccache 可进一步让配方/feature 切换也不触发全量重编（可选优化）。

### 提交或发布前

开发期不需要 bump version，内容哈希变化会触发 reseed。发布时才做以下动作：

1. 同步增加 `builtin.rs` 中 `BUILTIN_APPS` 的 version 和 `meta.json` 的 version；
2. 运行聚焦 built-in 契约测试：

   ```bash
   cargo test -p bitfun-product-domains --features product-full builtin_miniapp
   ```

3. sidecar pin 或构建脚本有变化时运行：

   ```bash
   pnpm run build:loopx
   ```

4. 需要完整 Desktop 构建产物时使用仓库入口：

   ```bash
   pnpm run desktop:build:fast
   ```

规范依据：`MiniApp/Skills/miniapp-dev/SKILL.md` 的「内置小应用（builtin/assets/*）
维护规范」。

## 内置更新行为

- 内容哈希变化（无论 version 是否 bump）都会在下次启动时 reseed：用户机器上的
  源文件被覆盖为最新内置版本；
- 用户对源文件的**手动本地修改会被覆盖**，除非该应用处于"本地定制(local
  override)"状态——那时只记录"有可用更新"通知（可拒绝），不改动本地内容；
- `storage.json`（设置、GitHub Token、goal↔session 映射等）跨 reseed 始终保留。

## 权限与信任模型

本应用遵守 MiniApp V2 无 Node 规范：`meta.json` 明确设置 `node.enabled=false`，
`worker.js` 只有空兼容导出，UI 不执行 shell、文件或网络原语。普通和市场 MiniApp 的
`window.app` 公共 API 中没有 LoopX 控制器。

编译器只为 id 精确匹配 `builtin-bitfun-loopx` 的非 strict 构建注入私有
`app.loopx` namespace；Web UI 与 Desktop 在每次调用时继续校验 active scope、原始
built-in source、非本地覆盖和本地执行域。伪造 id、draft、市场包或修改后的内置源码
都不能取得该控制器。这个 namespace 是产品私有扩展，不得被其他 MiniApp 使用或模拟。

## 平台支持

- Desktop 安装包携带固定版本的 LoopX sidecar；资源缺失或系统版本不匹配时，用户可从
  环境卡片显式触发安装：宿主从官方 GitHub 仓库 clone 固定 pin 版本（当前
  `v1.0.1`）/commit 到
  OpenBitFun 管理目录并用 Python 3.11+ 直接运行源码。不会覆盖系统 `loopx`，也不会修改
  用户的全局 Python 环境；没有 Python/Git 时返回明确前置条件错误。安装 action 只负责
  持久化进行中状态并立即返回，下载在宿主后台执行；clone 使用 blobless sparse checkout，
  只检出 `loopx/` 与必要元数据/许可证，完成或失败都通过环境事件回推 UI。
- Git workspace、GitHub intake、进程树与 sidecar 探测由 Rust service owner 实现，
  不进入 UI 或 Worker。
- 当前只支持本地 Desktop workspace。Remote Workspace、Peer Device、Remote Control
  和 Detached Dispatch 均返回明确 unsupported，不静默回退到控制端本机。

## 设计假设

- `LoopxController` 是进程级 host driver，不依赖 MiniApp iframe 生命周期；关闭或
  重开界面不会创建第二套心跳。UI 通过 cursor replay 恢复事件。
- Desktop 待机恢复由 MiniApp 的可见性/焦点/时钟间隙检测触发幂等 attach；可信私有
  attach 会让宿主刷新环境与非运行 Goal 投影，但保留仍可恢复的单一 Agent turn，避免
  伪造失败或重复启动。活动任务长时间没有事件时 UI 只做有界快照重取。
- 普通 UI attach 不重复 inspect `WaitingForUser`、终态或显式恢复态 Goal；这些状态由
  宿主审批/恢复动作直接推进，仅在真实待机恢复的 force reconciliation 中重新向 CLI
  对账。这样等待审批不会每 30 秒生成一个可能超时的 sidecar 进程。
- Issue 列表与 issue 视图是一级工作区：右侧 issue 视图永远对应当前选中任务，未选中时自动跟随正在运行的任务并显示跟随横幅；点击左侧任务即固定查看该 Issue，右侧内容与左侧选中严格一一对应。issue 视图自上而下集中展示：任务头（标题、状态、操作、GitHub 链接）、审批面板、当前阶段（五阶段总结 + 当前动作）、最新进展（durable 的最后回合总结 + 事实 chips：工作区路径、回合、结算回执、产出物、错误）、原始 Issue 描述（可折叠）和合并时间线（宿主事件与模型实时输出按轮次交错，准备期/排队期不再空白）。审批门禁同时投影为持久顶部提示，但只负责提醒与跳转；批准/拒绝只在 issue 视图内提交，提交后以任务 pending 状态等待宿主确认，不把 CLI 往返延迟表现成按钮卡死。
- 桌面默认保持“任务 / Issue 详情 / 运行时间线”三列，只有右侧 issue workspace 小于
  780 CSS px 时才把详情和时间线上下堆叠。选中任务后只读刷新一次 GitHub metadata，
  优先显示当前的 Unicode-safe 600 字符摘要；网络不可用时回退到持久任务快照。
- `pending_gate_id/message/action_kind` 属于任务快照的持久投影，审批按钮不依赖可能被
  截断的历史事件回放。升级前的 `WaitingForUser` 记录若缺少该投影，普通 attach 只做
  一次 CLI reconciliation 补齐，之后重新进入等待态免轮询路径。
- 每轮 turn 由专用 `LoopxAgentPort` 通过通用 `AgentSubmissionPort` 启动临时 OpenBitFun
  Agent session。通用 Agent loop 不包含 LoopX 分支；`LoopxCliPort` 用**不带 turn 身份的只读
  `quota should-run --turn-envelope`** 做状态对账（适配器已不再调用 `turn plan`：后者有
  8192 字节 envelope 预算门，超预算会 `contract_error` 搁置 goal），真正执行前在同一 turn id
  上再调用一次 `quota should-run --turn-envelope` 作为执行 gate，并把其中的
  selected todo、boundary、required reads、execution policy 和 writeback contract
  投影给 Agent。Agent 技术能力由 assembly 显式声明，services adapter 只负责协议翻译；
  permission grant 始终是另一条独立边界。
- Intake 展示的五项标准 scope 是无头 issue-fix Agent 完成工作的必需集合。用户明确确认
  全部 scope 后，host 才以 `auto_approve` 运行该 transient turn，避免在没有通用工具审批卡的
  MiniApp 中创建无人能回答的 permission request。发布、公开评论、PR、合并和生产操作不可在
  intake 预授权，仍由 LoopX typed user gate 要求 owner 决策。缺少任一必需 scope 时在创建阶段
  明确拒绝，不启动一个会隐形等待权限的 Agent turn。
- LoopX registry 是 goal/todo/gate/quota/settlement 的唯一权威。OpenBitFun 持久化的
  `LoopxTaskState` 只描述 workspace、session、取消和恢复等 host-job 生命周期，并保存
  最近一次只读 `goalState` 投影；启动环境检查和 UI attach 都会向 CLI 对账。
- OpenBitFun runner 在调用 Agent 前执行新鲜 `quota should-run` guard；Agent 只推进一个有界
  selected todo，并通过真实工具结果验证后按 LoopX writeback contract 写回。宿主不从
  对话文本或 Agent 进程退出码推断进展，只读核验与 goal、agent、Turn 和 todo /
  autonomous-replan binding 匹配的 durable writeback 与 quota receipt。缺少任何一项都进入
  显式 recovery；宿主不补写 quota、不伪造 progress，也不启动 settlement-repair Agent。
- 当前采用官方 mainstream cooperative runner 路径：Agent 负责按 packet 校验真实
  postcondition 并写回，宿主独立核验 durable writeback 与 quota receipt。由于 OpenBitFun 尚未
  提供 task-specific validator port，本集成不宣称满足 experimental `turn run-once` 的
  typed result + independent validator qualification；引入该路径前必须先补齐稳定结果合同、
  独立 validator 和 replay/resume 幂等证明。
- 任务快照在结算前保存有界的最后 Agent 回合总结，供详情页展示分析、方案、产出和
  下一步；该总结只是 UX 投影，不参与 Goal 状态、durable progress 或 settlement 判定。
  Subscriber 只聚合最后一个模型 round 的最新 attempt，防止中间工具回合或重试文本
  混入最终总结。
- **目标模型：一个 goal 只对应一个 issue/PR**（`goal_id_for` 生成
  `bfx-owner-repo-issue-N`，重试追加 `-attempt` 后缀），每个 item 有独立
  worktree 与 `.loopx/registry.json`；todo 是 **goal 内部** 的推进项/审批门禁
  （`todo add --goal-id` 强绑定单一 goal），不用一串 todo 把多个 issue 串在
  一个 goal 下。依据：loopx 的 goal 是「单一 objective 的持续 turn 载体」，
  quota/心跳/审批/结算都以 goal 为域，registry 本身支持多 goal 列表——
  多 issue 的"批量管理"由本应用 task/batch 层聚合，不压平到 loopx goal。
- **Custom Agent Runner 合同**：OpenBitFun 采用 LoopX 官方 mainstream 路径，不转发或改写
  Codex heartbeat prompt，也不在宿主中复制 LoopX CLI 教程。每次唤醒重新读取 fresh
  TurnEnvelope，由 adapter 生成一段稳定 re-entry instruction，附带唯一 CLI prefix、
  registry、Turn identity 和本轮最小合同。上一轮对话摘要只用于 UI 展示，不回灌为
  控制事实；项目 policy、todo 列表、cadence 和领域流程始终从 LoopX 当前状态读取。
- **Goal 终局**：只有 LoopX 投影 `Complete` 或 `Archived` 时，宿主才把 host task
  收束为 Completed。若 LoopX 返回 `RunNow` 却没有开放 todo，宿主进入显式 recovery，
  保留 registry 与 worktree，绝不代写 `goal-lifecycle stop` 或伪造终局。
- **心跳调度**：本应用维护一个统一的 task 调度循环（非每 issue 一个独立
  定时器）；`inspect_goal` 读取 LoopX cadence。v1.0.1 的压缩 envelope 只携带
  `scheduler.cadence_class` 标签（数值间隔在 quota decision detail 里），宿主把
  标签映射到 pin 内 scheduler 自己的初始间隔（见 `wait_requeue_delay_ms`），
  无标签的降级快照退回有界轮询。同一仓库的多个 goal 串行推进（
  `active_repositories` + `schedule_next_for_repository`）。**同仓库任务串行，但结算后默认
  深度优先续跑**：只要 Goal 仍投影 `RunNow`（含到期的 monitor successor），当前 task 不释放
  仓库槽、在同一 worker 内自重入（`sticky_continue_after_settlement`），队列里的其他 Issue
  继续等待；只有 task 进入等待/终态/recovery 时才把仓库槽交给下一个 Issue。长 Issue 因此会
  推迟同仓排队的其它 Issue——这是已知取舍（2026-09-10 实测：一个 3-turn 的 no-op issue 让两个
  排队 issue 等了 15 分钟），不是公平轮转。
- **PR 生命周期监控投影**：PR 发布后 LoopX 用 `continuous_monitor` /
  `issue_fix_pr_state_*_monitor` todo 继续持有 Goal，pr-lifecycle 的四种转移
  （runnable_successor / monitor_continuation / user_gate / no_followup）全部在
  pinned CLI 内决策。宿主不调用 `issue-fix pr-lifecycle`，也不压缩 maintainer
  correction——两者都是 agent 轮内按 TurnEnvelope / packet 的职责。宿主只把
  quota envelope 的 selected todo 投影为任务快照 `currentTodo`（有界、非权威、
  Goal 终局清除），UI 据此把排队态区分为「PR 监控等待中」并展示下次检查时间，
  避免等待 CI/review 被误读为卡住。
- **worktree 成本**：同仓库所有 task 共享一份裸仓库对象库
  （`<root>/<repo-hash>/bare.git/`，首个 task `git clone --bare` 建立），每个
  task 用 `git worktree add -b bitfun-loopx/<task-hash>` 挂出独立工作区
  （`<root>/<repo-hash>/<task-hash>/`）。磁盘 ≈ 1 份对象库 + 各 task 的检出
  文件；历史版本升级前创建的旧式独立克隆（每 task 一份完整 `.git`）仍可
  正常复用，不强制迁移。归档会立即释放单个任务的磁盘：dispose 先
  `git worktree remove --force` 删除该 task 工作区，再按
  `git worktree list` 剩余条目数判断是否删除共享裸仓库（最后一个 worktree
  离开时整仓回收）。loopx 上游只 `connect` 已存在项目、不 clone，克隆策略
  是宿主侧职责，改动需同步 `loopx_workspace.rs` 与克隆契约测试。
- **依赖与构建缓存边界**：包管理器下载缓存（例如 Yarn Berry 全局 cache）和 Git 对象库
  可以跨 task 复用；`node_modules`、构建目录和测试进程属于可变工作树状态，不在并行
  Issue 间直接共享，避免一个 Issue 的安装脚本或平台产物污染另一个 Issue。Agent 使用
  OpenBitFun 通用 Runtime 的工具与进程约束；LoopX adapter 不复制一套专用执行手册。
- **全量清空**：重置会先把整个旧 workspace root 原子改名隔离，立即创建新的
  活动 root，并搬回经过目录边界验证的 `bare.git` 对象缓存；旧 task Worktree
  在后台递归回收。这样不会复用脏工作树或失去 owner 的未结算修改，但下一次同仓库
  任务不必重新下载完整 Git 历史。要继续已有修改应使用仓库级恢复，不应先重置。
- **收敛防护复用 LoopX 自有机制（宿主不造轮子）**：宿主不合成任何停滞/
  同-todo/回合数启发式门禁，也不在任务快照里维护第二套收敛计数。LoopX 自有的防护链
  已经覆盖：stall observation 会让
  LoopX 向 agent 下达 autonomous replan obligation（连续卡住时强制重规划，
  持续不可修复则 pause 该 Goal 的心跳），agent 自己在需要 owner 决策时通过
  typed `user_gate` 上抛（例如外部写入前的 PR 审批门禁）。宿主只在 Goal 无开
  settlement 完全缺失或 Goal 投影自相矛盾时进入显式 recovery。审批文案
  遵循“注意力税”原则：只有在真正需要人类决策（无法自行解决、或对外发布）时
  才请求审批，且必须携带背景、已做工作、卡住原因与需要的决定；审批面板只展
  示 gate 原始消息与分类后的后果说明，不伪造 issue 背景/影响描述。
- **通知契约（宿主独占）**：OS 级 toast/通知由宿主统一管理。MiniApp 无头 Agent
  会话（sessionKind 'miniapp'）的每轮完成被
  `dialogCompletionNotifyPolicy` 显式排除，不产生“任务完成”toast——注意力
  只在 owner 决策点被请求：新 user gate 首次出现时由 MiniApp UI 通过
  `notifications.system` 桥发系统通知（meta.json 需
  `notifications.system: true`）。workspace 准备等过渡性事件不产生系统级
  提醒。
- 模型成本仍由用户在 OpenBitFun 侧管理；收敛门禁是控制权边界，不是费用估算器。

## loopx 依赖与合规

- **内置编译二进制（随安装包分发）**：打包流程（`scripts/desktop-tauri-build.mjs`，
  即 `pnpm run desktop:build*` 的 bundle 路径）会先执行 `scripts/build-loopx.mjs`：
  构建期拉取 pinned loopx 源码（当前 `v1.0.1`）并用 PyInstaller 编译单文件二进制，随
  tauri `bundle.resources` 作为 sidecar 分发（`resources/loopx/`）。桌面宿主把
  资源目录由 Desktop 启动 wiring 传给 `LoopxCliProcessAdapter`，探测时内置二进制
  优先，用户机器零依赖。资源缺失时依次使用经 commit 校验的 OpenBitFun 托管源码、版本
  完全匹配的系统命令；托管源码安装只由用户点击触发，不在启动时静默下载。
  生成的 `resources/loopx/` 目录在 `.gitignore` 中，二进制不进仓库；`manifest.json`
  记录版本、commit、内容哈希与构建工具链。
- **Apache-2.0 再分发义务**：loopx（含 v1.0.1）为 Apache-2.0（Copyright 2026 LoopX
  contributors）。`resources/loopx/` 随包携带上游 `LICENSE`、`NOTICE`、历史
  `LICENSE-MIT` 与 `TRADEMARKS.md`；运行时托管源码保留完整 checkout。
  `THIRD_PARTY_NOTICES.md` 已收录对应条目。名称按 loopx
  [TRADEMARKS.md](https://github.com/huangruiteng/loopx/blob/main/TRADEMARKS.md) 描述性使用，
  本应用是第三方集成，非 LoopX 官方出品。
- **运行期兜底**：内置二进制缺失时，优先使用 OpenBitFun 管理的固定 GitHub 源码；未安装
  托管源码时才检查版本完全匹配的系统 `loopx`。任何版本或 schema 不一致都直接拒绝。
- 本应用自身的 GitHub 凭据只存于本机应用存储（gh CLI 或粘贴的 PAT），不写入 git config。

## loopx 依赖升级

loopx 的随包二进制与按需托管源码都 pin 同一个经过验证的版本。**不要自动追新**：
只有在确实需要新版能力/修复时才升级。

1. **读 release notes / CHANGELOG**，重点确认 CLI 的 `--format json` 输出契约
   （`turn plan` / `quota should-run` / `history` / `todo` / `bootstrap`）没有破坏性变更；
2. **改 pin**：同步修改 `scripts/build-loopx.mjs` 与 `loopx_cli.rs` 的版本、tag 和源码
   commit 常量；
3. **本机冒烟**：重建 sidecar 后跑一个 issue 全流程（intake → turn → todo 审批 →
   receipt 观察）验证 JSON 契约；
4. **回滚**：恢复上述两个 pin 并重建 sidecar；已持久化 host job 和 LoopX registry
   均保留，不删除用户工作区；
5. **随发布提交**：pin 变更与 `version` bump 一起进发布版（发布版自带的
   sidecar 二进制由打包构建重新编译）。

**升级经验（首批开发踩坑记录）**：

- runner 的执行 packet 必须来自一次新鲜 `quota should-run --turn-envelope`，并由宿主绑定
  稳定 Turn id；`turn plan` 只用于无副作用状态投影，Agent 不能自行生成或从自然语言恢复
  Turn identity；
- sidecar JSON stdout 与进程 stderr 必须分流，stdout 只接受一个结构化文档；
- 不能通过自然语言或进程退出码推断结算成功，只接受 LoopX history/receipt 中与
  goal、agent、todo 和 Turn id 全部匹配的持久证据。
