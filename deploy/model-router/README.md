# OpenBitFun Model Router 客户端

本目录包含固定的 Router 系统提示词和可移植的 OpenBitFun 启动脚本。启动脚本负责让
OpenBitFun 连接已经运行的 OpenAI-compatible Router 服务，不会在客户端或评测机器上
启动 vLLM。

## 目录内容

- `router_system_prompt.txt`：OpenBitFun 在每个主 Agent round 开始前发送给 Router 的
  固定系统提示词。
- `run_openbitfun_with_router.sh`：配置 Router 客户端环境变量，然后完整启动 OpenBitFun；不传
  参数时进入原有交互模式，传入参数时则原样转发。

## 编译 OpenBitFun

在 OpenBitFun 仓库根目录执行：

```bash
cargo build --locked -p openbitfun-cli --bin openbitfun
```

启动脚本默认使用 `target/debug/openbitfun`。如果使用 release 构建或复制到其他位置的
二进制文件，请通过 `OPENBITFUN_BIN` 指定路径。

## 连接远程 Router

通过环境变量传入 Router API URL；只有 Router 要求鉴权时才设置 API key：

```bash
export ROUTER_API_URL='http://<router-host>:<port>/v1'
# export ROUTER_API_KEY='<仅在需要鉴权时填写>'
```

然后进入需要 OpenBitFun 操作的目标代码仓库，直接启动完整的交互式 OpenBitFun：

```bash
/path/to/OpenBitFun/deploy/model-router/run_openbitfun_with_router.sh
```

脚本没有改变 OpenBitFun 的运行模式，只是在启动前注入 Router 配置。进入交互界面后可以
像原版 OpenBitFun 一样连续对话，每个主 Agent round 都会自动调用 Router。

需要执行单个非交互任务时，才传入 OpenBitFun CLI 的 `exec` 参数：

```bash
/path/to/OpenBitFun/deploy/model-router/run_openbitfun_with_router.sh \
  exec '真实任务描述'
```

下列参数均属于 OpenBitFun CLI，而不是 Router 参数，并且都由用户按需添加：

- `-v`：输出更详细的 OpenBitFun 执行日志，主要用于调试；批量评测时可以去掉。
- `exec`：以非交互任务模式运行 OpenBitFun。
- `--output-format json`：可选；仅当外部程序明确需要解析 OpenBitFun 的 JSON 输出时使用。

Router 的单行 JSON 输出由 OpenBitFun 内部请求和 `router_system_prompt.txt` 控制，与上述
三个 CLI 参数无关。

## Router 服务兼容要求

阈值路由除了标准的 `chat/completions` 内容外，还依赖 vLLM 提供的 `logprobs`、
`top_logprobs`、`return_token_ids` 和 `return_tokens_as_token_ids` 扩展字段。当前
`simple` / `non_simple` 的 token ID 与 `router-best` 使用的 tokenizer 绑定；更换
Router 模型或 tokenizer 后，需要先核对这两个 token ID。服务不返回完整置信度数据时，
OpenBitFun 会保守地选择主力模型。

默认 Router 客户端配置如下：

```text
Router 模型：       router-best
最近轨迹轮数：      3
配置输入上限：      65536 tokens（与服务窗口同步，实际会扣除固定内容）
服务上下文窗口：    65536 tokens
Simple 阈值：       0.75
请求超时：          10000 ms
Fast 增量摘要：     开启；离开最近窗口的内容累计达到 8192 tokens
历史摘要目标：      约 4096 tokens 以内（正文目标，不包含推理）
摘要生成上限：      16384 tokens（推理与正文合计）
摘要推理档位：      auto（可独立指定 fast 模型支持的 preset）
摘要请求超时：      120000 ms
```

