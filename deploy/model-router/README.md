# OpenBitFun Model Router 客户端

**当前发布状态：暂未开放智能模式。** main 保留客户端实现，但 GUI、会话更新接口和执行循环均关闭自动路由。
已有模型配置、会话标记与摘要不会被删除；手动会话不调用 Router，也不准备 Router 摘要。
下文的环境变量和启动脚本不能绕过发布闸门，当前不用于开启 main 的智能模式。
Router 服务本身仍可独立部署和验证；以下客户端接入说明仅作为保留实现的技术参考。

本目录包含固定的 Router 系统提示词和可移植的 OpenBitFun 启动脚本。启动脚本负责让
OpenBitFun 连接已经运行的 OpenAI-compatible Router 服务，不会在客户端或评测机器上
启动 vLLM。

## GUI 配置

在“设置 → AI → 模型”中添加 Router 服务模型，再打开“路由服务”选择该配置并检查连接。
客户端不需要下载模型权重或分词文件，也不要求服务提供 `/tokenize` 接口。GUI 智能模式使用独立的
`ai.default_models.economy`，只为主对话按步骤选择模型。子代理继续按显式模型或模型池、
Agent/默认配置、继承和 Fork 规则独立执行；普通新建子代理保留原有快速模型兜底，
不会因为主对话开启智能模式而改用主力或经济模型。已有子代理恢复时保留自己的绑定。
子代理不参与 Router 分类或 Router 辅助摘要。旧 `ai.model_routing.subagent_model` 字段
仅保留读取兼容，不再影响选择，GUI 也不提供对应的高级选项。
GUI 智能模式自动使用经济模型整理路由历史，该摘要请求不依赖快速模型配置。
旧 `summary_enabled` 字段保留读取兼容；GUI 保存时写入 `true`，使旧执行主机也启用摘要。
GUI 内置提示词由 Core 随程序打包，不依赖本部署目录存在。

主力与经济模型的连接检查使用所传模型配置的默认推理档位，与正式客户端遵循相同的配置解析
和自定义请求体优先级；未保存的模型草稿同样适用。Auto 保留服务端默认行为，不会替换成
客户端猜测的档位。检查不会验证每个会话的推理覆盖或完整历史负载；Router 协议检查与经济
模型的正式执行可用性仍是独立结果。
模型的地址、凭据、推理或自定义请求体发生变化后，旧连接结果失效；较早请求的晚到结果不会
重新标记为已连接。全局代理和流式超时变更也会撤销检查。推理参数被拒绝时，设置页只展示
本地化诊断和白名单参数值，不直接输出可能包含凭据或请求内容的服务端原始错误。
连接成功但尚未检测到工具调用时，保留工具能力未验证的提示。

旧执行主机未声明 `estimatedTokenBudgetSupported` 时，已有 tokenizer 路径可保留并继续
保存配置；没有已保存路径时，GUI 会提示升级执行主机并拒绝保存。只升级控制端不会让旧主机
获得无分词文件运行的能力。

会话显式选择“手动指定”时，即使存在 Router 环境变量，也不调用 Router。智能模式开关
只改变当前主对话或草稿的策略，不修改后续会话的策略默认值，也没有“记住选择”或范围选项。
尚无会话或草稿时由宿主策略默认值负责选择；手动选择具体模型或模型池仍沿用原有的会话和
后续默认值保存规则。尚未设置 GUI 策略的旧安装仍支持下面的环境变量
方式，并保留 `fast` 候选回退到主力模型的原有行为。以下启动参数及摘要默认值描述的是
环境变量部署方式；GUI 配置优先使用所选 Router 模型的地址、凭证、代理和请求头。

## 目录内容

- `router_system_prompt.txt`：OpenBitFun 在每个参与路由的主 Agent round 开始前发送给 Router 的
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

通过环境变量传入 Router API URL 和服务所需的凭证：

```bash
export ROUTER_API_URL='https://<router-host>/v1'
# ROUTER_API_KEY 由执行环境的凭证管理注入，不要写进仓库
```

