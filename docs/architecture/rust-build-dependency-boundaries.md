# Rust 构建与依赖边界

本文定义 OpenBitFun Rust workspace 的 Cargo feature、第三方依赖、测试目标和验证职责边界。它是
[`product-architecture.md`](product-architecture.md) 的构建视图补充；运行时 owner、端口和产品分层仍以产品架构及最近的模块 `AGENTS.md` 为准。

本文只记录长期规则，不记录当前 package 数量、重复版本数量或单次构建耗时。阶段性审计和迁移顺序保留在本地工作记录或对应 issue/PR，避免把过程文档和会变化的基线提交为可不断调高的门槛。

## 1. 适用范围

以下改动必须同时遵守本文：

- workspace 或 crate `Cargo.toml` 的 dependency、feature、target 和 profile 变更；
- `openbitfun-core`、Assembly 或产品入口的 capability 装配；
- 为降低构建/测试时间而做的 crate 拆分、owner 迁移或第三方库替换；
- build script、proc-macro、TLS/crypto、系统库和其他重型原生依赖的引入或扩展；
- integration test、example、binary 的 feature/target gate；
- 本地验证命令和 CI 验证职责的调整。

单纯减少依赖数量不是架构目标。依赖必须由实际能力和 owner 决定；构建收益不能作为向上依赖、重复实现或错误共享生命周期的理由。

## 2. 四类决策必须分离

| 概念 | 决策时机 | Owner | 表达内容 |
|---|---|---|---|
| Cargo feature | 编译期 | capability owner crate | 哪些代码和依赖进入编译图 |
| Delivery Profile | 产品装配/构建期 | app 与 Assembly | 一个产品入口选择的 capability 集合 |
| Runtime Config | 运行期 | domain/service owner | 已编译能力范围内的用户或组织配置 |
| Capability Availability | 运行期事实 | owner port/provider | 能力是否已编译、注册且当前可用 |

Delivery Profile 是架构概念，不是新的通用 manifest、schema 或运行时对象。当前产品入口可直接通过对 owner crate 的显式 feature 选择表达它；只有存在真实的多个构建消费者且静态声明不足时，才引入更高层装配对象。

Runtime Config 不能让未编译能力凭空可用，也不能代替 target/feature gate。Capability Availability 必须反映真实 provider 状态，不能只根据配置值或静态 catalog 推断。

## 3. Cargo feature 与依赖声明规则

### 3.1 Feature 保持加法语义

- 打开一个 feature 可以增加 API、实现或依赖，不应移除已有 API 或改变已启用能力的含义；
- 不使用互斥 feature 表达产品枚举。互斥实现优先由 target、独立产品入口或 owner provider 选择；
- `default` 只承载明确的兼容默认值，不是新产品入口的 capability 选择方式；
- 可选依赖由声明它的 crate feature 激活，消费者不得越层拼装 owner 的内部依赖；
- 一个 feature 应对应稳定能力边界，而不是临时 PR、UI 页面或单个调用点。