可以通过 `ROUTER_MODEL`、`ROUTER_RECENT_ROUNDS`、`ROUTER_MAX_INPUT_TOKENS`、
`ROUTER_CONTEXT_WINDOW`、`ROUTER_SIMPLE_THRESHOLD`、`ROUTER_TIMEOUT_MS`、
`ROUTER_SUMMARY_ENABLED`、`ROUTER_SUMMARY_TRIGGER_TOKENS`、
`ROUTER_SUMMARY_MAX_TOKENS`、`ROUTER_SUMMARY_TARGET_TOKENS`、
`ROUTER_SUMMARY_REASONING_PRESET` 和 `ROUTER_SUMMARY_TIMEOUT_MS` 覆盖这些默认值。
未指定正文目标时取生成上限的一半与 4096 的较小值，以兼容已有的较小生成上限；显式目标
必须为正数且不大于生成上限。直接运行宿主时使用相应的 `OPENBITFUN_ROUND_ROUTER_*` 变量。

这些默认值来自当前训练数据和配置，而不是模型理论窗口：固定 system prompt 为 1580
tokens，数据中 user prompt 最大 26517 tokens，完整 chat 输入最大 28110 tokens，SFT
`max_length` 为 28672。线上 vLLM 的 `--max-model-len` 与 BitFun 配置上限均设为 65536；
BitFun 会从中扣除固定 system prompt、128 个输出 tokens 和 256 个 chat-template 预留，
所得值才是动态 user prompt 的实际兜底上限。通常输入远低于该值，不会为了上限进行补齐。

## Router 专用增量上下文

每个主 Agent logical round 开始前，运行时从消息中只读收集尚未见过的增量，固定组成
`## Task`、`## Earlier history summary`、`## Recent trajectory` 三段。Task 包含当前任务及
最新用户纠偏；最近 3 轮包含 assistant 文本/推理、工具名/参数/结果和错误标记，最新一轮
优先保留细节。后台结果、用户 steering、失败恢复反馈也作为独立观察保留。大字符串按
预算保留头尾并标记省略，工具结果优先使用实际提供给 Agent 的版本，不发送图片二进制。
超过 64KiB 的大字符串先做带标记的头尾投影，避免在路由边界反复 tokenize 整份大日志。

Router 有自己的去重游标、待摘要增量和历史摘要；不读取主 Agent 的 compression summary，
不调用主 Agent 压缩器，不改主消息、主压缩配置或主压缩触发条件。

每条观察先完成与 Router 输入一致的确定性预处理，再由 Router 自己的 tokenizer 计算并
保存 token 数。离开最近 3 轮的旧轨迹累计达到 8192 tokens 后，用配置中的 **fast** 模型
发起一次独立、无工具的后台摘要请求。摘要基于旧 Router 摘要和本次旧轨迹快照，提示 fast
模型将新摘要控制在约 4096 tokens，并单独预留推理空间，默认生成上限为 16384 tokens。
不能把正文目标直接当作推理模型的整个生成预算。压缩触发只累计 pending
history，不计算也不持久化 summary 的 tokens。
摘要尚未完成时直接使用旧摘要加待处理增量，不等待模型返回。每个执行代最多一个摘要请求，
每个进程最多两个；容量不足时不排队。摘要失败、超时、fast 未配置或返回空/截断内容时
保留原状态；同一 Router round 内不会循环重试，下一轮会重新压缩现有的 summary + pending，
不需要再累计 8192 个新 tokens，也不回退到主力模型做摘要。摘要请求使用 fast
本身的 provider 和采样配置，不套用主 Agent 的 reasoning preset。可通过
`OPENBITFUN_ROUND_ROUTER_SUMMARY_REASONING_PRESET=low` 给摘要单独选择已支持的推理档位；
未设置或 `auto` 时保留模型默认。显式选择不可用时摘要失败并保留历史，不静默退回默认档位。
推理设置通过已有 provider adapter 编译，并与输出预算一起只作用于私有 client 副本，
不修改 fast 主请求、subagent 或模型配置文件。provider 自定义 request body 仍按既有规则
处理，因此不要在其中设置与摘要生成上限冲突的输出长度字段。

增量缓冲最多 128 条，持续失败时超出的最老记录带明确省略游标；这是 Router 的内存预算，
不是限制主 Agent 的轮数。成功摘要只覆盖请求时的序号，新到达的观察不会被删除；执行结束
或取消会终止未完成的辅助请求。开启原有会话持久化时，在执行宿主的会话 request-traces
目录单独保存 `router-context-<turn-id-sha256>.json`，供同一 turn 恢复。没有 sidecar 的旧会话
从现存原始轨迹重新积累，不拿主压缩摘要补齐缺失历史；不可读或新版本 sidecar 保留不覆盖。

