# AGENTS.md — bitfun-loopx 内置 MiniApp 开发协定

本文件仅适用于本目录（bitfun-loopx 内置 MiniApp 的**唯一权威源码**），比仓库根
`AGENTS.md`、`src/crates/contracts/AGENTS.md` 更具体，冲突时以本文件为准。开发
流程细节见本目录 `README.md`「高效修改流程」；本文件同时钉住架构边界与
**用户明确要求的迭代原则**。

## 架构基线（不可绕过）

规范依据是 LoopX 官方
[Custom Agent Runner Integration](https://github.com/huangruiteng/loopx/blob/main/docs/guides/custom-agent-runner-integration.zh-CN.md)。
OpenBitFun 使用 mainstream cooperative runner 路径：保留自己的 Agent Runtime，把 LoopX
作为跨 Turn 的持久控制面合同。不要复制 Codex runner，也不要把 LoopX 改造成 BitFun
内部 workflow engine。

### 心智模型与唯一事实源

| Owner | 负责 | 禁止负责 |
|---|---|---|
| LoopX CLI | goal、todo、claim、gate、quota、evidence、scheduler hint、已接受的 writeback 和 Goal 终局 | Agent 推理、OpenBitFun session、工具执行、workspace 创建 |
| BitFun runner/controller | 唤醒、队列、公平调度、workspace/session 生命周期、取消、UI 投影、断点恢复 | 重写 LoopX policy、代写 progress/quota、根据模型文本判定完成 |
| OpenBitFun Agent | 动态规划并执行一个有界动作、读取真实产物、验证 postcondition、按 packet 写回 LoopX | 保存第二套任务状态、创建 scheduler、创建额外 worktree |
| MiniApp UI | intake、任务列表、进度、gate 操作、cursor replay | 直接执行 shell/Git/network，或成为 goal/todo 真相源 |

`LoopxTaskSnapshot` 只是 host-job 投影，允许保存 workspace、session、取消、恢复、UI
摘要和最近一次 LoopX 状态；它不是 LoopX registry 的副本。冲突时以 LoopX CLI 的
durable readback 为准，禁止用本地计数、transcript 或 UI 状态覆盖它。

### 分层和代码归属

依赖方向必须保持 `UI/Desktop adapter -> assembly controller -> typed ports -> services`：

| 路径 | Owner |
|---|---|
| 本目录 `index.html` / `ui.js` / `style.css` | 无 Node 的薄 UI；只调用经过验证的私有 `app.loopx` bridge |
| `src/apps/desktop/src/api/miniapp_loopx_api.rs` | 验证 built-in source、执行域和 Tauri request；只转发 typed controller 调用 |
| `src/crates/assembly/core/src/miniapp/loopx/controller.rs` | 进程级 host driver、batch/queue、公平轮转、恢复和状态投影 |
| `src/crates/assembly/core/src/miniapp/loopx/agent_adapter.rs` | 把通用 `AgentSubmissionPort` 适配成 `LoopxAgentPort`；使用标准 `agentic` coding Agent |
| `src/crates/contracts/product-domains/src/miniapp/loopx/*` | 稳定 DTO、ports 和纯 policy；不得执行进程、文件、网络或 Agent Runtime |
| `src/crates/services/services-integrations/src/miniapp/loopx_cli.rs` | 固定版本 sidecar 选择、typed CLI argv/JSON 翻译和 durable readback |
| `loopx_github.rs` / `loopx_workspace.rs` | GitHub intake adapter 与 Git/worktree service |
| `src/apps/desktop/src/lib.rs` | 只做 concrete provider 装配、事件订阅和 Tauri registration |

具体 Agent host 自己通过 `LoopxAgentPort::available_capabilities` 报告技术能力。controller
只转交，CLI adapter 只校验和翻译。`available_capability` 表示执行机制存在，不是用户授权；
绝不能从 `granted_scopes`、gate approval 或模型能力推导它。以后接 Codex、Claude Code
或其他 Agent 时，应新增/替换 `LoopxAgentPort` adapter，不修改 LoopX controller 状态机。

### 一项一 Goal 模型

- 一个 GitHub issue/PR 对应一个 LoopX goal、一个 task 和一个独立 worktree。
- 多 issue 批量是 MiniApp task/batch 层的聚合，不得把多个 issue 压进同一个 goal 的 todo。
- todo 只表示该 goal 内的推进项、successor 或 user gate。
- 同一仓库的 tasks 串行占用 repository slot；每次 durable settlement 是公平轮转边界。
- 不同 tasks 可以共享 bare Git object cache，但不能共享可变 worktree、`node_modules`、
  build 输出或运行中的进程。
- LoopX 不负责 clone；workspace service 不负责 todo、quota 或 Agent 决策。

### 每轮执行合同

每次唤醒的**控制事实**必须从 durable state 重新推导：re-entry instruction 每轮都从当前
TurnEnvelope 重建，settlement 只认 LoopX durable evidence，与对话内容无关。goal 的
agent session 可以跨 turn 续接（2026-09-08 起，codex exec resume 的同等机制，见后文
修复批次），但续接的只是**对话上下文**（已读文档、已完成工作），不是权威状态——
会话里的任何记忆都不得替代下列步骤的 CLI 读写与核验：

1. controller 用只读 `turn plan` 对账当前 Goal、user channel 和 cadence；该读取不启动 Agent。
2. 只有 LoopX 投影 `RunNow` 时，adapter 以宿主生成的稳定 Turn id 调用一次
   `quota should-run --turn-envelope`。这一次调用同时是执行 gate 和 Agent packet，禁止先
   缓存一个 packet、再用另一个 packet 放行执行。
3. `should_run=false`、wait、quiet、monitor-only、user-only 或 failed 状态不调用模型，
   也不消费 quota。
4. re-entry instruction 只能携带当前 TurnEnvelope 的 selected action、user channel、
   required reads、boundary、execution policy、writeback、replan/task orchestration contract、
   detail refs、CLI prefix、registry 和 Turn identity；writeback/spend 的 copy-ready 命令
   由宿主镜像 v0.5.1 canonical 模板生成（见 2026-09-08 修复批次），不属于自造合同。
5. Agent 在 write-capable 工作前 claim selected todo，只执行一个有界动作，读取真实
   repository/test/CI/provider 结果进行验证，然后 complete/update/block/defer 或创建明确的
   successor，执行 `refresh-state`（用指令中宿主给出的 copy-ready 命令，含必填
   accountable delivery-outcome，agent 只填占位符，不自拼其它 argv 形态），
   最后才以同一 identity spend quota。
6. Agent terminal 后，宿主只读 `turn plan` 与 history，核验完全匹配的
   `goal_id + agent_id + turn_id + selected todo/replan obligation` durable writeback 和 quota
   receipt。durable writeback 缺失或错绑进入显式 recovery（NoDurableProgress 先走一次
   corrective turn）；cancelled/interrupted turn 的 RetryRequired 同样进显式 recovery，
   宿主不得在 owner 打断后静默续跑。只有 Completed turn 的 RetryRequired（写回已验证、
   仅 quota 回执缺失，即 CLI 假阴性结算；终局 frontier 下 guard 拒绝放行、无法补跑
   turn）例外：宿主按结算后 Goal 投影决定下一状态，并落一条重要 task event 记录回执
   缺失；宿主不补写、不伪造回执，也不得静默丢弃该记录。
7. 只有 LoopX 投影 `Complete` 或 `Archived` 时，host task 才能 Completed。
   计划耗尽时（无 open todo、无 selected todo、无 waiting gate）CLI v0.5.1 会投影
   `should_run=true` 并携带 `replan_action_packet.obligation_id`：宿主必须驱动一轮绑定该
   obligation 的 autonomous replan turn（quota guard 放行，settlement 按
   `autonomous_replan` effect id 核验），由 agent 写回 successor todo、typed 终局
   （如 `coverage_backed_no_followup` + vision 闭环）或新 concrete blocker；CLI 的
   replan stall 机制约束连续空转。只有 `RunNow + 0 open todo` 且无 open replan
   obligation 才是合同矛盾，必须 park（`plan_exhausted`）等 owner 决策；禁止宿主调用
   `goal-lifecycle stop` 来伪造终局。（2026-09-05 五 issue 实测修正：旧版把带 obligation
   的耗尽态一律当矛盾处理，导致 0/5 全部停在 recovery，goal 无法自主收尾。）

re-entry instruction 必须稳定且轻量，不得缓存 todo 列表、cadence、project policy、上一轮
摘要或 raw transcript。`last_agent_summary` 仅用于 UI，不参与执行、settlement 或恢复判断。

### Gate、调度和恢复

- `should_run=true` 优先于并存的 user action：独立安全 todo 可以继续，同时把具体 user
  gate 投影到 UI；不能因为一个 gate 阻塞整个 frontier。
- BitFun 是 `generic-cli / outer_controller / isolated-headless` runner。统一 scheduler
  管所有 task，不得每 issue 创建 timer，也不得调用 Codex App automation API。
- LoopX `v0.5.1` 的 bootstrap 参数 `--codex-app-heartbeat no` 只是关闭上游遗留的
  Codex 专用 onboarding 分支，不代表 OpenBitFun 模拟 Codex App。
- scheduler hint 有数值时按数值调度；当前 outer-controller packet 只有 cadence label 时，
  使用代码中明确的兼容间隔。只有 packet 要求 ACK 时才按 packet 的 exact argv ACK。
- PR 生命周期监控（`continuous_monitor` / `issue_fix_pr_state_*_monitor` /
  `issue_fix_track_*` todo）由 LoopX packet 驱动、agent 在轮内执行；宿主不调用
  `issue-fix pr-lifecycle`，也不压缩 maintainer correction。宿主只把 turn plan
  envelope 的 selected todo 投影为任务快照 `currentTodo`（有界、非权威、Goal
  终局清除），UI 据此区分「PR 监控等待中」。当前 pin `v0.5.1` 不返回数值调度
  hint（60s 兼容间隔）；上游 ≥v0.5.x 的 monitor_wait 数值 cadence（[15,30,60] 分钟，
  宿主下限 15 分钟）在升级 pin 后经既有 `scheduler_hint_ms` 路径自动生效。
- v0.5.1 下 monitor 类 todo（`*_monitor` 与 `issue_fix_track_*`，见 policy.rs
  `is_loopx_monitor_action`）即使投影 `RunNow`，宿主也按 15 分钟兼容下限把
  re-check 驻留排队（锚点是该 goal 上一次 durable settlement 时间，不是新增宿主
  收敛计数），期间让出 repository slot 给同仓库排队 issue；深度优先 sticky 续跑
  对 monitor successor 不适用。该分类与 UI `isMonitorTodo` 镜像，修改需双侧同步。
- runner 重启从 LoopX registry、host task snapshot 和 workspace readback 恢复，不能 replay
  transcript 重建控制状态。结果不确定时保留数据并进入 recovery，不自动重试外部副作用。

### 允许保留的宿主能力

以下不是“嵌入式改写”，不得因清理架构而误删：

- 打包的固定版本 LoopX sidecar、签名/版本/schema 校验，以及用户显式触发的 managed-source
  fallback；它们属于可交付性和 process adapter。
- GitHub issue/PR metadata intake；它属于外部 source adapter。
- 每 item worktree、共享 bare object cache、显式 archive/reset 清理；它们属于 workspace
  service 和 host-job 生命周期。
- cursor event replay、Agent transient session、取消和公平队列；它们属于 runner/UI 体验。

OpenViking、语义偏好、反馈记忆和其他可选 LoopX extensions 不属于 issue-fix MiniApp 的
核心闭环。没有独立产品需求、owner 和 capability negotiation 前，不得重新塞入本
controller、environment DTO 或 UI。

### 禁止重新引入

- 不生成、转发、改写或缓存 `heartbeat-prompt`，不复制 Codex prompt/skill 目录约定。
- 不创建 host-authored `LOOPX_AGENT_PLAYBOOK.md`、`.bitfun/loopx/intake-plan.json` 或类似
  workflow 镜像文件。
- 不把上一轮 Agent 摘要、todo 摘要或 raw workflow packet 回灌成下一轮控制事实。
- 不用字符串替换修改 LoopX packet，不裁剪/改写 LoopX durable todo 来让 envelope 通过。
- 不维护宿主侧 autonomous-turn、stagnation、same-todo 等第二套收敛计数，也不自造
  `autonomous_budget_review` gate。
- 不从 worktree diff、Agent exit code 或完成文本推断 durable progress。
- 不补写 quota、不伪造 evidence、不启动 settlement-repair Agent，不接受其他 todo 的
  settlement 作为当前 selected todo 的成功。
- 不让 UI/Worker 接触 shell、Git、文件或 network primitive，不向普通/市场 MiniApp 暴露
  `app.loopx` 私有 namespace。
- 不为 convenience 绕过 typed ports 传 raw argv，也不把 services implementation 上移到
  assembly 或 Desktop API。

### 当前能力边界

- 当前只支持 Local Desktop workspace。Remote Workspace、Peer Device、Remote Control
  和 Detached Dispatch 必须明确返回 unsupported，禁止静默回落到 controller 本机。
- 当前是 cooperative mainstream path：Agent 自己验证真实 postcondition 并写回，宿主再
  独立核验 LoopX durable evidence；这不等于 experimental `turn run-once` qualification。
- 在引入 `turn run-once` 前，必须先有 provider-neutral typed result、task-specific independent
  validator，以及 retry/resume/replay 不重复产生 effect 的证明。
- persisted DTO 新字段必须有默认值；旧字段/旧 action 要宽容读取并明确降级，不能通过删除
  registry、task snapshot 或 worktree 来“修复”升级问题。

### 对照方法论：LoopX 适配的是 Codex，不是 Codex 适配 LoopX（2026-09-07 实测）

方向事实：LoopX 官方把 Codex 作为一等宿主——`runtime-profile codex_cli`、
`-A/--codex-app` 别名、bootstrap 的 `--codex-app-heartbeat`、`quota should-run`
返回的 `codex_app` scheduler hints 都是 LoopX 自带的 Codex 适配面。**Codex 不去
适配 LoopX；是 LoopX 去适配 Codex。** BitFun 是反向的「BitFun 适配 LoopX」，
所以遇到不确定的 LoopX 语义时，正确参考物是 LoopX 对 Codex 的既定行为
（源码 `loopx-src`、官方 custom-agent-runner-integration 文档、scheduler hint 投影），
而不是自己猜。

方法论（已在本仓实证）：**对某个 LoopX 行为/收尾语义不确定时，在独立克隆上用
同一 issue 跑一遍「loopx 0.5.1 源码运行 + codex exec」作为标准答案对照**。
实例（2026-09-07，同一条 no-op issue #1 双跑，BitFun 侧 vs codex 侧）：
- BitFun：约 30 分钟、9 次 exit=1、goal 状态文件长时不动，最终靠宿主投影
  completed（结算写回未验证）。
- codex：约 12 分钟、零失败循环，bootstrap→feasibility(triage_only)→todo 闭环→
  refresh-state(no_followup+vision)→quota should-run 返回 `terminal_no_followup /
  no spend`，干净关闭；GitHub 零触碰。
- 结论：判定逻辑（triage_only/no_followup）两边一致且正确；差异在
  ① runtime 路径：loopx 默认 `common_runtime_root` 指向共享 `~/.codex/loopx`
  （源码 bootstrap.py `setdefault("common_runtime_root", runtime_root)`、
  cli.py `--runtime-root` 全局覆盖），共享路径带来跨宿主锁竞争/写拒绝；
  ② 收尾必填参数清单：`--progress-result-class no_followup` 要求同时提供
  `--progress-coverage-scope-id / --progress-surface-id / --progress-hypothesis-id /
  --progress-probe-kind / --progress-evidence-id / --progress-coverage-complete` +
  `--agent-vision-json`（含 state=no_followup、path_delta.outcome=stop）；
  settlement 绑定 guard-bound todo id（不是 replan-obligation-id）；agent-lane 作用域
  不能更新 durable Next Action；quota spend-slot 绑定同 todo+turn 身份。
- 适配层已按此采纳：bootstrap 加 `--no-global-sync`；所有 CLI 调用注入
  `--runtime-root <worktree>/.loopx/runtime`；bootstrap 后把 registry
  `common_runtime_root` 补丁为本地 runtime；并把各 goal 的默认 `state_file` 从
  loopx 遗留的 `.codex/goals/<id>/ACTIVE_GOAL_STATE.md` 改为
  `.loopx/goals/<id>/ACTIVE_GOAL_STATE.md`（文件随之搬移）——worktree 完全
  `.loopx` 命名。BitFun 与 codex 是独立 agent，`.codex` 只是 loopx 的旧默认路径
  命名，不是 BitFun/Codex 耦合。
- 文档加载与 codex 对齐（2026-09-07）：pinned CLI 参考 + 官方 SKILL 文档（核心两篇合一 +
  4 篇兄弟技能文档，清单见 2026-09-08 批次）以 `.loopx/pinned-loopx-skill.md` 等种子进
  worktree；每回合指令只带**小指针**，由代理像 codex 加载技能一样主动读取
  （2026-09-08 起：**读取策略只归指针节所有**——首 turn 指针为“读一次”并枚举全部
  兄弟文档，session 续接后的 turn 改带“已加载，复用上下文”指针；closing note
  只命名文档、不下发读指令，防止续接会话每轮重读 59KB，见后文修复批次）——
  不再 139KB 塞进指令（token/缓存友好，模型遵循度更高）。注入配方已大幅瘦身：
  只保留宿主事实（类型化拒绝→精确修正一次、两次即 blocker；runtime 本地化），
  自创断言与"最小证据"提示已删除（其曾导致 repository_context=not_provided 漂移）。
- 回退信号：若某次改动后又出现「exit=1 循环 + 状态文件不动」模式，先跑一次
  codex 标准答案对照，再对比 argv/路径，不要先怀疑模型或判定逻辑。

### 2026-09-08 修复批次：turn 内三处浪费根因（live 观测，dynamic-workflows-lab #1）

同日观测一次完整 run（4 turn / 20 分钟仍未关闭），定位三个 turn 内浪费根因并修复：

1. **指令引用陈旧文件名**：closing note 仍指 `.loopx/pinned-loopx-reference.md`（改名前旧名），
   agent 每 turn 开场必吃一次 failed Read + 一轮自恢复推理。已统一为
   `.loopx/pinned-loopx-skill.md`，并由测试锁死旧名不回归。同批把读取策略收敛到
   指针节单一事实源：closing note 首条改为只命名文档（agent 实测会字面执行
   note 里的读指令，若保留双入口，续接会话每轮都会重读 59KB）；测试锁死
   “fresh 恰好一处、续接零处 Read 指令”。
2. **agent 自拼 settlement 命令 → typed refusal 循环**：v0.5.1 对 turn-scoped
   refresh-state（带 --todo-id / --replan-obligation-id / --turn-instance-id 任一）
   强制要求 **accountable** delivery-outcome（仅 `outcome_progress` /
   `primary_goal_outcome`，`surface_only` 不算），且 typed progress-result-class
   需至少一个稳定标识符；而 outer_controller 路径的 envelope 只给裸模板
   `--classification <validated_progress>`（完整 settlement plan 仅
   CODEX_APP_HEARTBEAT profile 生成）。agent 靠 help 文本拼命令 → 连续 typed
   refusal（surface_only 被拒两次）→ 遵守“两次即 blocker”报障 → 无 run
   record → NoDurableProgress → 追加纠正轮。修复：宿主在 re-entry
   instruction 里镜像 v0.5.1 canonical 模板（`effect_program.py` 与
   `autonomous_replan_obligation.py`，replan 轮含 `--progress-scope agent_lane
   --classification bounded_replan_progress`），agent 只填占位符。这是当前
   “agent 自写回”路径下最小修复；终态方案见下方 run-once 迁移立项。
3. **每 turn 新建 agent session**：codex 侧 host 用 `codex exec resume` 跨 turn
   复用同一会话（session binding 按 goal lineage 存 runtime），BitFun 侧
   每 turn 新建+丢弃导致 59KB 技能文档每轮重读、上下文/缓存全丢。修复：
   settlement 后按终态决策——Queued/WaitingForUser 保留 session（下一
   turn `reuse_session_id` 续会话，指针改“已加载，复用上下文”）；
   Completed/Recovery/Failed 丢弃；pause/abort/resume 路径同步清绑定，
   失效 session id 由端口自动回退新建会话。

同批修复：agent-onboard 包改在 register-agent 之后拉取（提前拉取时
`agent_id: null`，agent 会不信任自己的身份 flags）；环境边界 note 扩展两项
禁令（见下）。

### Skill 版本漂移防护（2026-09-08）与上游 issue #4082

本机 `~/.codex/skills` 存有另一版本 loopx 安装的 `loopx-*` 技能，而 pinned
sidecar 是 0.5.1；**安装出的技能树不带任何版本标记**（SKILL.md frontmatter
只有 name+description，readback manifest 只有 digest/installed_at），agent
加载时无从发现不匹配，session 复用后还会把漂移文档带进后续所有 turn。
环境边界 note 因此追加两条禁令：禁止加载 skill catalog / 用户级目录里的
`loopx-*` 条目（跨技能引用一律读 worktree 内 seed 的同名文件）；禁止执行
pinned 文档描述的安装/自更新流程（`loopx update`、install-*.ps1/sh）。已提
上游 https://github.com/huangruiteng/loopx/issues/4082（版本标记进
SKILL.md/readback）；上游修复并升级 pin 后，可回归官方 `workflow-skills
--install` 投递。另实测：v0.5.1 侧车 `workflow-skills --install --execute` 在
Windows 上因 `import fcntl` 崩溃（v0.5.2+ 已改用带 msvcrt 回退的
`file_lock.exclusive_file_lock`），本仓 seed 方案对该 pin 是必需的。

### 2026-09-08 pin 升级 v0.5.1 → v1.0.1（含 Node 运行时硬依赖）

- **Node.js ≥22.6 成为 sidecar 硬依赖**：v1.0.x 把协调状态、turn envelope、
  vision checkpoint 迁到 TS 效果运行时（`loopx/control_plane/**.ts`），sidecar 按需
  `node --experimental-strip-types` 拉起守护进程；干净环境实测 bootstrap 无 Node 直接
  失败（"LoopX Effect runtime requires Node.js 22.6.0 or newer"）。宿主不捆绑 Node
  （体积），握手期探测（`probe_node_runtime`，随 `LoopxCliManifest.node_runtime`
  返回）并作为**核心环境事实**展示；缺失→环境 Blocked + 安装指引。
  测试用 `LoopxCliAdapterConfig::probe_node_runtime=false` 保持密闭。
- **构建脚本**：`--add-data` 新增 control_plane 的 `.ts/.json` 子集（暂存目录方式，
  避免 .py 落数据区遮蔽冻结模块）；v1.0.1 无 TRADEMARKS.md，合规文件按 checkout
  实际内容动态暂存。sidecar 16MB（v0.5.1 同量级）。
- **兼容性结论（逐项实测 v1.0.1）**：BitFun 全部 argv/解析面兼容；schema 全部不变
  （turn_plan/envelope/workflow_plan packet/settlement identity v0+v1/vision v0/progress
  v0）；`register-agent` 新形态恰好等于 BitFun 现有 argv；refresh-state turn-scoped
  校验文案变了但语义等价（outcome_progress 仍算 accountable）；lineage 错误文案不变；
  vision 预算逐项一致；终局语义不变。冻结 exe 全链路（bootstrap→register→todo→
  turn plan→guard→refresh-state→spend→complete→history）实测通过。
- **新增降级识别**：guard 的 `turn_envelope_skipped`（TS 渲染拒绝时 CLI 不再崩溃，
  上游 #3687）→ 宿主显式报错并带原因，不再落到泛化 schema 错误。
- **pinned 资源已按 v1.0.1 再生成**：CLI help 全量；skill 文档仅 self-repair（+in_flight
  continuation 语义）与 pr-review 有内容变化，其余零变化。
- **v1.0.1 codex 对照基线**（2026-09-08，deepseek-v4-flash）：issue #2 真修复 7.6 分钟
  /204K tokens/58 exec，精确改 README +2 行，停在 owner gate，零外部写。BitFun 同
  issue 9.1 分钟——差距 1.5 分钟，主要来自宿主 per-turn 调度开销（inspect→build→settle
  各 ~30-60s），非 agent 执行差距。
- `workflow-skills --install` 在 v1.0.1 Windows 已可用（fcntl 修复），但 #4082
  （skill 版本标记）仍 OPEN，继续 seed 投递不变。

### run-once 迁移立项（未实施，终态方向）

v0.5.1 官方 `turn run-once --host generic-cli` 把 settlement 全部收归 loopx
自身（argv 校验、writeback/spend/scheduler 编程执行、typed
`loopx_turn_result_v0` 收敛、turn journal 幂等重放），agent 只需回一个
schema 约束的结果 JSON（stdin host request → stdout result）。这是根治
“agent 拼 CLI 命令”类浪费的结构解，也是 custom host 的官方姿势；代价是
需要 host-adapter 桥（stdin/stdout 驱动 agent）+ controller 核心循环重构。
前置条件见「当前能力边界」。升级 pinned 版本时一并评估。

### 标准答案复现手册：codex + loopx 跑同一 issue（2026-09-07 建立流程，2026-09-08 补 v1.0.1 基线）

在独立实验目录（本机为 `C:\codeagent\loopx-codex-lab-experiment`）按以下步骤可复现
"同一 issue 的 codex 标准答案"。**只读边界**：codex 侧一律不 push/不建 PR/不关
issue/GitHub 零触碰；lab-repo 每轮清理，改动为可丢弃。

1. 准备（一次性）：
   - `loopx-src` = pinned 源码 worktree（当前 v1.0.1；早期实验用 0.5.1，v0.5.1 的
     PyInstaller frozen 有 fcntl 缺陷但 v1.0.1 已修）；包装脚本
     `bin\loopx.cmd`=`python -c "import sys; sys.path.insert(0, r'<worktree>'); from loopx.entrypoint import main; main()"`。
     ⚠️ v1.0.1 需要 **Node.js ≥22.6** 在 PATH 上（TS 控制面运行时）。
   - `~/.codex/skills` 已有 loopx 系列技能（`loopx-project` 等；用任一 host 的
     `workflow-skills --install` 或直接拷贝 skills 目录）。
   - `~/.codex/config.toml`：任一可用 model provider（示例：DeepSeek——base_url
     https://api.deepseek.com/、wire_api="responses"、experimental_bearer_token=…）；
     `models.json` 含所选模型 id（示例 `deepseek-v4-flash`，context 1048576）。
     **模型可自由更换**——对照要求 BitFun 与 codex 侧使用**同一模型**才有同口径
     结论；换模型时按本文档第 4 节重新标定基线。gh 已登录 xielixing。
2. 每 issue 一次：
   - 清场：`git checkout .` + `git clean -fdq -e .gitignore` + 删 `.loopx/.codex`。
   - 生成引导包：`loopx start-goal --guided --project . --goal-id lab-repo-goal
     --goal-text "<issue 目标>" --host-surface codex-cli-tui --capability-route issue-fix
     > evidence\packet-issueN.txt`。
   - 组 prompt = packet + operator note（边界禁 push/PR/close；环境事实：source-run 0.5.1、
     sandbox 使 `~/.codex`/`.codex` 只读→必须本地化：`.loopx\registry.json` + `--runtime-root`
      + `--no-global-sync` + bootstrap `--state-file`、技能可读、勿反复环境检查）。
   - 跑：`codex exec <模型id> --sandbox danger-full-access --prompt <prompt文件>`
     （runner-issueN.ps1 包装；**坑 1**：`workspace-write` 沙箱在 Windows 下
     `CreateProcessAsUserW failed: 5` 拒绝所有命令——改用 `danger-full-access`
     并在 operator note 里显式写安全边界；**坑 2**：PowerShell 单引号字符串不
     插值——用 `-f` 生成脚本；**坑 3**：codex exec 需要 `.cmd` 后缀的完整路径）。
   - 产出：`evidence\codex-run-issueN.log`（含 session id、每步 exec、最终 summary 与
     tokens used）。
3. 记录口径（与 BitFun 对齐比较）：
   - **每 issue 独立 session**（session id 全不同）+ 独立清理克隆（与 BitFun 每任务独立
     worktree/goal/session 一致——BitFun 已对齐）。v1.0.1 实测 codex exec 单次 457s
     （issue #2 真修复），BitFun 同 issue 9.1 分钟。
   - 阶段拆分：bootstrap→register-agent→workflow-plan→feasibility→todo add/complete→
     refresh-state(vision)→quota should-run→terminal_no_followup；记录每阶段耗时与工具调用数。
   - **判定/收尾对照**：verdict 与 transition 是否一致；BitFun 侧对同一 issue 的
     rollout 事件、feasibility 记录、durable 写回是否同构；差异优先怀疑
     argv/路径/文档加载方式（2026-09-07 结论：判定一致；差异=common_runtime_root 默认
     共享路径、no_followup 必填参数、文档"注入 vs 读取"方式）。
4. 实测基线：
   - **v0.5.1**（2026-09-07，deepseek-v4-flash，exec 注入）：#1 no-op 12分17秒/230K tokens
     （冷跑）；#2 真修复 6分40秒；#3 认可 ~9分30秒；全程零 exit-1 循环、GitHub 零触碰。
   - **v1.0.1**（2026-09-08，deepseek-v4-flash，exec 注入 + danger-full-access）：
     #1 no-op **7分0秒/202K tokens/135 exec**（terminal_no_followup 干净关闭，零改动）；
     #2 真修复 **7分37秒/204K tokens/58 exec**，README +2 行精确修复，停在 owner
     gate（direction:action:publish_issue2_fix_pr），零 push/PR；#3 致谢
     **10分37秒/234K tokens/114 exec**（triage_only/no_followup 干净关闭，零改动）。
     全程 GitHub 零触碰、三 issue 全部成功。与 BitFun 对照：⚠️ 下述 BitFun 数字
     （#1 9.8min / #2 9.1min / #3 ~10.5min）来自 **v0.5.1 + codex-parity 修复批**
     的跑测（2026-09-08 下午），非 v1.0.1；v1.0.1 BitFun 验证待跑（sidecar 已重建
     为 v1.0.1，desktop 二进制已编译，待三 issue 完整验证后更新此表）。
   - ⚠️ exec 注入不是 loopx 官方 codex 路径（官方走 TUI + skill 发现 + heartbeat
     循环），但作为对照实验数据有效——packet 结构足够驱动完整 issue-fix 闭环。
   - 更换模型后需重新标定（记录模型 id + 耗时）。

### Sidecar 打包：frozen 环境的 skills 数据（2026-09-07 实测定论）

- BitFun 用 PyInstaller onefile 把 pinned loopx 打包为 sidecar，用户零安装。loopx 上游
  只对 pip/wheel 声明 `share/loopx/skills/**`（pyproject package-data）；PyInstaller
  只收 import 分析能看到的东西，**技能数据必须由 `build-loopx.mjs` 显式
  `--add-data "<src>\\skills;skills"` 打进解包根**。
- 目标目录是解包根下的 `skills`（不是 `share/loopx/skills`）：loopx
  `workflow_skill_install.resolve_workflow_skill_source()` 第一步检查
  `Path(__file__).parents[1]/skills`，冻结环境下 `parents[1]` 即 `sys._MEIPASS`。
  若 pinned 上游改动该布局，构建脚本注释与这里需同步更新。
- 未打包 skills 时的真实代价（实测）：两种宿主（BitFun、Codex）都只能靠
  `--help`/读源码反推 CLI → exit 1 振荡、收尾仪式拖沓（一次 no-op issue 的关闭
  花费约 11 分钟）；宿主侧补偿 = 每回合注入 pinned CLI 参考
  （`loopx-pinned-cli-reference.md`，从 pinned 源码 `--help` 生成）+ 环境边界 note。
- 结论：**不依赖上游**（上游 feature request 可作愿望单，不必保持开启）；frozen
  场景可本地完全闭环；文档里不要声称 exe 内 `workflow-skills --install` 不可用。

## 设计原则：单一事实源，非必要不新增（用户要求，不可违背）

新增任何功能、字段、按钮、面板之前，先确认现有实现是否已覆盖同一需求；能复用或派生的必须复用或派生。

- **同一事实只允许在一个位置表达和展示**。不同按钮实现相似功能、不同位置显示同一任务状态，
  必然产生联动同步负担，是 bug 的稳定来源：状态变化时两处必然失同步，或允许用户/模型在
  两处选出矛盾组合。
- **能从既有字段推导的信息不重复存储、不重复选择**，由消费端派生展示。新增字段前先过
  "能否从现有字段推导或合并"检查；推导关系存在的两个字段必须合并为一个枚举，
  支撑证据改为条件必填，由 schema 校验而非模型或用户自觉。
- 实例（结构化汇报模板设计中的教训）：并列的 `issue_verdict`（要不要修）与
  `upstream_status`（上游是否已修复）存在推导关系（"上游已修复"⟺"无需我方修复"），
  必须合并为单枚举 + 条件必填的 `fixed_by` 链接，而不是让模型在两个字段里各选一次。
- **人读字段禁止内部代号**。候选编号（C-1/C-2）、todo id、turn key、效果 id、字段名
  （durable_writeback 之类）不得出现在结论/进展/决策/下一步等给人读的字段里；必须展开为
  指代内容的普通句子（"在 dsh-plugin-desktop 内补兼容层"，而不是 "C-1"）。代号与机器
  收据只存在于折叠的技术回执和 artifacts 链接里。
- **可操作入口只保留一处**。批准/拒绝等按钮只存在于宿主投影的审批卡；汇报区严格只读，
  需要人决策时只做文字指引（"见上方审批面板"），不渲染第二个按钮。

## 最高优先级：快速反馈迭代（用户要求，不可违背）

1. **不要主动编译**：只有用户明确要求 agent 编译时，才进行构建/编译。被要求编译时，
   构建/编译一律放后台并行执行（background job），不要在等待期间空转；优先完成不依赖
   编译结果的独立工作。
2. **修改代码之后不运行测试或预检查**：默认不跑 `cargo test`、`pnpm test`、
   thin-client / 契约测试、`cargo check`、`pnpm run type-check:web` 等。只有用户
   **明确要求检查或测试**时才运行；用户只说“编译”代表直接产出可运行 exe，不包含预检查。
   - 允许的秒级自检：`node --check ui.js` / `node --check worker.js`、
     肉眼确认 JSON 合法、`git diff --check`。这些不是测试。
3. **改完尽快交付可见结果**：每次修改后，以最快路径让用户看到效果并等待反馈；
   但只有用户明确要求编译时，才执行以下编译与重启步骤：
   - 纯 UI（`index.html` / `style.css` / `ui.js`）：批量做完一轮修改 →
     `node --check` → 用户要求编译后再单次重新编译 Desktop 二进制 → 重启应用；
   - Rust 宿主行为：完成一批修改 → 用户要求编译后直接单次
     `cargo build -p openbitfun-desktop --bin openbitfun-desktop`（统一配方，见 README
     「统一构建配方」，勿混用不同 profile 环境变量）→ 重启应用。最终 build 本身就是
     Rust 编译验证，不要在它前面重复跑 `cargo check`。
4. **先收集反馈，再继续下一轮**：交付可见结果后停下，等用户反馈；不要自行
   连锁扩展改动范围（"快速迭代"≠"一次改很多"）。

## 分层最小动作（速查）

| 修改文件 | 用户要求编译前可做的最小动作 | 用户明确要求编译后（何时才编译 Desktop） |
|---|---|---|
| `index.html` / `style.css` / `ui.js` | 连续批量编辑；`node --check ui.js` | 单次重新编译 Desktop 二进制，然后重启应用 |
| `worker.js` | `node --check worker.js` | 重新编译并重启 Worker |
| `meta.json` / `esm_dependencies.json` | 检查 JSON 与权限差异 | 编译并 reseed |
| `src/crates/contracts/product-domains/src/miniapp/loopx/**` | 完成一轮修改，等待用户要求；不跑 Cargo 预检查 | 单次构建 Desktop binary，然后重启应用 |
| `src/crates/services/services-integrations/src/miniapp/loopx_*.rs` | 完成一轮修改，等待用户要求；不跑 Cargo 预检查 | 单次构建 Desktop binary，然后重启应用 |
| `src/crates/assembly/core/src/miniapp/loopx/**` | 完成一轮修改，等待用户要求；不跑 Cargo 预检查 | 单次构建 Desktop binary，然后重启应用 |
| `scripts/build-loopx.mjs` / LoopX pin | 不做动作，等待用户要求 | `pnpm run build:loopx`（只在用户要求且 sidecar/pin 变化时） |

> 编译总原则：上表只是「用户明确要求编译时的最小动作」，不代表 agent 可以自行触发编译；
> 默认只有用户明确要求 agent 编译时才编译。

注：宿主目录见 `src/crates/contracts/product-domains/src/miniapp/builtin/assets/bitfun-loopx` 的
上一级（`../../../../../..` 之外的 Rust 目录），完整说明在 `README.md`。

## 快速循环约定

- 通常保持 Web UI Vite 常驻（`pnpm --dir src/web-ui dev`，端口 1422），Frontend
  改动走 HMR；MiniApp 资源因 `include_str!` 内嵌，仍需编译才能进二进制。仅在下方
  Windows 低内存规则触发时临时暂停，构建结束后必须恢复。
- 2026-08-26 失败复盘：只重新编译并启动 `target/debug/openbitfun-desktop.exe`，但没有确认
  Web UI Vite 已恢复，会让 Desktop WebView 打开 `localhost` 后显示
  `ERR_CONNECTION_REFUSED`。启动或重启 Desktop 前必须确认 1422 已监听，并做一次 HTTP
  探测；若未监听，先后台启动 `pnpm --dir src/web-ui dev --host 127.0.0.1`，确认
  `http://127.0.0.1:1422/` 返回 200 后再启动 Desktop。
- 每次重新编译前**先停掉正在运行的 `openbitfun-desktop.exe`**，避免两个实例抢占
  同一个 AppData / reseed 目录。
- 启动直接用刚编译的 `target/debug/openbitfun-desktop.exe`（Vite 保持运行），
  **不要**用 `pnpm run desktop:dev` 反复启停做 UI 微调。
- 编译、启动一律放后台 job；新二进制会按内容哈希自动 reseed `compiled.html`。
- `src/web-ui/**` 改动由常驻 Vite HMR 直接生效；快速反馈流程不要追加
  `pnpm run type-check:web`，也不要因此重新编译 Rust。只有内嵌 MiniApp source 或 Rust
  发生变化时才需要 Desktop binary build。

## 编译影响面约束（写代码前执行）

1. **先判断 Cargo 影响链再编辑**：Rust 的增量单位主要是 crate，不是单个文件。修改
   `product-domains`、`services-integrations` 或 `openbitfun-core` 任一项都会让其下游重新编译；
   同一轮同时触及三者会形成 `contracts → services/core → desktop` 的大范围重编。编辑前
   必须列出准备触及的 crate，并确认每一层都是当前可见结果所必需。
2. **UI 问题不扩散到 Rust**：文案、布局、日志展示和交互只改内嵌 MiniApp source；
   `src/web-ui/**` 问题只改 Web UI 并走 Vite HMR。不要为了方便把纯展示逻辑放进 Rust，
   也不要因为 Web UI 改动重新编译 Desktop。
3. **LoopX 私有行为留在最窄 owner**：LoopX 专用投影、去抖、日志摘要和调度逻辑优先
   留在 `src/crates/assembly/core/src/miniapp/loopx/**`。不要顺手修改全局配置、共享事件、
   runtime、Cargo features 或 manifest；只有真实稳定合同属于下层 owner 时才向下修改，
   不得为编译速度破坏正确架构边界。
4. **主流程修复与非阻塞改进分轮**：当前问题能在一个 owner 内闭环时，不把 prompt
   润色、共享重构、通用清理或另一层的体验优化塞进同一次真机反馈 build。记录为下一轮，
   等用户看到主流程效果后再决定是否做。
5. **不制造无关源码变更**：不格式化未触及的 Rust 文件，不调整 Cargo.toml/features，
   不移动模块，不做与当前问题无关的重命名。Cargo 按内容哈希判断脏单元，任何共享源码
   变化都可能扩大下游重编。
6. **批量编辑，一次 binary build**：在不编译的状态下完成同一影响链的全部必要修改，
   秒级检查后只构建一次。不要为了逐文件确认而在中间启动 Cargo。
7. **构建前向用户说明预期影响面**：若不可避免地同时触及多个广泛 crate，编译前简短
   说明为什么无法保持局部，以及预计会重编哪些层。长期需要进一步提速时，应评审把
   LoopX Desktop wiring / embedded assets 从大 crate 拆到更窄的产品 owner；不要临时用
   错误依赖方向规避编译。

## Windows Desktop 编译防重跑规范（2026-08-26 失败复盘）

本机为 16 GB Windows。一次失败流程中，已有的不同 profile `cargo check` 长时间占锁，
随后另一条 `cargo test` 抢占同一 target；默认并发的正式 build 又多次在没有 Rust 诊断时
退出。实测单个 `openbitfun-core` `rustc` 工作集接近 5 GB。为避免等待、冷重编和内存峰值，
用户明确要求编译时必须遵守：

1. **编译前双重验锁**：先查看所有 `cargo` / `rustc` 的 PID、命令行和开始时间；已有
   Cargo 时不得再启动 check、test 或 build，也不得终止不属于当前任务的进程。等待其
   结束，并在正式 build 前立即复查一次，确认 target 无竞争者。
2. **极速反馈只运行最终 build**：用户要求“编译看效果”时，不运行 `cargo check`、
   `cargo test`、Web UI type-check 或任何前置构建。它们重复解析/编译依赖，却不产生用户
   要试用的 exe。若用户另外明确要求某个检查，该检查也必须与 README 统一配方同指纹
   （仓库 `[profile.dev]` 基线，不设置任何 `CARGO_PROFILE_DEV_*` 覆盖），禁止引入
   profile 覆盖污染增量指纹。
3. **本机强制单并发**：设置 `CARGO_BUILD_JOBS=1`。该变量只限制
   同时运行的 rustc 数量，不改变 Cargo 指纹；不要用默认并发或 `-j 2` 反复碰内存
   上限。统一命令为（仓库 `[profile.dev]` 基线指纹，无任何 profile 环境变量）：

   ```powershell
   $env:CARGO_BUILD_JOBS = "1"
   cargo build -p openbitfun-desktop --bin openbitfun-desktop
   ```

   指定 `--bin openbitfun-desktop` 用于明确只请求 Desktop binary target，但当前 package 的
   binary 依赖同包 lib，而 `[lib]` 同时声明 `staticlib`、`cdylib`、`rlib`；Cargo 仍会
   在一次 lib rustc 中生成三种 crate-type，并链接约 30 MB 的
   `openbitfun_desktop_lib.dll`。不要宣称 `--bin` 已省掉该阶段。真正移除它需要把移动端/FFI
   wrapper 与 Desktop 使用的 rlib 拆成不同 package/target，必须作为独立架构改动评审。

   构建前同时检查系统可用提交空间；低于 2 GB，或单个 rustc 运行期间降到 1 GB 左右时，
   可以临时停止**仅属于本仓库**的 Vite 进程链，构建结束后用原命令恢复。2026-08-26
   实测暂停 Vite 将可用提交空间从约 650 MB 恢复到约 1.8 GB，使最终链接完成。不得为
   编译关闭其他用户应用、Codex 进程或无关服务。

4. **只保留一个可追踪的后台 build**：记录后台 job/session、构建开始时间和输出日志，
   持续轮询同一个句柄直到退出；不得因为暂时没有输出而重复启动。正常构建不要用
   `-vv`，只有无诊断退出时才用它定位最后一个 rustc 命令。
5. **成功必须有四项证据**：Cargo 退出码为 0；输出含 `Finished`；
   `target/debug/openbitfun-desktop.exe` 的 `LastWriteTime` 晚于本次构建触及的所有
   Rust/内嵌源文件（指纹未变化时 Cargo 允许不重链，此时以 exe 晚于全部源文件
   mtime 为准）；Cargo/rustc 已全部退出。缺一项都视为构建失败，不得启动旧 exe
   冒充新版本。
6. **启动前后都核对进程**：build 前停止全部 `openbitfun-desktop.exe` 并确认已经退出，
   防止最终链接或 AppData reseed 冲突；仅在上述成功证据齐全后后台启动新 exe，再核对
   进程 `StartTime` 与路径。构建期间若 Desktop 被其他入口重新拉起，先停掉它再等待链接。
7. **失败先诊断，不盲目重跑**：先检查日志尾部、竞争 Cargo 命令、exe 时间戳和系统
   可用内存。无 `error:` / 无 `Finished` 且 exe 时间戳未变，说明没有产出新应用；不要
   宣称编译成功，也不要继续运行旧二进制。测试仍只在用户明确要求时运行。
8. **2026-08-26 极速反馈复盘**：一次主流程修复在最终 build 前运行了两个
   `cargo check`，之后又运行 Web UI type-check；它们分别额外消耗约 1 分 44 秒和
   1 分 50 秒，且没有让用户更早看到效果。后续把所有修改集中完成后只运行一次
   `cargo build -p openbitfun-desktop --bin openbitfun-desktop`。运行中新发现的纯 Web UI 问题
   走 Vite HMR 修复，不再触发第二次 Rust build。

9. **2026-09-02 “全部已中止”复盘（跨版本数据根冲突 + 注意力契约）**：LoopX 任务
   集体进入 recovery，错误为 `Agent coordination database schema 2 is newer than
   supported schema 1`。根因不是 LoopX 工作流，而是**数据根跨构建共享**：
   `coordination.sqlite` 位于 `BITFUN_USER_ROOT`（默认 `%APPDATA%/bitfun/`），
   安装版 / worktree 构建 / dev 构建全部写同一个库；带 swarm 表的新构建把它升到
   schema 2，只认 schema 1 的 dev 构建按设计拒绝打开，于是每个 LoopX 回合创建
   Agent 会话都失败。修复必须做在结构上而不是 case 上：
   - dev 启动（`scripts/dev.cjs`）已设置独立 `BITFUN_USER_ROOT`
     （`%APPDATA%/com.bitfun.desktop.dev/bitfun`），跨构建 schema 冲突从此结构性
     不可能；diagnose “已中止/恢复”类问题第一步永远是
     `PRAGMA user_version` + 任务快照的 `task.error`。
   - `apply_goal_projection` 在权威 Goal 投影恢复健康（非 recovery/failed）时清除
     陈旧 `task.error`，避免旧环境错误挂在已恢复任务上误导排查。
   - **注意力契约**：人类注意力是稀缺资源。无头 agent 会话（sessionKind
     'miniapp'）的每轮完成永不发系统通知（`dialogCompletionNotifyPolicy` 显式
     排除）；OS 通知只在 owner 决策点发出（user gate 出现时经
     `notifications.system`）。不要用命令黑名单去拦 Agent 的弹窗能力，也不要在
     宿主侧发明停滞/回合数启发式门禁——钻牛角尖防护复用 LoopX 自有机制
     （stall observation → autonomous replan obligation → 持续卡住 pause；
     agent 主动 user_gate），外部写入（创建 PR）保持天然 owner 审批。

10. **2026-09-02 envelope 超预算复盘（升级 loopx 版本不解决）**：turn plan 返回
   `route=contract_error`（`turn_envelope.compaction.within_budget=false`）时，
   Goal 无法被计划，且 **v0.5.1 / v0.5.2 / v0.5.3 / main 行为完全一致**——实测
   同一 goal 在全部版本下 envelope 均超 8192 字节预算（8279/8192，仅超 87 字节，
   源 46KB）。压缩增强（#2190 text_ref 去重）已在 pin 内仍不够；
   `todo archive-completed` 不影响 envelope。宿主正确姿势是**响亮降级**：
   `LoopxCliGoalSnapshot.envelope_over_budget` → Queued + 诊断事件 + 退避重试，
   绝不 fail 进 recovery 死循环。立即解套手段：`todo update --text` 精简超长
   todo 文本（实测 8279→7762，回到预算内）。根治需上游：提高 envelope 预算、
   渐进截断 recommended_action/suggested_actions 长文本、或提供 goal compact
   自愈命令（loopx 仓库议题）。


## 禁止事项

- 不要主动编译：用户没有明确要求时，不执行 `cargo check`、`cargo build`、
  `pnpm run build:loopx` 等任何构建/编译动作。
- 用户只要求“编译看效果”时，不要自行追加 `cargo check`、`pnpm run type-check:web`
  或测试；最终 binary build 是唯一允许的编译动作。
- 不要在每次代码改动后主动跑测试套件（见上）。
- 不要直接修改 `%APPDATA%/bitfun/data/miniapps/builtin-bitfun-loopx/**` 当源码。
- 不要用 `git add .` 或把运行目录/生成物（`compiled.html`、`~/.bitfun/bitfun-loopx/**`）提交。