Cargo 会统一同一 package 在依赖图中的 feature；workspace dependency 与成员声明的 feature 也会相加。因此共同声明必须保持最小，产品入口无法撤销下层已经开启的重 feature。具体解析语义见 Cargo 的
[`Features`](https://doc.rust-lang.org/cargo/reference/features.html) 和
[`workspace.dependencies`](https://doc.rust-lang.org/cargo/reference/workspaces.html#the-dependencies-table) 文档。

### 3.2 产品入口显式选择 Core 能力

`src/apps/*`、`src/crates/interfaces/*` 和 installer app 直接依赖 `openbitfun-core` 时必须声明非空
`features` 列表。Core 的 `default` 由 Core 自身和边界检查保证为空，因此仓内 consumer 不重复声明
`default-features = false`；能力边界仍由 consumer 的显式 feature 集合决定。

入口应选择真实需要的 owner feature；`product-full` 只能描述确实需要完整产品装配的兼容入口，不能作为尚未完成 feature/owner 分解时的占位解法。缩小某个产品的 capability 集合时必须从实际 construction/command path 反推，并保留行为等价或明确 unsupported-state 测试。

Core library 的默认 feature 集合为空；完整产品必须显式选择 `product-full`。若 interface crate 以多个
公开角色复用一条 optional Core dependency，则 dependency 声明本身保持无 feature，每个角色 feature
分别激活 Core 并选择自己的非空 owner 闭包；兼容默认值只能组合这些已评审角色，不能重新引入
`product-full`。每个角色必须独立编译，产品消费者还要显式关闭该 interface crate 的默认 feature 并选择
真实使用的角色，避免 workspace feature union 掩盖边界缺口。

Core 的 `agent-runtime` 只承载 Agent 生命周期基线和明确的基线工具，不得再次把 MCP、Remote Connect、模型目录、Browser/Web、Git 或产品工具组藏成 capability union。具体 service 由同名 owner feature 选择，内置工具由 `tools-*` 选择；`product-full` 显式相加全部 owner，CLI/ACP 等窄入口则按真实命令与构造路径列出自己的闭包。

执行层的 `openbitfun-agent-runtime` 自身也保持空默认：完整生命周期由 `agent-runtime` 选择，DeepResearch 纯编号由 `deep-research` 选择，原生 Hook 配置解析与进程执行分别由 `native-hook-settings`、`native-hook-runtime` 选择。叶能力仍留在原 owner crate 内，不为依赖收敛新建 DTO/runtime crate；完整产品必须显式恢复真实 owner，不能依赖 workspace feature union 偶然补齐。

Owner feature 不等于“无前置依赖”。当实现确实调用较低层基线时，依赖必须按 `owner → baseline` 显式组合，禁止反向把 owner 藏回基线：例如 Core MCP 工具桥和 Remote Connect 依赖 Agent 生命周期，Workspace Search 依赖本地 Workspace Runtime。每个新增或调整后的 owner 闭包都必须单独 `cargo check`，避免被 Desktop/CLI 的 feature union 偶然补齐。

只为已经启用的 optional dependency 增加子能力时，使用 Cargo 的弱依赖转发
`dependency?/feature`，并把 modifier 与 runtime owner 分开命名和看护。modifier 单独启用不得激活
runtime dependency；真实产品入口必须同时显式选择 owner 与 modifier。不要为了复用一个子 feature
把完整 adapter、service 或 tool runtime 拉回窄闭包。

Function Agent 的 Git/AI 适配由 `function-agents` 选择，MiniApp 的 domain/runtime/market
闭包由 `tools-miniapp` 选择，创造模式专属的前端工作台由独立的 `tools-creation` 选择；
产品装配可以为 Creative 同时选择两个 owner，但不得再通过一个通用 `product-domains` Core feature 把它们、
Plugin Source 和完整 domain feature 集合一起带回 Agent Runtime。产品装配计划若声明了当前
二进制未编译的工具组，必须在 registry materialization 前明确失败，不能静默删掉该组。

工具 provider group 只维护稳定分组与注册顺序，不等于 Cargo feature owner。每个内置工具
必须映射到唯一 `ToolPackFeatureGroup`；Product Assembly 通过 `ProductToolPlan` 明确选择本次
交付需要的 owner，Core materializer 只物化这些 owner 的工具，并对“计划已选择但二进制未
编译”的 owner 返回类型化错误。`agent-runtime` 基线计划只选择 `Basic` 与 `AgentControl`；
它不是隐式 Delivery Profile，也不得从当前二进制已编译的 feature union 反推产品能力。

图像查看与分析由 `tools-image-analysis` 独立选择；`tools-image-generation` 承载生成工具、
配置驱动的 AI client 和生图协议适配。检查图片的窄消费者不应因此启用生成请求。完整产品和
需要生图的 CLI、ACP、SDK Host 显式选择这两个 owner，工具 provider 与注册顺序保持稳定。

### 3.3 Workspace dependency 只提供共同底座

- workspace 声明负责版本和真正跨产品共享的最小 feature；
- 第三方依赖的默认 feature 若不是每个 consumer 的稳定契约，在 workspace 声明统一关闭；成员继承该策略，
  只增加自身实际使用的 feature，不在各 manifest 重复 `default-features = false`；
- 仓内 crate 的空默认值由被依赖 crate 拥有并由边界检查锁定，consumer 不重复关闭；只有 ACP 这类有意保留
  非空兼容默认的 crate，窄 consumer 才必须显式关闭默认值并选择角色；
- 被 Docker 等独立构建上下文单独复制的 manifest 无法继承 workspace 根，继续显式声明版本与默认策略；
- runtime、HTTP、TLS、crypto、codec 等产品特定 feature 留给实际 app/service/adapter owner；
- `full` feature 只有在所有真实消费者都需要且更窄集合不能稳定维护时才允许；
- target-specific dependency 放在最接近平台实现的 owner，不因单一平台需求污染跨平台 crate；
- 修改共享 dependency feature 视为构建影响变更，必须检查真实产品组合的 feature graph。

### 3.4 Reqwest 能力由客户端 owner 选择

- workspace 级 `reqwest` 只统一版本并关闭默认 feature，不替任何客户端选择 HTTP/2、序列化、表单、流、代理或 TLS 能力；
- 真正创建 client 的 app、service 或 adapter 必须在自身依赖声明中显式选择实际使用的 Reqwest feature 和 provider-neutral 的 `reqwest/rustls-no-provider`；只使用 `reqwest::Url` 的 contract/assembly 路径不加载传输能力；
- capability crate 的每个 Reqwest owner feature 必须独立带齐自己的数据/传输 feature、`reqwest/rustls-no-provider` 和进程级 TLS provider owner，不能依赖 `product-full` 或其他 feature 的 Cargo feature-union 偶然补齐；
- workspace 级 `rustls` 只统一兼容版本并关闭默认 feature；`services-core/tls-provider` 是内置 crypto provider 的唯一 owner，精确选择并安装 `ring`、`std` 和 `tls12`。产品进程入口或集中 client helper 必须在构造 TLS client 前确保该 provider 已安装；
- 独立 Docker 构建的 Relay 身份校验器是限定例外：它不链接 workspace 服务 facade，只能将显式 ring `ClientConfig` 绑定到自己的 Reqwest client，不能安装或替换进程级 provider。该例外只覆盖 `relay-service/src/identity.rs`，边界检查同时强制 client 绑定并禁止 `install_default`；嵌入式产品的进程 provider 仍由 `services-core` 拥有。
- 边界检查以 Cargo metadata 的解码结果看护全部直接 consumer，并检查 resolved Reqwest/Rustls feature union，拒绝缺失 provider、同时选择多个 provider、传递依赖重新激活 AWS-LC 或 Native TLS，以及绕过集中 helper 的 Reqwest client 构造；
- 不并列启用 Native TLS 或 AWS-LC 兼容栈。只有真实产品场景无法由当前 Ring/Rustls 平台证书验证承载时，才以明确行为证据评审替换方案；替换时由同一 owner 切换 provider，不能在同一产品闭包叠加第二后端。

### 3.5 稳定契约 crate 按消费能力切片

稳定 DTO、port 和纯契约继续由原 contract/execution crate 拥有；当同一 crate 的公开表面覆盖多个互不相关的
能力域时，优先在原 crate 内用 additive owner feature 隔离源码和可选依赖，不为了构建数字迁移 runtime owner
或复制公共类型。feature 关闭时 API 不可见是明确的编译期契约变化；feature 开启后必须保留原公开路径、序列化
形状和错误语义。

- contract crate 的 `default` 保持空并由目标 crate 的边界契约看护；consumer 继承该空默认值，只选择实际
  消费的切片，不在每条 normal/dev/build/target dependency edge 重复关闭 default features；
- feature 名描述稳定能力，例如 Agent API、workspace/terminal/remote/Git port、协议 bridge 或 Computer Use
  contract，不描述某个临时调用方、PR 或测试；
- 不提供 `full`、`service-ports`、`all-contracts` 等重新合并全部表面的 umbrella。只有多个 owner 共同消费且
  无法合理拆开的稳定复合类型可以保留一个窄 aggregate，并明确列出其组成；
- 同一依赖的 Cargo feature 会在完整图中相加，因此窄 consumer 必须独立 `cargo check/test`。完整产品构建
  只能证明组合闭包可用，不能证明单个 consumer 的声明完整；
- 边界检查看护目标 crate 的空默认、feature surface、consumer edge 及强/弱 feature 转发；不得依赖包名文本
  而漏掉 rename、optional、dev/build 或 target-specific edge。

## 4. 依赖 owner 与准入检查

第三方库应位于调用外部系统或实现具体能力的最低合理 owner：

- 协议/外部数据形状翻译属于 adapter；
- OS、进程、文件系统、网络、Git、MCP 等具体实现属于 service；
- 可移植的 agent/tool/harness 原语属于 execution；
- DTO、事件和端口属于 contracts，保持行为轻量且不得依赖上层；
- Assembly 选择和连接 capability，不实现具体 adapter、OS 或 service 细节；
- app 只拥有入口、平台生命周期和产品呈现，不复制可复用服务逻辑。
- 稳定 contract 与具体运行时实现位于同一 crate 时，优先用单一 owner feature 隔离实现依赖；不得为
  feature-free DTO、fallback 或纯事实强拉解析器、全局状态、网络或 host adapter。
- 平台 host 已直接拥有的 adapter 不通过 Assembly facade 二次依赖或 re-export；上层只共享稳定
  contract，具体 emitter/transport 由真实 host 直接构造。
- Services Core 的 feature-free surface 只保留同步稳定 contract、JSONC 和路径规范化；诊断脱敏、
  Diff 计算和异步 workspace 文本读取分别由 `diagnostics`、`diff`、`workspace-text-runtime` owner
  选择。Assembly 可用同名 feature 保留兼容 facade，但不得把这些实现依赖放回默认闭包。

新增依赖或显著扩大已有依赖 feature 时，PR 描述至少给出：

| 字段 | 评审问题 |
|---|---|
| Owner | 哪个 crate/模块拥有该外部能力？ |
| Product consumers | 哪些产品形态实际需要？ |
| Activation | 始终启用、target 还是 Cargo feature，为什么？ |
| Build cost | 是否包含 proc-macro、`build.rs`、C/C++/系统库、TLS/crypto？ |
| Version convergence | 是否新增重复版本，直接依赖升级能否安全收敛间接版本？ |
| Existing alternatives | 标准库或现有三方库为什么不能合理承载？ |
| Boundary fit | 为什么该依赖属于当前层和 owner？ |
| Smallest verification | 哪个最小 check/test 能证明能力和边界？ |

该记录保留在 PR 中，不新增全仓机器可读依赖台账。只有低误报、可长期稳定执行的结构事实进入 boundary checker。

### 4.1 重复版本与间接依赖

- 先用 `cargo tree -d` 确认重复的是可收敛版本、平台分支还是生态尚未统一的 major；
- 优先调整直接依赖的兼容版本，让 Cargo 自然收敛间接版本；
- 不用 `[patch]`、强制 lockfile pin 或降低版本来掩盖真实不兼容；
- proc-macro、TLS/crypto、HTTP types、Windows/system bindings 的重复版本需额外关注，但仍以 API/ABI 和 owner 兼容为前提；
- 版本收敛必须运行 owner 的行为测试；仅看到依赖树节点减少不足以证明安全。

### 4.2 替换不活跃或重叠库

替换前同时评估维护活跃度、安全公告、MSRV、目标平台、许可证、API 迁移成本、feature 粒度、原生构建成本和现有 adapter 行为。缺少近期 release 本身不是替换理由；稳定且边界清晰的库可以低频发布。

只有同一 owner 内职责重叠、统一后不会扩大依赖闭包且能保持行为时，才合并到一个库。API 看似相似的 HTTP client、协议 adapter、认证、runtime 或 crypto 实现不能跨 owner 强行统一。

## 5. 拆分、合并与 owner 迁移准则

拆 crate 或迁移 runtime owner 至少要满足一项：

1. 稳定能力可脱离产品装配独立编译和测试；
2. 现 owner 混合协调策略与具体 adapter/service 实现，形成向上依赖或明显大闭包；
3. 多个产品需要同一稳定 port/fact，但不应共享 UI、协议、认证、生命周期或平台实现；
4. 重型依赖只服务少数能力，拆分后不使用它的产品和测试能退出该构建图；
5. 能用行为等价测试覆盖旧路径，并给兼容入口定义删除条件。

仅为减少文件行数、追求“一 crate 一 feature”、只有单一消费者且没有闭包收益，或必须先建立通用注册框架才能成立时，不拆 crate。可以先在原 crate 内按 owner 拆模块；只有物理 crate 边界带来真实依赖或独立验证收益时再升级。

不可变的随版本发布内容只有在能够形成无第三方依赖、可独立验证的稳定 owner，并且实测能减少原 owner 的
build-script 工作或增量编译成本时才适合独立成 crate。内容 crate 不得顺势承担选择、渲染、运行时状态、动态来源
或通用注册职责；如果 Cargo 依赖指纹仍会让上层 crate 重检，PR 必须如实记录残余失效链，不能宣称已经隔离全部
下游重编译。

DTO/contract 抽取不等于 runtime owner 迁移。迁移 owner 必须先审查 port/provider、旧路径兼容、状态与错误语义、远程 workspace 行为和行为等价测试。

## 6. Test target 与 feature 组合

- feature-gated `[[test]]`、`[[bin]]`、`[[example]]` 使用 Cargo `required-features`，避免目标在能力不可用时仍进入构建图；
- integration test 的 crate-level feature cfg 与 Cargo `required-features` 必须精确陈述同一组正向 AND 条件，不能额外加入扩大最小测试闭包的 umbrella feature；`not(feature)` 留在 Rust cfg 中，feature OR 条件应拆成独立 target，因为 Cargo target gate 无法等价表达；
- integration test 只依赖被测 owner 的公开契约，不通过 `product-full` 获取测试便利；窄 feature 尚不能独立编译时，应将其记录为待拆分的 owner/feature 边界并保持现有 target 声明，不得新增或扩大 `product-full` 来制造已经收敛的假象；
- 纯解析、策略和状态转换优先使用无外部系统的 owner-local fixture；
- 需要真实 adapter/service 的测试单独作为 feature integration target；
- 同一 owner 内 feature、平台与依赖闭包完全相同的 integration tests，应按稳定职责收敛为少量显式 target，避免每个源文件重复编译和链接同一闭包；本地通过 `--test <target> <module>::<filter>` 保留 focused test。不同 feature、平台、进程或外部系统边界不得为减少 target 数而合并；
- 测试常用、真实的 feature 组合，不穷举指数级组合；
- `--all-features` 用于兼容审计，不代替目标产品的最小组合测试。

Cargo target gate 语义见
[`required-features`](https://doc.rust-lang.org/cargo/reference/cargo-targets.html#the-required-features-field)。

## 7. 本地最小验证与 CI 分工

本地验证由改动 owner 和影响面决定：

| 改动 | 默认最小本地验证 |
|---|---|
| Cargo manifest、feature、crate dependency 边界 | `pnpm run check:core-boundaries:test` 和 `pnpm run check:core-boundaries` |
| 单 crate Rust 实现 | `cargo check -p <owner>`；行为变化再加最近的 `cargo test -p <owner> <filter>` |
| 单 capability feature | `cargo check -p <owner> --no-default-features --features <feature>` |
| 单 integration target | `cargo test -p <owner> --test <target>` |
| workspace dependency、低层公开 contract、build script | 按真实影响升级到 workspace check 和相关产品构建 |

CI 负责 workspace 级检查、真实产品 feature 组合、跨平台、完整测试和最终产品构建。本地未执行的宽泛验证必须标记为未执行或 CI 覆盖，不能表述为本地通过。CI 失败时再按失败路径复现对应重命令，不要求每次本地改动预跑全部构建。

### 7.1 Hosted CI 关键路径与缓存

- 验证 job 只依赖自身的编译期前置条件。Tauri `check`/`test` 只要求配置中的前端和资源目录存在时，Rust job 自行创建空目录，不等待或传递可发布前端产物；真实静态资源仍由前端构建和产品打包 owner 负责。
- Rust/CLI 影响分类必须保守且 fail-closed：只有活动路径全部位于 `src/web-ui/**` 时才允许跳过 Rust 与 CLI matrix；仓库根目录/`docs/**` 的 Markdown 和 `png/**` 可作为已知中性伴随路径。其他嵌套 Markdown 可能是 `include_str!`/`include_bytes!` 输入，workflow 不得宽泛忽略全部 Markdown。空变更、非法或不可用 diff range、Rust/build 输入、CI 脚本、其他产品 surface 和所有未识别路径都必须运行完整验证，不能依赖易漏维护的“已知 Rust 目录”名单。PR 使用 base/head 的 merge-base range，只分类 PR 自身改动；`main` push 使用事件 before/head 的 direct range，保留 force-push 或回退提交的实际影响。
- “纯 Web”前提必须是可执行边界：影响分类 job 在计算 diff 前，从 Git 跟踪文件列表扫描全仓 `.rs`（包括 workspace 外 Installer 和根 build script）。除逐行精确登记的既有测试 fixture 外，非注释 Rust 源码不得出现 `web-ui` 路径 token；因此 `include_dir!`、编译嵌入、分段 `PathBuf::join` 和间接路径变量都会在分类前失败。Frontend job 同时显式运行边界 contract tests 和真实 repository boundary check；跨 surface 的命令注册和调用分别由 owner 测试看护。新增类似源码读取时应修复所有权，而不是给影响分类器追加隐式例外。
- 可跳过的 matrix 必须汇总到一个稳定的 `Rust / CLI Validation` 结果：分类失败或输出缺失时下游按需要 Rust 处理；分类为 Web-only 时只接受 matrix 全部 skipped，分类为需要 Rust 时只接受全部 success。昂贵的 Rust/CLI 子 job 保留 `!cancelled()`，无 checkout 的轻量汇总使用 `always()` 检查上游 result，因此旧 run 被 concurrency 取消时明确失败而不是被当成 skipped success。
- 该汇总只保证已触发 CI run 内的稳定结果；在 workflow 仍忽略 `png/**` 时不能直接宣称为全局 required check。若未来接入 branch protection，必须先保证所有受保护提交都会产生该 check，或同步调整 trigger 覆盖。
- Pull Request 可以恢复可信分支产生的 Cargo 缓存，但不得写入 merge-ref 缓存。只有可信 `main` push 可以保存共享缓存；若依赖编译已经完成而后段测试失败，允许该可信构建保存依赖缓存，避免下一次跨平台构建无谓冷启动。
- 未先修改 Cargo manifest 的 PR/main 验证 job 以仓库提交的 `Cargo.lock` 为唯一解析结果并通过 `--locked` 验证，不在 cache restore 前重新生成 lockfile。依赖解析更新必须作为可评审的源码变更提交，不能让同一 commit 因上游兼容版本发布而自然产生新的 cache key；先改写版本号的发布 job 不属于该前提。
- 缓存只承载可复用依赖产物，不为追求命中率启用 workspace crate 或 incremental artifact 缓存；缓存容量、失效粒度和可信边界优先于单次命中率。
- focused test 同时选择最小 Cargo target（如 `--lib` 或 `--test <target>`）和必要 feature；仅使用名称过滤不能阻止无关 test target 进入编译图。
- 只有具备独立 owner、平台矩阵或失败归因价值的验证才拆成 job。顺序执行但共享同一依赖图的命令优先留在既有 job 中，避免用新增 job 重复结账工具链、checkout 和缓存恢复成本。

## 8. 评审证据

依赖治理 PR 按改动选择证据，不机械执行全部命令：

```text
cargo tree -d
cargo tree -e features -p <product-or-owner>
cargo tree -e normal,build -p <product-or-owner>
cargo check -p <owner> --no-default-features --features <feature>
cargo test -p <owner> --test <target>
cargo check -p <product> --timings
```

前后对比优先列出真实产品 dependency closure、关键重依赖是否退出、冷/增量耗时环境与命令、最小 feature/test 是否可独立运行。测量结果是决策证据，不是永久硬阈值；如果收益不足以证明 owner 迁移或新抽象合理，应保留现有结构。

当前硬边界由 `scripts/check-core-boundaries.mjs` 统一执行。不要为同一 Cargo 架构事实增加第二个 checker；新增规则先证明当前树满足、fixture 能捕获回归，并保持错误消息可直接定位到 owner manifest。
检查器必须保持工作树只读；读取独立 manifest 的声明事实时不得生成新的 lockfile、target artifact 或格式化改动。

## 独立数据迁移工具的依赖边界

Data Tools 是独立发布的本地离线工具，不依赖 Core、Product Assembly、Desktop 或 Web UI。
主应用不检测、启动或捆绑迁移器。两者在同一源码工作区复用稳定的数据格式与存储实现：

- contracts/config-contracts：配置 DTO、默认值、版本校验及到共享模型 DTO 的纯转换；Core 原路径保留转发，ConfigProvider 仍在 Core。
- services-core 的 workspace-persistence、coordination-store、session-event-format：工作区记录、注册表校验、SQLite 物理 schema 和会话日志格式。
- services/legacy-migration-adapters：旧版读取、转换、引用修复；只调用共享存储 owner。
- services/legacy-migration：快照、锁、暂存、备份、原子写入、日志恢复和无时效交接依赖的任务存储。

本次只移动数据/存储 owner，不移动 WorkspaceManager、会话生命周期、权限、事件或远程执行。
WorkspaceInfo/WorkspaceIdentity 的运行操作由 Core 的 runtime extension traits 保留，稳定记录无需导入这些能力。
原 Core 存储入口保留错误映射；可选 legacy-migration facade 保留旧导入路径，但不再由 product-full 启用。
远程四种场景不提供迁移工具的执行入口；仅转换本机保存的连接记录，不连接远端。
使用与发行契约以 [独立数据工具说明](../../src/apps/data-tools/README.zh-CN.md) 为准。
