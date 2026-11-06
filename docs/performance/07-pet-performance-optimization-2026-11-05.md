# 桌面宠物优化报告

日期：2026-11-05。配套：[基线报告](06-pet-performance-baseline-2026-11-05.md) · [原始采样与检查结果](pet-performance-evidence-2026-11-05.json)。所有改动仍在工作区，未提交或发布。

整体性能工作的最终状态见[11月6日收尾报告](08-performance-wrap-up-2026-11-06.md)；本页的小幅观察收益不代表整体应用CPU、GPU或内存目标已完成。

## 结果与判断

完成三个产品修复点及清理，并用六次隔离原生运行对比。宠物 WebContent 待机 CPU 中位数 **1.94% → 1.79%**（观察值约 −7.7%），工作态 **2.89% → 2.74%**（约 −5.2%）。这是小幅观测改善，样本量和输入干扰不足以证明统计显著或承诺线上收益。

**默认宠物内存没有下降，GPU 进程 CPU 没有明确下降。** 待机 RSS **196.30 → 196.48 MiB**，工作 RSS **201.22 → 201.38 MiB**，视作基本持平。全进程工作态 RSS 和 **1069.69 → 1069.42 MiB** 同样基本不变，不能宣称整体应用节省了大块内存。

## 已实施的优化

1. **修正注视结束后的动画恢复。** `AgentCompanionPet` 原先用 `animation: none` 停止注视时的走帧；清除简写会在 WebKit 中清掉原本不变的 `animationName`，让 BitBlob 重新套上额外呼吸缩放。现在只切换 `animationName`。原生优化样本始终保留 `openbitfun-petdex-walk`，尺寸为 96×104；保留精灵图已有呼吸、拖动、任务反应和动作优先级。JSDOM 不能充分复现 CSS 简写的原生行为，因此补充了真实 computed style 的前后证据。
2. **让计时器与可见内容对应。** SVG 熊猫的待机动作/过渡计时器不再为精灵图运行；隐藏页面和 reduced motion 下不调度这些 SVG 动作。隐藏精灵图暂停 CSS 动画；桌面鼠标轮询在隐藏时撤销 interval，显示时立即读取一次并恢复原来的 120ms 间隔。没有降低可见鼠标响应或动画帧数。
3. **合并用户精灵图并发读取并防止释放竞态。** 同一路径的进行中读取共用一个 Promise 和一个 Blob URL。删除/释放使旧读取失效，旧请求完成不会重新填充缓存，也不会清除新的替代请求；失败后可重试。图片探测卸载时同时移除 onload/onerror 回调。单测证明并发请求只读一次、只创建一个 URL；默认内置路径的 RSS 并不能代表这项修复的收益。

主要代码在 [AgentCompanionPet.tsx](../../src/web-ui/src/flow_chat/components/AgentCompanionPet.tsx)、[AgentCompanionDesktopPet.tsx](../../src/web-ui/src/app/components/AgentCompanionDesktopPet/AgentCompanionDesktopPet.tsx)、[AgentCompanionPetService.ts](../../src/web-ui/src/infrastructure/config/services/AgentCompanionPetService.ts)。没有更改持久化、wire payload、命令注册或跨平台所有权边界。

## 前后量化结果

以下为每个状态三次运行的中位数，CPU 100% = 一颗核心。GPU 行是 **GPU 进程使用的 CPU / RSS**。

| 状态 | 进程 | 前 CPU % | 后 CPU % | 前 RSS MiB | 后 RSS MiB |
| --- | --- | --- | --- | --- | --- |
| 待机 | 宠物 WebContent | 1.94 | 1.79 | 196.30 | 196.48 |
| 待机 | Rust 宿主 | 2.99 | 2.64 | 374.88 | 355.22 |
| 待机 | GPU 进程 | 0.25 | 0.30 | 156.44 | 157.02 |
| 工作＋固定气泡 | 宠物 WebContent | 2.89 | 2.74 | 201.22 | 201.38 |
| 工作＋固定气泡 | Rust 宿主 | 3.49 | 3.54 | 354.22 | 354.06 |
| 工作＋固定气泡 | GPU 进程 | 0.50 | 0.50 | 176.53 | 177.22 |
| 隐藏（未销毁） | 宠物 WebContent | 0.20 | 0.15 | 201.61 | 201.70 |
| 隐藏（未销毁） | Rust 宿主 | 0.30 | 0.35 | 354.25 | 354.06 |
| 隐藏（未销毁） | GPU 进程 | 0.00 | 0.05 | 176.39 | 177.17 |

