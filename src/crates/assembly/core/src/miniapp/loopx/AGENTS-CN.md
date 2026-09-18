**English** | [中文](AGENTS.md)

# LoopX 宿主子系统指南

范围：BitFun 对 LoopX 受控工作的宿主适配层，横跨两个 crate：

- `src/crates/assembly/core/src/miniapp/loopx/` — controller（调度、结算应用、恢复）、agent 适配器、会话生命周期
- `src/crates/services/services-integrations/src/miniapp/loopx_cli.rs` — 固定版本 CLI 适配器：guard/turn/settle 命令形状、turn 指令组装、结算证据验证
- `src/crates/services/services-integrations/src/miniapp/loopx_workspace.rs` — worktree 生命周期（prepare/dispose/reset）

Codex 运行 LoopX 不需要任何宿主定制逻辑；这一层是 BitFun 的产品差异所在，
因此其规则比通用 agent-loop 指引更严格。

## 结算契约

一个 LoopX turn 只有拿到**两件套回执**才算结算：与该 turn guard 绑定
（选中的 todo 或 replan 义务）匹配的持久写回，以及同一 effect id 的配额
花费回执。Prompt 指引要求 agent 产出两者；验证永远不信任文字声称。

## 宿主兜底原则

**Prompt 加固只能降低 agent 出错的概率；只有宿主侧补偿才能消灭这一类失败。**
多步收尾序列（写回 → 花费 → 终态 vision）依赖模型自愿执行每一步，实测
有时不会。选择修复方式的规则：

1. **机械的、可从宿主状态推导的步骤归宿主。** 如果 controller 已持有
   确切值（guard 绑定、turn id、已记录 vision patch、spend 命令形状），
   由宿主生成或补偿该步骤，而不是让 agent 重新推导。例：settle 路径
   自行补偿缺失的配额花费（`quota_spend_compensation_args`），因为 spend
   是幂等记账，不是语义声明。
2. **语义步骤留给 agent，但宿主预先解析其输入。** 终态 vision packet 必须逐字
   复用已记录的 durable 字段；宿主通过 CLI 自己的 status 投影查询已记录
   vision 并嵌入 turn 指令，让 agent 复制而不是创作。
3. **永远不伪造证据。** 宿主补偿必须可审计且幂等；补偿的 spend 要记日志，
   永久缺失的回执要响亮降级（恢复卡片），绝不静默。

## 已知 agent 失败模式与防线

实测出现（2026-09-10 三 issue 实验）并已有防线——出现新模式时保持更新：

| 失败模式 | 防线 |
| --- | --- |
| 终态 vision packet 改写了 durable 字段 → `outcome=replan` 与 `no_followup` 不可满足对 | 宿主逐字嵌入已记录 vision + 逐字符比对指令（`render_agent_reentry_instruction`） |
| turn 中途创建 successor todo 并用 `--todo-id` 结算绑定在 replan 义务上的 turn | work clause 中的 turn 作用域绑定规则；CLI 拒绝，下一个 turn 自愈 |
| 写回验证通过但跳过配额花费 | `verify_turn_settlement` 的宿主侧 spend 补偿；prompt 标记 spend 为 MANDATORY |
| 停止后 workspace 根目录重命名失败（残留句柄） | 有界退避的重命名重试 + turn 取消等待完全排空 |

出现新失败模式时，先判断该步骤是机械的（宿主补偿）还是语义的（宿主预解析
输入），然后在该层修复。不要只靠堆更多 prompt 文本来响应重复的 agent 错误。

## 验证

```bash
cargo test -p openbitfun-services-integrations --no-default-features --features miniapp-loopx --lib -- loopx_cli
cargo test -p openbitfun-services-integrations --no-default-features --features miniapp-loopx --test miniapp_loopx_contracts
```

修改 turn 指引时增改指令组装测试；修改补偿逻辑时增改结算测试。
