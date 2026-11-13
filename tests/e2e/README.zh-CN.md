**中文** | [English](README.md)

# OpenBitFun E2E 测试

## 桌面长会话性能

在仓库根目录构建桌面端和生产前端后运行：

```powershell
cargo build -p openbitfun-desktop
pnpm run build:web
pnpm --dir tests/e2e run test:perf:long-session
# 缩小规模的试跑，场景保持完整：
pnpm --dir tests/e2e run test:perf:long-session --turns 80 --repeats 2 --scroll-steps 40
pnpm --dir tests/e2e run test:perf:long-session:contract
```

默认生成 4 个 200 轮长会话及 1 个短会话，每轮包含 Markdown 与工具卡片。
两个会话保持静态，另两个通过真实 Agent Runtime 连接本地 SSE 模型模拟器持续输出，
无需模型密钥，不调用外部 AI，也不执行工具。静态测量先运行，流式会话在首次 UI
打开前由运行时启动。两种状态均覆盖首次打开、8 次交替切换、上下各 120 次连续
滚轮输入，以及通过当前轮次导航栏执行的 8 次远距离跳转。模型默认每 90ms 输出
约 480 字符，最后显式结束，并检查结果确实写入持久化历史。

新增的 `multi-tool` 模板用下面的命令运行：

```powershell
pnpm --dir tests/e2e run test:perf:long-session --scenario multi-tool
```

四个长会话的每个历史轮次都包含 **26 个模型回合**：前 25 个回合分别包含
320 字符 Markdown 说明，以及按 Read → Edit → Write → ExecCommand 交错排列
的 4 次工具调用；最后一个回合是总结，默认 4,000 字符，由 `--assistant-chars`
控制。因此每轮固定 **100 次工具调用，四种工具各 25 次**，覆盖全部历史轮次。
默认 200 个用户轮次对应每个长会话 20,000 次、四个会话共 80,000 次工具调用记录；
`--turns` 仍控制用户轮次数。

Read 包含 POSIX 文件路径与源码结果，Edit 包含修改前后源码，Write 包含目标路径
和生成内容，ExecCommand 包含 `cmd`、`workdir`、输出及退出码。原始结果大小由
`--tool-result-chars` 控制，默认每次 6,000 字符；Edit/Write 的源码输入上限为
1,200 字符。它们用于覆盖文件差异、写入和终端输出的不同卡片，均不实际执行。
流式场景在同样的重历史后追加既有 SSE 文本轮次，短会话仍保持轻量。
此模板不接受非 100 的显式 `--tool-items`，实际组成会写入元数据和测试报告。

专项对比流式切换时，使用
`--suite streaming-switch --scenario multi-tool --repeats 16`。两个真实运行时流先
连接但不输出，共同接收 96 段初始文本，并在测量前打开两个会话。每次实际点击切换
时，两条流各增加 16 段文本，按配置间隔持续发送。计时外等待两条流发完本批、当前
会话显示本批最后一段，再开始下一次切换，避免不同构建的文本量不同。此协议独立于
持续增长的完整矩阵；每次切换都检查输出增加，最后检查两条流完成并落盘。
计时结束后还检查阅读位置恢复、草稿保留、新输出不抢占阅读位置、搜索定位和有界 DOM。

专项对比流式中连续滚动时，使用
`--suite streaming-scroll --scenario multi-tool --repeats 2`。一个真实运行时流在
计时外先以 2 ms 间隔接收 512 段文本；每个滚动阶段再按 `--stream-interval-ms`
（默认 90 ms）发送 192 段，同时送入 120 次真实滚轮事件。分别覆盖流式文本区、
流式轮次之前的工具密集历史区，两个区域均双向滚动；`--scroll-area live|history`
可选择单一区域。准备、等待本批完成和返回最后一段都在计时外。每阶段校验新输出、
持续流式状态和全部滚轮事件；本批稳定后再检查阅读位置。只比较协议版本和负载参数
一致的结果，此协议独立于完整矩阵。

Windows WebView2 可选诊断：`OPENBITFUN_LONG_SESSION_CDP_PORT` 指定空闲调试端口，
专项测试保存 `switch.cpuprofile` 和 `switch-trace.json`。
`OPENBITFUN_LONG_SESSION_SELECTOR_STATS=1` 额外记录开销很大的 CSS 选择器和失效追踪。
此类报告标记为 instrumented，正式性能比较必须在清除这些变量后的独立进程中运行。
滚动专项为每个阶段分别保存 `scroll-N.cpuprofile` 和 `scroll-N-trace.json`。
`OPENBITFUN_LONG_SESSION_ROW_DIAGNOSTIC=1` 可附加记录标量行挂载/移除计数、每帧
滚动位置，也会将报告标记为 instrumented。

专项对比流式轮次跳转时，使用
`--suite streaming-jump --scenario multi-tool --turns 200 --repeats 20`。
一个真实运行时流先在计时外以 2 ms 间隔接收 96 段文本。每次实际点击轮次栏，
再按配置间隔（默认 90 ms）发送 16 段；目标循环为序号 0、75%、25%、最后一个
历史轮次和流式轮次。每阶段的起始文本量在各构建间一致，本批完成等待在计时外。
同时检查目标用户消息的实际落点，以及更多输出稳定后的位置。
`firstVisit` 表示尚未访问过的目标；流式轮次在准备阶段已显示，算作已访问。
它不代表冷磁盘或已证明的历史缓存未命中；应分别报告首次与已访问目标。
原有就绪标准保持不变，附加里程碑分别记录首次目标 DOM、
目标可见和视口就绪的观察时间。CDP 诊断保存 `jump-N.cpuprofile` 与
`jump-N-trace.json`，也支持行挂载诊断；带诊断运行不混入正式性能验收。
原有就绪标准只要求目标轮次内容可见，不保证其用户消息已经就位。
`jumpLandingChecksPassed` 单独记录用户消息可见性及后续输出下的位置稳定性；
比较旧构建时应与延时一同报告，优化构建必须通过这项额外检查才能验收。
协议 v3 已将落点检查纳入整体功能验收；`contentReadyChecksPassed` 保留原来的
内容就绪检查结果，旧构建的定位失败与延时样本分别呈现。