地址必须能从**实际执行 OpenBitFun turn 的主机**访问。`localhost` 指该执行主机；
远程工作区、Peer 或 Detached Dispatch 场景不能用控制端的本地地址代替。
脚本接受以 `/v1` 结尾的服务地址或完整的 `/v1/chat/completions` 地址。
仅在受控本机或私有网络调试时使用明文 HTTP。

然后进入需要 OpenBitFun 操作的目标代码仓库，直接启动完整的交互式 OpenBitFun：

```bash
/path/to/OpenBitFun/deploy/model-router/run_openbitfun_with_router.sh
```

脚本没有改变 OpenBitFun 的运行模式，只是在启动前注入 Router 配置。进入交互界面后可以
像原版 OpenBitFun 一样连续对话，每个参与路由的主 Agent round 都会自动调用 Router。
子代理、模型池会话和外部固定模型绑定不因这些环境变量而加入 Router。

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

这不是任意聊天模型都能替代的服务。部署者需要提供经过对应路由任务训练的 checkpoint，
并固定权重 revision、tokenizer revision、chat template 和本目录的系统提示词。`router-best`
只是客户端请求的服务别名，不是可自动下载的公开模型地址。部署记录应保存这些资源的版本
或文件校验值；更换其中任何一项都需要重新做协议与分类质量验证。

