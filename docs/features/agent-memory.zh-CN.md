# Agent 记忆系统

OpenBitFun 的记忆系统会把已完成的本机会话沉淀成一个可长期复用的文件式记忆目录，
供后续会话读取。它是一个两阶段流水线：phase 1 逐会话抽取记忆，phase 2 把它们
合并成少量手册文件。

记忆是**主机本地**的：它在运行 Agent 的那台机器上产生和消费，不会在设备之间同步。

## 记忆存放位置

| 内容 | 路径 |
| --- | --- |
| 记忆工作区（git 跟踪） | `<openbitfun home>/.openbitfun/memories/` |
| Phase 1/2 数据库（SQLite） | `<用户数据目录>/memories/memories.sqlite` |

工作区是一个真实 git 仓库，由 OpenBitFun 自行初始化和重建基线。它只是 diff 的记账
手段，不是面向用户的仓库：用户不会在其中提交或推送。

## 工作区结构

```
MEMORY.md                  合并后的手册，grep 入口
memory_summary.md          注入提示词的摘要，首行必须为 `v1`
raw_memories.md            当前所选 phase-1 输出的机械合并
rollout_summaries/*.md     MEMORY.md 引用的逐 rollout 证据
skills/<name>/SKILL.md     可复用流程（可选）
extensions/<name>/         扩展输入，包含 ad-hoc 用户笔记
  ad_hoc/instructions.md   ad-hoc 扩展的种子说明
  ad_hoc/notes/*.md        用户主动写入的记忆笔记
```

## 流水线

### Phase 1：逐会话抽取

`MemoryPhase1Service` 扫描本地工作区，找出最后完成时间早于
`min_rollout_idle_hours` 的会话，逐个认领，渲染该会话已持久化的轮次，并向抽取
模型请求 raw memory、rollout summary 和 rollout slug。抽取成功的结果写入
`stage1_outputs` 表，`source_updated_at` 水位等于该会话最后一次完成轮次的时间。

以下会话会被跳过：已归档、`memory_mode` 不为 `Enabled`、没有完成轮次、轮次少于
两个，或还不够空闲。年龄门槛（`max_rollout_age_days`）最后判定，且每轮会输出一
条聚合日志，报告被年龄门槛丢弃的会话数以及其中从未抽取过的数量。

抽取失败会消耗三次尝试预算。预算耗尽后会话进入 24 小时隔离期；隔离期结束后预算
恢复一次，因此临时性服务商故障不会永久卡死一个会话。

### Phase 2：合并

`MemoryPhase2Runner` 持有唯一的全局任务（`memory_consolidate_global`）。一次运行：

1. 检查配置开关和重试退避；
2. 认领任务（租约 + 心跳）；
3. 准备工作区（写入 ad-hoc 扩展种子、确保 git 基线）；
4. 载入 phase-2 输入候选，并按 `max_raw_memories_for_consolidation` 选出已启用
   的行；
5. 依据当前选择集重建 `raw_memories.md` 与 rollout summaries，并清理数据库行已
   消失的 summary 文件；
6. 计算工作区相对上次成功基线的 git diff；
7. 只有在存在真实工作时才运行内部 `MemoryPhase2` Agent。

只要输入状态可被推导，就会执行输入重建：存在候选、仍存在 stage-1 行，或工作区仍
残留已渲染的输入。因此**启用集合为空**时也会把被取消选中的会话从
`raw_memories.md` 中移除，使被禁用或被污染（polluted）的会话在同一次运行中就被
遗忘，而不必等下一次选择集变化。该重建不会删除 summary 文件，因为保留集合是全部
存活的 stage-1 行。

工作区 diff 是"遗忘"的依据。diff 只覆盖已跟踪和未跟踪的内容文件。被 gitignore 的
路径永远不进入 diff，OpenBitFun 自身的工具状态（`.openbitfun/` 以及旧版 `.bitfun/` 目录名）无论主机
是否忽略它都会被排除，因此写入记忆目录的本地搜索索引既不会让未变更的工作区看起来
"有改动"，也不会把工具状态泄漏进提示词。

**与上游记忆设计的差异：** 上游同样会把被忽略的路径纳入 diff，并为每个路径渲染一份
新增文件补丁。本移植有意把它们排除在 diff 之外：这是记忆端到端测试验证过的行为，
也避免了用户级或全局 ignore 规则变化时整个工作区 diff 发生抖动。其代价是明确的：
位于记忆目录内、被用户级或全局 gitignore 规则匹配的记忆文件**不会**被合并，因此
记忆文件必须保持不被忽略。每次 diff 计算都会记录一次被跳过的路径（数量 + 有上限的
样本），让这一差异可见而不是静默发生。

当改动涉及 `MEMORY.md`、`memory_summary.md`、`raw_memories.md`、
`rollout_summaries/**`、`skills/**` 或 `extensions/**` 的内容文件时，该改动是
**有意义的**。仅重新写入 `extensions/ad_hoc/instructions.md`，以及生成的
`phase2_workspace_diff.md`，都不算有意义。

### 调度与冷却语义