控制台打印独立证据目录，包含可直接打开的 `report.html`、`summary.csv`、完整
`result.json`、原始 RAF 时间戳、失败截图、日志、输入数据和前端/桌面程序/测试代码
快照及哈希。不会清理历史证据。指标包括延时 P50/P90/P95/P99、帧间隔分位数、
平均 RAF 帧率、慢帧占比和连续卡顿。失败样本保留且不混入有效样本统计。
支持 Long Tasks 的 WebView 还会报告长任务，不支持时标记为未知；保留每个样本的
焦点/可见性及汇总样本的焦点条件。

打开、切换与跳转的延时从实际送达的首个鼠标/指针事件开始，到目标会话/轮次文本
可见、视口稳定、加载遮罩消失且再经过两次 RAF 为止。滚动延时为首个滚轮事件到
观察到首次位移；帧窗口截至最后滚轮事件后的两次 RAF，准备与空闲等待不计入。
虚拟轮次栏的目标按钮在计时前滚动到可见区域，实际跳转仍点击产品按钮。

首次 UI 打开不代表冷磁盘/冷 OS 缓存，流式准备会预载运行时历史。RAF 表示渲染
机会，不等于屏幕合成完成，也不代表触控板惯性。不要混合 debug/release-fast、
不同负载参数、不同焦点状态或并行构建中的结果。首次打开每种状态只有 2 个样本，
其尾部分位数仅作描述，应通过多次独立运行建立基线。此测试仅覆盖本地桌面，
不证明 SSH 工作区、远程控制、Peer Device Mode 或 Detached Dispatch 的性能。

运行 `node tests/e2e/scripts/run-long-session-performance.mjs --help` 查看参数。
可用 `--turns 500 --repeats 20` 增大规模，`--scenario rich-text` 或 `tool-heavy`
改变历史内容，`--assistant-chars`、`--tool-result-chars`、`--tool-items` 改变每轮大小。
`--max-latency-ms 1000 --max-p95-frame-ms 34` 启用性能预算，默认只采集，不宣称
通过性能预算。功能状态与预算状态分别报告，缺少样本、数据不正确、流式异常、
落盘失败或超预算都会以非零状态退出。

`OPENBITFUN_E2E_FRONTEND_DIR` 指向已完成构建且含 `frontend-revision.json` 的资源目录；
`OPENBITFUN_E2E_DESKTOP_BINARY` 指定可执行文件；`OPENBITFUN_E2E_NATIVE_PROFILE`
指定 `debug` 或 `release-fast`。程序需支持内置 WebDriver 及外部前端资源覆盖。
`release-fast` 的资源快照目前仅支持 Windows，其他平台显式使用 debug。
Windows release 快照保留相邻资源和 `frontend/dist`，并校验实际加载的前端版本。
测试在采样前聚焦主窗口，采样中丢失焦点或可见性会判为无效，不混入有效统计。
默认自动分配驱动端口，`OPENBITFUN_E2E_WEBDRIVER_PORT` 可显式指定空闲端口。
`--evidence` 必须指定尚不存在的新目录，始终使用隔离配置，不触碰日常会话。

使用 WebDriverIO + OpenBitFun 内置 WebDriver 的 E2E 测试框架。

> 完整文档请参阅 [E2E-TESTING-GUIDE.zh-CN.md](E2E-TESTING-GUIDE.zh-CN.md)

## 快速开始

### 1. 安装依赖

```bash
# 构建 debug 应用
cargo build -p openbitfun-desktop

# 安装测试依赖
pnpm --dir tests/e2e install
```

### 2. 运行测试

```bash
# L0 冒烟测试 (最快)
pnpm --dir tests/e2e run test:l0
pnpm --dir tests/e2e run test:l0:all

# L1 功能测试
pnpm --dir tests/e2e run test:l1

# 运行所有测试
pnpm --dir tests/e2e test
```

## 测试级别

| 级别 | 目的 | 运行时间 | AI需求 |
|------|------|----------|--------|
| L0 | 冒烟测试 - 验证基本功能 | < 1分钟 | 不需要 |
| L1 | 功能测试 - 验证功能特性 | 5-15分钟 | 不需要(mock) |
| L2 | 规划中，暂未实现 | N/A | N/A |

## 目录结构

```
tests/e2e/
├── specs/           # 测试用例
├── page-objects/    # Page Object 模型
├── helpers/         # 辅助工具
├── fixtures/        # 测试数据
└── config/          # 配置文件
```

## 常见问题

### 内置 WebDriver 未就绪

测试启动器会直接拉起 OpenBitFun，并等待 `127.0.0.1:4445` 上的内置 WebDriver 服务就绪。

### 应用未构建

```bash
cargo build -p openbitfun-desktop
```

### 测试超时

Debug 构建启动较慢，可在配置中调整超时时间。

## 更多信息

- [完整测试指南](E2E-TESTING-GUIDE.zh-CN.md) - 测试编写规范、最佳实践、测试计划
- [OpenBitFun 项目结构](../../AGENTS.md)