正常轮次中，摘要请求和 checkpoint 落盘均在后台；同步路径只做本地增量收集、裁剪和快照
拼装。落盘使用单个 writer 合并待写快照，并通过文件锁和序号检查阻止旧执行代覆盖新状态。
只有 turn 初始化恢复和任务结束刷盘最多等待 500ms，不会每轮等待磁盘。Router 分类请求
本身仍然需要等待返回，才能决定本轮模型；这与准备历史摘要的辅助请求不同。

### 准确 token 预算

BitFun 不在 Git 仓库或二进制中内嵌 tokenizer。编译不需要该资源；运行前只需将当前
`router-best` 对应的 `tokenizer.json` 下载到 `deploy/model-router/tokenizer.json`。启动脚本
会把该路径传给 `OPENBITFUN_ROUND_ROUTER_TOKENIZER_PATH`；也可以通过
`ROUTER_TOKENIZER_PATH=/absolute/path/tokenizer.json` 覆盖。直接启动 CLI 或 Desktop 时必须
显式设置 `OPENBITFUN_ROUND_ROUTER_TOKENIZER_PATH`。无需下载模型权重，但 tokenizer 必须与
服务端 Router 模型一致，否则 token 预算会失真。当前文件的 SHA-256 应为
`aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4`。预算会单独预留固定
system prompt、128 输出 tokens 和 256 模板 tokens。

CLI 与 Desktop 共用此 Core 路径；无需分别实现压缩。在不经启动脚本的 Desktop/CLI 宿主上，
使用对应的 `OPENBITFUN_ROUND_ROUTER_*` 环境变量（例如 `..._MAX_INPUT_TOKENS`、
`..._SUMMARY_TRIGGER_TOKENS`）。远程工作区、远程控制、Peer 或 Detached Dispatch 均由
**真正执行 turn 的宿主**准备
Router 上下文并访问 Router/fast API。这里是宿主侧实现约束；各远程场景仍需部署后的端到端
smoke 验证。

评测程序只需传入真实任务描述，不要逐轮自行构造 Router 输入。`ROUTER_TRACE_PATH` 的每条
`router_decision` 会记录 Router 输入预算/计数方式/准备耗时/增量游标、pending 总 tokens、
每条 pending/recent entry 的 sequence、round ID、类型、token 数和错误标记，以及本轮观察到的
压缩状态。压缩记录包含 `in_flight`、`applied`、`failed`、`incomplete` 或 `stale` 状态及其
快照边界、pending tokens、延迟、usage 和错误。单独的 `router_context_summary` 事件仍然保留，
便于不依赖 Router 决策频率审计摘要请求。这部分是额外模型开销，不混入主轮次 Token Usage，
评测时应单独汇总。摘要事件还记录配置的生成上限、正文目标、请求和实际选中的推理 preset，
以及 `response.finish_reason`、`text_chars`、`reasoning_chars`、`tool_call_count` 和
`incomplete_reason`。后者区分 `output_limit`、`empty_text` 与 `tool_calls`；诊断字段不保存
推理正文。`usage.reasoningTokenCount` 只在 provider 确实返回时记录，不用字符数伪造 token 数。
未返回 usage 的请求保持缺失，不能按零计费。可设 `ROUTER_SUMMARY_ENABLED=false` 对照纯规则
裁剪版本；固定 Router system prompt 和 `simple/non_simple` 决策协议不变。

## 数据与安全

Router 与 fast 摘要请求可能包含任务原文、历史摘要、推理文本、工具参数和工具结果，因此只应
使用受信任的服务。启用 Router 也默认启用上述 fast 辅助调用；可单独关闭。sidecar 保存独立
摘要与裁剪后的增量；启用 `ROUTER_TRACE_PATH` 后，本地 trace 也会记录完整 Router 输入和输出；
评测结束后请按数据敏感级别妥善保管或清理该文件。