成功冷却（`phase2_success_cooldown_seconds`，默认 6 小时）在候选载入与工作区 diff
**之后**判定，且只抑制确实无事可做的运行：

- 存在新的 phase-1 输入 → 绕过冷却；
- 存在有意义的工作区改动（例如新增 ad-hoc 笔记，或某个会话退出了选择集）→ 绕过
  冷却；
- 两者都没有 → 以 idle 方式释放任务并直接返回，不调用模型。

"新鲜度"比较的是任务的**已评估输入时钟**（`input_watermark`，即本流水线已经计入
过的最新候选水位），而不是上次成功合并的水位。每次完成的运行（idle 或真正合并）
都会记录它评估过的最新候选，因此一个始终未被选中的候选（例如记忆被禁用的会话）
无法永久压制冷却。没有有意义改动的运行不会调用 LLM，并记录 "No memory workspace
changes to consolidate."。

重试退避（`phase2_retry_delay_seconds`）仍是硬门槛，在认领之前判定。

### 归属、租约与无人值守的合并轮次

全局任务以 ownership token 认领，并持有租约（`phase2_lease_seconds`，默认 1 小时），
持有者每 30 秒心跳刷新租约。存活判断依据**剩余租约**：只有当现任持有者的租约比
`phase2_lease_seconds - 120 秒` 更新时，新的认领才会被拒绝（`SkippedRunning`）——
这正是刚刚心跳过的存活持有者的形态。合并中途进程死亡或被杀的运行不再刷新租约，
其剩余租约会在约两分钟内跌破该窗口，下一次认领即可接管任务，而不必等满整个租约。
ownership token 的比较交换语义不变，该规则对运行旧版本但同样每 30 秒刷新租约的
存活持有者依然成立。

该窗口的前提是现任持有者按当前配置的租约长度认领，因此在运行进行中调大
`phase2_lease_seconds` 可能让仍在心跳的运行被判定为过期；ownership token 仍保证
只有一个运行能完成任务。

合并轮次以内部 `MemoryPhase2` agent 运行在 `emit_lifecycle_events = false` 的临时子
会话上，因此没有任何界面能为它回答交互式权限询问。该轮次因此请求
`permission_mode = auto_approve`，在进程内直接应答工作区根目录内的
`Write`/`Edit` 询问；agent 的工具白名单与工作区路径根仍然限制它可触碰的范围。
auto_approve 只是权限模式，不是沙箱：在该模式下项目敏感标记（sensitive marker）
检查被跳过，原生 hook 在本轮次看到 `bypass_permissions: true`。否则一次根目录内
写入会等待无人应答的信箱，使任务一直停留在 `running` 直到租约过期。未能干净结束
的轮次（`PartialTimeout`）只记录一条 warn 日志，保留工作区基线与待处理 diff，并
在下一轮次重新提供，而不会被当作一次干净的合并上报。

### 保留策略与遗忘闭环

`max_unused_days`（默认 30，且下限为 1 天，因此误配置的 0 不会立即删除有效输入）
是所有 stage-1 行共用的唯一保留时钟。phase-2 选中状态不是豁免：**超过
`max_unused_days` 未被使用的行会被删除**（无论是否曾被选中），依赖它合并出的
`MEMORY.md` 内容会在下一次合并中被移除：

```
行被清理 -> 下一次同步时删除对应的 rollout summary 文件
        -> 删除出现在工作区 diff 中
        -> phase 2 移除依赖它的记忆内容
```

使用时钟（`last_usage`）会在所有解析到具体行的记忆读取上推进：记忆引用
（citation）、`MemoryFetch` 读取以及 `MemorySearch` 命中。

失败记录有自己的过期时钟：失败时间早于 `max_failure_report_days` 的 stage-1 失败行
会被删除，因此重试次数已用尽的死路（例如模型已下线）不会永久停留在失败列表中。该
清理在启动流程中执行，也会在每次手动运行之前执行，且都排在 phase-1 认领之前，所以
过期行在被 24 小时隔离重排逻辑重新考虑之前就已消失。只有按会话记录的 stage-1
`error` 行会过期：全局 phase-2 任务保留其 `last_error` 作为当次运行的诊断信息，
`stage1_outputs` 不会被触碰，因此不会丢失任何已抽取的记忆。

只有当数据库行消失时才会删除 rollout summary 文件。仍然存在、只是落在当前选择集
之外的行会保留其 summary 文件，因此 `MEMORY.md` 仍引用的证据不会被销毁。

phase-2 提示词要求"删除"而不是"标注"：被删除的输入必须从 `MEMORY.md` 和
`memory_summary.md` 中移除，`[summary not in store]` 之类的占位符不是可接受的终
态，证据被完全删除的任务组会被整组删除。若某次 diff 中删除的 summary 与新增的
summary 共享同一 `<时间戳>-<4位哈希>` 前缀，则说明同一会话只是改名：提示词会把引
用重新指向新文件名，而不是遗忘其内容。

## 读取路径