逐组宠物 WebContent CPU：

| 组 | 待机前 % | 待机后 % | 工作前 % | 工作后 % |
| --- | --- | --- | --- | --- |
| 1 | 1.94 | 1.74 | 2.89 | 2.74 |
| 2 | 1.35 | 1.79 | 2.59 | 2.29 |
| 3 | 2.15 | 1.99 | 2.89 | 2.74 |

第二组基线开始时仍在鼠标注视（`animation-name: none`），随后恢复走帧；其低待机 CPU 不能用来宣称优化回退，也不能静默删除。仅看第一/第三组，两组待机分别下降约 10.3% / 7.1%，仍不替代固定输入的大样本实验。工作态三组均略低，但只报告观察值。约 0.05 个百分点的差值已接近该窗口的进程 CPU 计时粒度。

隐藏状态的源代码和计时器测试证明无无效轮询 interval，并不意味着整个 WebView 的 CPU 变成零。宿主、事件、WebKit 自身仍有工作。系统 GPU busy 的前后波动详见基线报告，不能归属于此改动。

## 行为与生命周期验证

- 五个聚焦测试文件，共 **53 项通过**。覆盖 v1/v2、旧选择兼容、动作优先级、注视恢复、reduced motion、隐藏/恢复、窗口 hover、并发去重、释放中的加载与新旧加载交错、失败重试。
- `pnpm run check:web` 通过：包括 TypeScript、Typography、Appearance contract、theme color 与 visual contract。`pnpm run motion:audit` 完成；它是意图盘点，不是 pass/fail gate。
- 原生六次 `passed=true`，相同 binary / environment / measurement harness / protocol；每次独立存储。优化版三个待机、三个工作探针都观察到六个帧位置。所有优化版状态快照的尺寸/动画名/隐藏暂停已从原始结果复核，pair runner 也增加了对应守卫。
- 每版每个状态的 RAF 间隔合计 n=471；优化前待机/工作 P95 18/18ms，优化后 18/19ms；最大 18 → 19ms，均无 >33.33ms 间隔。探针在资源窗口之外，不能当作 GPU 逐帧截图或真实输入延迟。
- 每次窗口销毁后，宠物 WebContent 候选 PID 均退出；短窗口里没看到持续 DOM 增长。没有强制 GC、清产品缓存或通过移除可见功能改善数字。这不证明长时间、任意用户素材情况下无泄漏。
- E2E runner JavaScript 语法检查、`git diff --check`、`pnpm run check:repo-hygiene` 均通过。

可复现入口：[run-pet-performance.mjs](../../tests/e2e/scripts/run-pet-performance.mjs)、[成对运行器](../../tests/e2e/scripts/run-pet-performance-pair.mjs)。场景操作封装在独立 Page Object，采样不会调用外部模型。详细命令位于各自 AGENTS.md。

## 为什么保留现有播放器与图片

额外做了一次隔离诊断：暂停 WAAPI 自动时间线，按原始 400ms 帧边界手动推进。它仍显示六帧，但待机宠物 CPU **1.64%**、宿主 **2.59%**、GPU 进程 **0.30%**、宠物 RSS **196.50 MiB**。这只是单次实验，差值落在正式样本的波动范围内，未形成足够证据支持增加新的调度器和主题/动作中断恢复机制；实验没有进入生产代码，也不混入成对结果。

原图单帧恰好支持 2× 显示密度，本轮没有降分辨率。独立 WebView 的约 200 MiB 常驻成本没有被这几个局部修复消除。若后续要显著降低它，应单独剖析 pet bootstrap、CSS/JS 常驻与 WebKit 内存，并针对大量用户宠物建立有生命周期引用的缓存管理；简单淘汰仍被预览使用的 Blob URL 会引入失效图片，不适合作为本轮快捷优化。

## 适用范围与剩余风险

只有本机 macOS debug host 的原生性能证据，不能外推 Windows/Linux、release host、真实高频流式气泡或大量自定义宠物。用户 Blob 缓存仍按已访问 package 保留，长时间跨多个 package 的有界驻留需要单独设计；本次解决的是并发孤儿 URL 和失效请求回填。

远程工作区、远程控制、Peer Device、Detached Dispatch 均未实际运行。本次没有新增协议或配置形状，兼容性由已有 v1/v2/旧选择 fixtures 覆盖，但这些 fixture 不构成真实远程运行证明。