当前适配器向 `/v1/chat/completions` 发送非流式请求：两个字符串消息（system 和 user），
`temperature=0`、`top_p=1`、`max_tokens=128`、`stop=["\n"]`，
`logprobs=true`、`top_logprobs=20`、`return_token_ids=true`、
`return_tokens_as_token_ids=true`，以及 `chat_template_kwargs={"enable_thinking":false}`。
这些 token ID 和模板参数属于 vLLM 扩展，普通 OpenAI-compatible 网关可能过滤它们；
网关必须保留请求字段及返回的 logprobs、token IDs、usage。
[vLLM Chat Completion 协议](https://docs.vllm.ai/en/latest/api/vllm/entrypoints/openai/chat_completion/protocol/)

响应正文的第一行应为 `{"simple_type":"simple"}` 或 `{"simple_type":"non_simple"}`。
阈值判断还要求在分类标签所在的生成位置同时返回两个候选的 log probability：
`simple` 对应 token ID **22944**，`non_simple` 的首 token 对应 **6280**。
适配器读取 `choices[0].token_ids` 和 `choices[0].logprobs.content`，其中候选 token 用
`token_id:22944` / `token_id:6280` 表示，再对这两个候选归一化计算 simple 概率。
不能只返回 JSON 标签或自行填写一个置信度。更换 tokenizer 后，即使文本标签相同，token ID
也可能不同；需要核对并适配客户端协议，不能仅改服务名称。缺少完整置信度时回退主力模型。
协议实现见 [`round_router.rs`](../../src/crates/adapters/ai-adapters/src/round_router.rs)。

### 部署 vLLM 服务

下面是部署参数示例，不是已经部署或经过容量测试的实例。先准备包含正确 tokenizer 和聊天模板
的不可变本地 checkpoint；GPU 容量、模型支持的窗口及已安装 vLLM 版本需由部署者确认。
本仓库不包含模型权重，也不指定尚未确认的下载地址。

```bash
# VLLM_API_KEY 通过部署系统的凭证管理注入
vllm serve /srv/models/router-checkpoint \
  --served-model-name router-best \
  --host 127.0.0.1 \
  --port 8001 \
  --max-model-len 65536 \
  --max-num-seqs 2 \
  --max-logprobs 20 \
  --logprobs-mode raw_logprobs \
  --return-tokens-as-token-ids \
  --generation-config vllm
```

`--max-model-len` 包含输入与输出，需与 OpenBitFun 配置同步；`--generation-config vllm`
避免 checkpoint 附带的生成配置覆盖服务默认值。使用 Hub 仓库时指定准确的 `--revision`
和 `--tokenizer-revision`；若显式传入 `--chat-template`，必须使用与训练匹配的模板。
不要换成通用模板来“修复”格式错误，`enable_thinking=false` 的实际效果也由模板决定。
参数以固定版本的 `vllm serve --help=all` 为准。
[vLLM 服务参数](https://docs.vllm.ai/en/latest/cli/serve/)

示例绑定本机回环地址，通过有身份验证的 TLS 反向代理向执行主机开放所需 API。
不要在 URL 中嵌入凭证。vLLM 的 API key 不覆盖所有管理接口，不能据此把整个服务端口公开；
代理应只开放产品需要的路径。
[vLLM 安全说明](https://docs.vllm.ai/en/latest/usage/security/)

`--max-num-seqs` 控制推理调度，不等于 HTTP 等待队列有界。支持
`--max-num-queued-reqs` 的 vLLM 版本可限制单个 API 服务进程的等待与活动请求总数，
超额返回 503；旧版本应在代理层提供有界队列。这些都不是跨多个 API 进程或多个实例的
全局配额，多台 OpenBitFun 主机共用服务时应在入口统一限制容量。服务端等待时间应能落在
客户端的请求期限内；容量数字需要实测，不能从本机并发配置推断服务吞吐量。
[vLLM 队列参数](https://docs.vllm.ai/en/latest/cli/serve/)

### 用量与错误响应

成功响应应保留 `usage.prompt_tokens`，表示经过服务端聊天模板处理后的**完整输入**，
包含 system、user、特殊 token 和模板开销。缓存命中 token 也是输入的一部分，不应扣除，
也不应重复加算；`completion_tokens` 或 `total_tokens` 不能代替输入用量。vLLM 的非流式
Chat Completion 用实际 prompt token IDs 生成这一计数。
[vLLM 用量生成实现](https://docs.vllm.ai/en/latest/api/vllm/entrypoints/openai/chat_completion/serving/)

上下文超限应保留非 2xx 状态和结构化错误体，最好由服务或网关提供稳定的超限错误码，
例如 `error.code="context_length_exceeded"`，以及能够保证准确的上下文上限、输入和输出预算。
不同 vLLM 版本的错误结构并不完全相同，部分版本的 `error.code` 只是 HTTP 数字状态码；
不能把所有 400 都当作上下文超限，也不能把错误文案里的 “at least” 数量当作完整输入 usage。
代理不得把错误改为 200、登录 HTML 或只有通用文字的错误页。
[vLLM 错误响应实现](https://docs.vllm.ai/en/v0.16.0/api/vllm/entrypoints/openai/engine/serving/)、
[vLLM 输入长度校验](https://docs.vllm.ai/en/latest/api/vllm/renderers/)

客户端不依赖远程计数接口，不会为每条观察或每次裁剪调用 `/tokenize`。服务端只需在正常
分类响应中保留用量，在失败时保留可识别的错误；客户端的预算校准行为见下文。

## 客户端默认值与并发

默认 Router 客户端配置如下：

```text
Router 模型：       router-best
最近轨迹轮数：      3
配置输入上限：      65536 tokens（与服务窗口同步，实际会扣除固定内容）
服务上下文窗口：    65536 tokens
Simple 阈值：       0.75
请求超时：          10000 ms（排队与网络请求合计）
同服务路由并发：    2；最多等待 32 个请求
Fast 增量摘要：     开启；触发门槛上限 8192 个预算 tokens，预算收紧时可提前触发
历史摘要目标：      约 4096 tokens 以内（正文目标，不包含推理）
摘要生成上限：      16384 tokens（推理与正文合计）
摘要推理档位：      模型支持的最低 effort（可独立指定摘要模型支持的 preset）
摘要请求超时：      120000 ms
```

可以通过 `ROUTER_MODEL`、`ROUTER_RECENT_ROUNDS`、`ROUTER_MAX_INPUT_TOKENS`、
`ROUTER_CONTEXT_WINDOW`、`ROUTER_SIMPLE_THRESHOLD`、`ROUTER_TIMEOUT_MS`、
`ROUTER_SUMMARY_ENABLED`、`ROUTER_SUMMARY_TRIGGER_TOKENS`、
`ROUTER_SUMMARY_MAX_TOKENS`、`ROUTER_SUMMARY_TARGET_TOKENS`、
`ROUTER_SUMMARY_REASONING_PRESET` 和 `ROUTER_SUMMARY_TIMEOUT_MS` 覆盖这些默认值。
未指定正文目标时取生成上限的一半与 4096 的较小值，以兼容已有的较小生成上限；显式目标
必须为正数且不大于生成上限。直接运行宿主时使用相应的 `OPENBITFUN_ROUND_ROUTER_*` 变量。

65536 是当前客户端默认值，不代表任意部署的真实窗口或训练长度。应按实际服务配置设置
输入上限和上下文窗口；OpenBitFun 会扣除固定 system prompt、128 个输出 tokens、
256 个 chat-template 预留和额外的估算余量，再结合服务端反馈收紧动态 user prompt 预算。模板预留是本地估算，
不是对任意模型模板的精确保证。通常输入远低于上限，不会为了上限进行补齐。

同一执行宿主访问同一 Router API 地址时共享并发额度，模型名称或凭证变化不会建立新的并发池。
不同会话的请求可以并发；额度用完后按根会话轮转，同组请求按入队顺序等待，不需要等
另一个会话的整个任务结束。每个根的等待上限是总等待容量的四分之一向上取整，最多 8 个，
空闲执行槽可以借用。根分组是调度隔离机制，不表示子代理参与路由；当前只有符合条件的
主对话发起分类请求。这是进程内公平调度，多宿主共用服务仍需服务端限制总容量。
排队和网络请求共用超时，队列满或超时仍按现有路径回退主力模型，取消会立即释放等待位置。
可在启动宿主前设置 `OPENBITFUN_ROUND_ROUTER_MAX_CONCURRENT`（默认 2）和
`OPENBITFUN_ROUND_ROUTER_MAX_QUEUED`（默认 32，允许 0）；GUI 与环境变量配置都使用这些
宿主级限制。活动服务的额度变更需要重启宿主，服务端及其他进程仍有各自的容量与队列。
这些设置限制同时请求数，不代表 Router 服务已具备相应吞吐量。

## Router 专用增量上下文

每个参与路由的主 Agent logical round 开始前，运行时从消息中只读收集尚未见过的增量，固定组成
`## Task`、`## Earlier history summary`、`## Recent trajectory` 三段。Task 包含当前任务及
最新用户纠偏；最近 3 轮包含 assistant 文本/推理、工具名/参数/结果和错误标记，最新一轮
优先保留细节。后台结果、用户 steering、失败恢复反馈也作为独立观察保留。大字符串按
预算保留头尾并标记省略，工具结果优先使用实际提供给 Agent 的版本，不发送图片二进制。
超过 64KiB 的大字符串先做带标记的头尾投影，避免在路由边界反复计数整份大日志。

Router 有自己的去重游标、待摘要增量和历史摘要，按主对话 session UUID 隔离。
Fork 可读取复制的历史，但不继承父 Router checkpoint 或摘要游标。
供应商提示词缓存 lineage 的继承保持不变；子代理不创建 Router 上下文。
Router 不读取主 Agent 的 compression summary，不调用主 Agent 压缩器，
不改主消息、主压缩配置或主压缩触发条件。

每条观察先完成与 Router 输入一致的确定性预处理，再在本地计数并保存预算 token 数，默认
使用估算。离开最近 3 轮的旧轨迹达到触发门槛后，发起一次独立、无工具的后台摘要请求。
门槛取配置值（默认 8192）与当前 user prompt 预算一半的较小值，最低为 1；预算校准收紧时
可以提前触发，无需重算或改变已经缓存的观察计数。完整输入达到预算的四分之三，或已经无法
完整容纳时，会提前整理最近一轮之前的历史，保留最新完整轮次的细节。
GUI 配置固定使用经济模型，旧环境变量模式使用 **fast** 模型。摘要基于旧 Router
摘要和本次旧轨迹快照，将新摘要控制在约 2048 tokens，并单独预留推理空间，默认生成上限
为 16384 tokens。
摘要优先保留当前目标、最新用户纠正、关键文件与符号、确认的结果、测试结论和未解决问题，
区分假设与事实，合并重复背景，不抄录大段日志或代码。该正文目标是模型请求要求；收到完整
摘要后不会按本地长度硬裁剪。默认值变更不会主动重写已落盘的摘要或用户显式配置，后续按需
生成新摘要。
不能把正文目标直接当作推理模型的整个生成预算。压缩触发只累计 pending
history，不计算也不持久化 summary 的 tokens。
摘要尚未完成时，完整上下文仍能装下就继续使用旧摘要加待处理增量，不等待模型返回。
开启自动摘要的路由不会把整体裁剪后的历史发给分类服务；只有完整历史仍放不下或存在未覆盖的
历史缺口时，该轮回退主力模型，后续摘要真正补齐后恢复分类。单条超长日志的带标记投影仍可使用。
已丢失的历史不会被后来的摘要伪装成已恢复。每个进程最多同时执行两个
摘要请求，另有最多 128 个等待会话；每个会话最多一个等待项，同会话不能同时执行两个摘要。
等待中的新观察仅在同一会话内合并，保留队列位置；新观察已经有历史缺口时，保留能够补齐该缺口的
既有排队快照，完成后再整理新增内容。调度按根会话轮转，不合并不同会话的摘要。
每个根最多等待 8 个摘要，空闲槽可以借用；活跃会话不会反复抢占其他会话。
常规增量摘要在取消或结束执行时移除该执行代的等待项并终止其活动请求。队列满时保留原增量，后续轮次
重试入队，不阻塞主任务。摘要失败、超时、辅助模型未配置或返回空/截断内容时
保留原状态；同一 Router round 内不会循环重试，下一轮会重新压缩现有的 summary + pending，
不需要重新积累一份触发量，也不回退到主力模型做摘要。摘要请求使用辅助模型
本身的 provider 和采样配置，不套用主 Agent 的 reasoning preset。可通过
`OPENBITFUN_ROUND_ROUTER_SUMMARY_REASONING_PRESET=low` 给摘要单独选择已支持的推理档位；
未设置或 `auto` 时，只从明确匹配的模型目录、模型专属适配器或用户声明的预设中选择最低
支持档位。未知服务仅有通用手动候选时，不自动添加 `low` 或关闭思考；保留该模型的显式默认
和自定义请求体，默认档位为 Auto 时跟随服务端。自动选择遵循模型默认层的请求体覆盖规则，
显式摘要预设则按原值优先应用。显式选择不可用时摘要失败并保留历史，不静默退回默认档位。
自部署服务可在模型的“思考配置”中选“仅使用自定义预设”，按服务文档声明实际支持的 JSON
请求参数；不配置预设时由服务端决定。这个选项不会删除自定义请求体中已经明确填写的参数。
推理设置通过已有 provider adapter 编译，并与输出预算一起只作用于私有 client 副本，
不修改辅助模型的其他请求、subagent 或模型配置文件。provider 自定义 request body 仍按既有规则
处理，因此不要在其中设置与摘要生成上限冲突的输出长度字段。

增量缓冲最多 128 条，持续失败时超出的最老记录带明确省略游标；这是 Router 的内存预算，
不是限制主 Agent 的轮数。成功摘要只覆盖请求时的序号，新到达的观察不会被删除；执行结束
或取消会终止未完成的辅助请求。开启原有会话持久化时，在执行宿主的会话 snapshots
目录保存独立的 `router-session-context-<history-sha256>.json`，包含会话身份、完整可见 turn
顺序和执行代标识。同一会话连续的智能模式 turn 继承有效摘要与去重游标，同时更新当前任务。
恢复同一 turn 会更换执行代标识，阻止上一次执行晚到的写入。回退后只继承仍然可见的前驱，
分叉会话不直接读取父会话摘要，其他会话的状态也不能混用。跨 turn 时只保留初始上下文仍会
出现的消息去重 ID；同一 turn 内与恢复时保留完整去重记录，避免重放已观察的增量。

旧会话首次开启智能模式、紧邻前一 turn 没有有效 checkpoint（例如中途使用了手动模式），
或已有未覆盖的省略游标时，从执行主机保存的原始可见 turn 分块重建 Router 历史。
每块按摘要模型自己的窗口预留系统提示、已有摘要和输出预算，接受摘要后保存来源游标与历史覆盖范围。
历史导入使用独立的预算批次，可容纳超过 128 条的连续观察；实时增量仍保留原来的 128 条
背压限制。每个历史批次同时受完整摘要 prompt 的估算 token 预算和序列化 entry 字节预算约束，
后者为辅助模型输入 token 预算的三倍字节，额外计入来源 ID 和元数据；这不是进程 RSS 上限。
无法加入下一条时先摘要已有连续前缀，再重试同一条观察，来源游标只在加入成功后推进。
恢复较大缓存时也按当前预算分段处理，回填完成前收敛剩余尾部，避免实时合并造成新的历史缺口。
批次规划只构造选中的完整 prompt，不逐个候选前缀重复拼接历史。
初始化可在短任务正常结束后继续，显式取消会停止其请求；下一执行代会接管并取消旧代，
从已接受游标继续。完成前保留主力兜底，覆盖校验通过后接上新增观察并自动恢复路由。
旧 per-turn sidecar 缺少完整历史证明，保留但不直接迁入
会话级状态；不可读或新版本文件同样保留、不覆盖。缺少有效状态时不拿主压缩摘要补齐历史。
未启用会话持久化的临时执行仍只保留当前执行代的内存状态。

选择智能模式本身不会对所有会话发起摘要预热。历史准备由实际执行主机在开始执行该会话时
按需启动，完成后供后续 turn 复用；未发送消息的模式切换不会因此新增历史摘要调用。

正常轮次中，摘要请求和 checkpoint 落盘均在后台；同步路径只做本地增量收集、裁剪和快照
拼装。落盘使用单个 writer 合并待写快照，并通过文件锁、历史身份和执行代检查阻止旧执行代覆盖新状态。
同一进程内，下一 turn 可读取前驱尚待落盘的最新快照；该内存交接只随上下文和 writer 存活，
不会建立永久的全局会话缓存。只有 turn 初始化恢复和任务结束刷盘最多等待 500ms，不会每轮
等待磁盘。Router 分类请求
本身仍然需要等待返回，才能决定本轮模型；这与准备历史摘要的辅助请求不同。

### 本地估算与服务端用量校准

默认使用可移植的本地保守估算，无需下载 `tokenizer.json`。增量去重、摘要触发和裁剪继续在
应用内完成，服务端负责其模型的实际分词和上下文上限校验。把 tokenizer 留在服务端不意味着
把主对话、子代理或 Router 的会话状态交给服务端管理。

每次 execution 有独立的预算校准状态。服务端成功响应后，完整的 `usage.prompt_tokens` 用于
记录估算偏差的高水位，只能收紧后续输入预算；缺少或无效 usage 时继续保守估算，不按零处理。
Router 会随着摘要更新重新排列输入，因此不能直接套用主模型请求的“相同前缀 usage 锚点”。
本地估算和模板预留仍可能低估，服务端返回的实际用量才是计数依据；估算值不用于冒充账单。

可识别的上下文超限会使本次路由回退到主力模型，并收紧该 execution 后续轮次的 Router
输入预算；不会在本轮反复裁剪并重发 HTTP 请求。普通网络错误、鉴权错误、限流或其他
无法确认原因的 400 仍按原路径回退，不应当作精确的输入长度证据。

旧配置中的 tokenizer 路径仍可作为可选高级设置读取。使用启动脚本时可显式设置
`ROUTER_TOKENIZER_PATH=/absolute/path/tokenizer.json`，直接启动宿主时对应
`OPENBITFUN_ROUND_ROUTER_TOKENIZER_PATH`；启动脚本不会默认注入任何分词文件路径，显式设置
`ROUTER_TOKENIZER_PATH` 才会覆盖继承的宿主变量。文件应与服务端模型一致。文件不可用时记录警告并
回退到估算，不会因此要求用户下载文件或阻止智能模式。即使使用本地 tokenizer，服务端模板
和特殊 token 开销仍需要预留与校准。

CLI 与 Desktop 共用此 Core 路径；无需分别实现压缩。在不经启动脚本的 Desktop/CLI 宿主上，
使用对应的 `OPENBITFUN_ROUND_ROUTER_*` 环境变量（例如 `..._MAX_INPUT_TOKENS`、
`..._SUMMARY_TRIGGER_TOKENS`）。远程工作区、远程控制、Peer 或 Detached Dispatch 均由
**真正执行 turn 的宿主**准备
Router 上下文并访问 Router/辅助摘要 API，其配置、凭证及可选本地资源均属于执行宿主。
主对话和每个子代理的执行模型上下文仍走各自既有的应用侧压缩流程，不与 Router 摘要合并。
这里是宿主侧实现约束；各远程场景仍需部署后的端到端
smoke 验证。

评测程序只需传入真实任务描述，不要逐轮自行构造 Router 输入。`ROUTER_TRACE_PATH` 的每条
`router_decision` 与失败/取消记录包含根会话、父会话、当前会话、turn/round 身份和
`queue_wait_ms`，用于区分排队与服务耗时。
`router_decision` 还会记录 Router 输入预算/计数方式/准备耗时/增量游标、pending 总 tokens、
每条 pending/recent entry 的 sequence、round ID、类型、token 数和错误标记，以及本轮观察到的
压缩状态。压缩记录包含 `in_flight`、`applied`、`failed`、`incomplete` 或 `stale` 状态及其
快照边界、pending tokens、延迟、usage 和错误。单独的 `router_context_summary` 事件仍然保留，
便于不依赖 Router 决策频率审计摘要请求。这部分是额外模型开销，不混入主轮次 Token Usage，
评测时应单独汇总。摘要事件还记录配置的生成上限、正文目标、请求和实际选中的推理 preset，
以及 `response.finish_reason`、`text_chars`、`reasoning_chars`、`tool_call_count` 和
`incomplete_reason`。后者区分 `output_limit`、`empty_text` 与 `tool_calls`；诊断字段不保存
推理正文。`usage.reasoningTokenCount` 只在 provider 确实返回时记录，不用字符数伪造 token 数。
本地预算 token 数应按记录的计数方式解释，不能与服务端 usage 混为一谈。
未返回 usage 的请求保持缺失，不能按零计费。可设 `ROUTER_SUMMARY_ENABLED=false` 对照纯规则
裁剪版本；固定 Router system prompt 和 `simple/non_simple` 决策协议不变。

## 数据与安全

Router 与辅助摘要请求可能包含任务原文、历史摘要、推理文本、工具参数和工具结果，因此只应
使用受信任的服务。环境变量部署默认启用 fast 辅助调用，仍兼容原有显式开关；GUI 智能模式自动维护摘要。
sidecar 保存独立
摘要与裁剪后的增量；启用 `ROUTER_TRACE_PATH` 后，本地 trace 也会记录完整 Router 输入和输出；
评测结束后请按数据敏感级别妥善保管或清理该文件。

## 主对话路由验收

同一逻辑 round 的请求重试复用已选模型，下一 round 才重新分类。图片观察需要主力模型
的视觉能力而经济模型不具备时回退主力；工具协议、推理历史和上下文窗口继续通过既有
执行模型适配、请求投影和压缩路径处理。子代理、模型池会话、外部模型绑定与批准后不可变的
任务不进入路由。

本地模拟服务与持久化测试覆盖会话隔离、恢复、排队公平、取消和旧配置。
这不代表分类器质量已通过真实任务评测。接入真实 Router 后，应对同一组
检索、修改、审查和嵌套任务比较全主力与自动路由的完成质量、总耗时、缓存命中、执行
模型用量与 Router/摘要额外用量；服务没有返回用量时保持未知，不推算为零。

本次改动尚未获得可用于联调的真实 Router 服务。部署后还需验证实际模型与模板、两个标签
token ID、完整 logprobs、prompt usage、超限错误，以及多宿主并发和取消后的服务端资源释放。
这些协议 smoke 与分类质量评测应分别记录；本地模拟测试不能证明远程部署或质量已经通过。