当 `use_memories` 启用且会话运行在本地工作区时，`memory_summary.md` 的内容会和
读取路径提醒一起注入提示词；提醒中说明了目录结构、快速记忆检索流程以及引用约定。
如果读取了注入摘要之外的任何记忆文件，模型必须在回复的最后附加一个
`<openbitfun-mem-citation>` 块。

## 记忆工具

会话可能暴露三个内置记忆工具：

| 工具 | 用途 |
| --- | --- |
| `MemorySearch` | 搜索记忆条目，无需对文件系统做原始搜索。 |
| `MemoryFetch` | 读取单个记忆文件，并自动记录使用统计。 |
| `MemorySave` | 在用户明确要求时写入 ad-hoc 记忆笔记。 |

读取路径提醒会要求模型优先使用这些工具，而不是对记忆目录使用 `Grep`/`Read`。
`MemoryFetch` 会自行记录使用情况；直接读取文件仍然需要 `<openbitfun-mem-citation>`
块。

## 配置

记忆配置位于 `<用户配置目录>/config/app.json` 顶层的 `memories` 段：

```json
{
  "memories": {
    "generate_memories": true,
    "use_memories": true
  }
}
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `generate_memories` | `false` | 启用 phase 1 抽取与 phase 2 合并。 |
| `generate_for_btw_sessions` | `false` | 允许持久化的 BTW 会话成为记忆来源。 |
| `use_memories` | `false` | 将记忆摘要与读取路径注入提示词。 |
| `external_context_policy` | `clear_tool_results` | 对使用过外部上下文工具的会话取 `clear_tool_results`、`allow` 或 `skip_session`。 |
| `max_raw_memories_for_consolidation` | `64` | 每次 phase-2 最多选择的 stage-1 行数（上限 4096）。 |
| `max_unused_days` | `30` | stage-1 行的保留窗口；超过该时长未使用的行会被删除，其记忆内容随之被遗忘（下限 1、上限 365）。 |
| `max_rollout_age_days` | `10` | phase 1 仍会考虑的最旧来源会话（上限 365）。 |
| `max_failure_report_days` | `14` | stage-1 抽取失败记录的报告窗口；更旧的失败记录会被删除（下限 1、上限 90）。 |
| `max_rollouts_per_startup` | `2` | 每次启动流程最多认领的来源会话数。 |
| `max_rollouts_scan_limit` | `2000` | 每次启动流程最多扫描的来源会话数。 |
| `min_rollout_idle_hours` | `6` | 会话可被抽取前的最小空闲时间。 |
| `phase1_max_concurrency` | `1` | 并发 phase-1 抽取任务数。 |
| `phase1_retry_backoff_minutes` | `60` | phase-1 抽取失败后的退避。 |
| `phase1_lease_seconds` | `3600` | phase-1 认领租约。 |
| `phase2_lease_seconds` | `3600` | 全局 phase-2 任务租约。 |
| `phase2_success_cooldown_seconds` | `21600` | 成功合并后的空跑保护窗口。 |
| `phase2_retry_delay_seconds` | `3600` | 合并失败后的重试延迟。 |
| `extract_model` | 未设置 | phase 1 的模型选择器，缺省回落到主模型。 |
| `consolidation_model` | 未设置 | phase 2 的模型选择器，缺省回落到主模型。 |

## 公开 API

```rust
impl MemoryPhase1Service {
    /// 按需为单个会话执行 phase-1 抽取。绕过扫描、空闲、年龄、轮次数和当前会话
    /// 排除门槛，但仍然遵守 `generate_memories`、会话的 `memory_mode == Enabled`
    /// 以及认领/水位语义（已是最新的会话返回 Ok 且统计为 skipped）。
    pub async fn run_once_for_session(
        &self,
        workspace_path: &str,
        session_id: &str,
    ) -> OpenBitFunResult<MemoryPhase1RunStats>;
}

impl MemoryDatabase {
    /// 只读的流水线状态：stage-1 计数、待提升数量、失败抽取以及 phase-2 任务状态。
    pub async fn status_snapshot(&self) -> OpenBitFunResult<MemoryStatusSnapshot>;

    /// 按 rollout/session id 或 rollout summary 文件名更新 stage-1 行的
    /// usage_count / last_usage，返回被更新的行数。
    pub async fn record_memory_usage(
        &self,
        rollout_ids: &[String],
        summary_file_names: &[String],
    ) -> OpenBitFunResult<u64>;
}
```

## 远程场景

| 场景 | 行为 |
| --- | --- |
| 远程工作区 | phase 1 跳过远程工作区：只扫描本地会话根目录，记忆目录是主机本地的。 |
| 远程控制（移动端 Web、IM 机器人） | 记忆配置与读取路径不变；记忆目录仍留在拥有该会话的主机上。 |
| 对等设备模式（Peer Device Mode） | 记忆目录属于运行会话的主机，对等代理不会搬运它。 |
| 分离式派发（Detached Dispatch） | 目标主机拥有任务及其记忆目录；控制端不会代为读写记忆。 |

记忆启动流程不会为远程工作区、没有用户输入的会话，以及子智能体和临时子会话调度。
