# Agent Hooks（生命周期钩子）

Hooks 让你在 OpenBitFun Agent 生命周期的固定节点运行自己的命令：工具调用前后、
即将弹出权限确认时、提交提示词时、上下文压缩前后、子 Agent 启动与结束时，
以及会话与回合的开始与结束。一个 Hook 可以观察 Agent 的行为、注入模型可见的
上下文、改写工具调用参数，或者直接阻止某个动作。

## OpenBitFun Hooks 就是 Codex Hooks

OpenBitFun 实现的是 **Codex Hook 契约**，不是 OpenBitFun 自己的方言：

- 同样的 `hooks.json` 文档 —— 事件、匹配组、处理器字段；
- 同样的事件名（`PreToolUse`、`PostToolUse`、`PermissionRequest`、
  `UserPromptSubmit`、`PreCompact`、`PostCompact`、`SessionStart`、
  `SessionEnd`、`SubagentStart`、`SubagentStop`、`Stop`）；
- 同样的 stdin JSON 载荷，字段名完全一致；
- 同样的退出码语义（`0` 成功、`2` 阻止且 stderr 作为原因、其他为非阻塞错误）；
- 同样的 stdout JSON 决策结构（`permissionDecision`、`updatedInput`、
  `additionalContext`、`decision`/`reason` 等）。

**Codex 的 Hook 脚本可以直接在 OpenBitFun 中运行，反之亦然 —— 不需要做任何适配。**

因此本文不重复参考手册。事件语义、各事件的确切载荷字段、决策结构，请直接查阅
Codex 自己的文档，它把这些写得很完整：

**→ <https://learn.chatgpt.com/docs/hooks>**

本文其余部分只讲 OpenBitFun 特有的内容：文件放在哪、怎么打开、以及目前哪里有差异。

## OpenBitFun 从哪里读取 Hooks

Codex 读 `~/.codex/hooks.json`，OpenBitFun 改为读自己的配置目录。文件内部结构完全相同。

| 层级 | 路径 |
| --- | --- |
| 用户 | `<用户配置目录>/config/hooks.json` |
| 项目 | `<工作区>/.openbitfun/config/hooks.json` |

用户配置目录在 Linux 为 `~/.config/openbitfun`，macOS 为
`~/Library/Application Support/openbitfun`，Windows 为 `%APPDATA%\openbitfun`。

两个层级是叠加关系：所有匹配的处理器都会执行，用户层优先，层级之间不存在覆盖或
屏蔽。修改后无需重启 OpenBitFun。

## 开启 Hooks

**设置 → Agent Hooks**，或直接编辑 `<用户配置目录>/config/app.json` 的 `app` 段：

```json
{
  "app": {
    "hooks": {
      "enabled": true,
      "project_hooks_enabled": true
    }
  }
}
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `app.hooks.enabled` | `true` | 总开关。`false` 会禁用所有 Hooks。 |
| `app.hooks.project_hooks_enabled` | `false` | 是否启用项目 Hook 文件。 |

**项目级 Hooks 默认关闭。** 项目 Hook 文件执行的是仓库中的命令，任何能提交代码的
人都可能借此在你的机器上执行代码。请只对你信任的仓库开启，并在拉取代码后重新
检查该文件。

Codex 的 `[features] hooks = false` 在 OpenBitFun 没有对应项，请使用
`app.hooks.enabled`。

## 导入 Claude Code 与 Codex 命令 Hooks

OpenBitFun 可以把 Claude Code 或 Codex 中兼容的 `type: "command"` Hook 保存为一份
经审阅的本地快照。这是一次显式复制，不是实时挂载其他产品的配置：

1. 打开**设置 → Agent Hooks**，或在 TUI 中运行 `/hooks`；脚本化查看可使用
   `openbitfun hooks list`。
2. 选择来源，并审阅每条实际命令、Windows 覆盖命令、超时、复制或外部依赖、
   跳过项以及计划指纹。
3. 确认这份确切计划。若来源在审阅后发生变化，OpenBitFun 不会写入，而是返回一份
   刷新后的计划，要求再次确认。

用户来源复制到 OpenBitFun 的用户托管数据；项目来源复制到 OpenBitFun 项目运行区内按工作区
隔离的数据。来源 `.claude/hooks` 或 `.codex/hooks` 目录下可安全解析的相对脚本依赖
会被复制到不可变快照。绝对路径依赖仍保留为外部依赖，并在审阅时明确显示；移动或
修改它可能在不更新快照的情况下改变行为。动态路径、通配符、路径逃逸、链接、不可读
文件以及超出固定导入上限的文件会被跳过，不会被隐式跟随。

每个已导入来源都可单独启用、停用、更新或移除。移除只删除 OpenBitFun 的托管副本，绝不
修改 Claude Code 或 Codex 文件；更新始终要求重新审阅实际命令。各层按以下固定顺序
执行：

1. 手工用户级 `hooks.json`；
2. 已启用的用户级导入，按稳定导入 ID 排序；
3. 手工项目级 `hooks.json`（项目 Hooks 已开启时）；
4. 已启用的项目级导入，按稳定导入 ID 排序。

导入、更新、启用、停用和移除会在下一个匹配的 Hook 事件生效；已经开始运行的 Hook
仍使用启动时捕获的快照完成。OpenBitFun 不会在启动时重新导入，也不会轮询或监听 Claude
Code/Codex 文件。请使用**刷新**或 `/hooks refresh` 检查来源变化，再显式审阅更新。
管理与执行均只支持本地工作区；远程工作区会明确返回不支持，不会用本地命令处理远程
路径。

OpenCode 插件 Hooks 明确不在本次范围内。其 JavaScript 回调依赖 OpenCode 插件执行域；
当前 OpenCode Hook 目录仍只用于发现和静态预览，不能执行。

兼容性页面现也发现 **DeepSeek Harness** 与 **PI** 的 Hook。Hook 管理页只读显示
来源、原生事件、禁用或不支持状态及发现诊断，刷新不会加载或导入第三方代码。

- DeepSeek Harness：读取 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh`）、
  `profiles/*/cordis.yml`、`cordis.patch.yml` 以及当前工作区的 Cordis 配置。
  显式 `dsh-hooks-claude-code` / `dsh-hooks-codex` 行通过 `config.configPath`
  指向 Hook 文件；相对路径以当前选定的启动工作区解析，没有工作区时明确显示无法解析。
  支持 insert/group 行及组禁用状态。Codex 桥接仅支持其五个事件，不支持异步命令；
  bundle 组装与运行时 Cordis 注册仍需原生运行时确认。
- PI：读取 `~/.pi/agent/extensions`（可用 `PI_CODING_AGENT_DIR` 覆盖）、
  `.pi/extensions` 与相应 `settings.json` 的扩展路径。支持 `.ts` / `.js` 文件、
  目录中的 `index.ts` / `index.js` 和本地 `package.json` 的 `pi.extensions`。
  默认导出函数或箭头函数里的字面量 `pi.on(...)` 事件仅作为原生声明显示；间接导出、
  动态注册、包安装与解析、动态选择器仍需 PI 自身处理。

Skill 标准根新增 `.dsh/skills`、`$DSH_HOME/skills`、`.pi/skills` 与
`$PI_CODING_AGENT_DIR/skills`（默认 `~/.pi/agent/skills`），追加到现有来源顺序。
DSH 支持直接子目录包和平铺 Markdown，PI 还支持嵌套分组和省略 frontmatter 名称。
平铺文件保留独立稳定键和入口文件名；旧目录数据仍默认使用 `SKILL.md`。自定义配置路径、
包提供或运行时发布的 Skill 不在本次标准根发现范围内；项目根使用当前工作区，不重现
原应用的祖先目录或 profile 解析。远程项目 Skill 通过工作区文件接口读取；远程工作区的
Hook 目录继续明确返回不支持。对应上游版本与源码链接见本页英文版。

根 CLI 对应命令如下：

```text
openbitfun hooks list [--refresh] [--format text|json]
openbitfun hooks import --source <source-key> [--confirm <plan-fingerprint>]
openbitfun hooks update <import-id> [--confirm <plan-fingerprint>]
openbitfun hooks enable <import-id>
openbitfun hooks disable <import-id>
openbitfun hooks remove <import-id> --confirm
openbitfun hooks reset <user|project> --confirm
```

未提供匹配指纹时，导入和更新只做预览。TUI 复用同一后端，并保留
`/hooks_external`、`/hooks-external` 作为统一 `/hooks` 管理视图的兼容别名。
`reset` 只用于显式恢复损坏的 OpenBitFun 托管索引，绝不会修改来源文件。

## 技能中的 Hooks

通过 `Skill` 调用 Claude 格式技能时，经过完整校验的同步 `type: command`
处理器会注册到现有 Hook 引擎，归属于当前会话。扫描、列表和导入不注册、不执行；
导入后的 Claude 技能保留来源方言，外部 Hook 目录仍然只是只读发现数据。

技能使用上文已支持的生命周期事件、正则 matcher、stdin JSON、退出码阻断和
`updatedInput`。执行顺序在配置的 command 层之后。同一会话重复加载不重复注册；
声明改变时明确报错，不静默替换已激活规则。`once: true` 仅在退出码为 0 后消费，
并发派发也只成功执行一次；退出码 2、其他失败和超时不消费。
同一模型响应先调用技能、再调用工具时，后续工具会等技能完成后再执行 Hook 与权限预检。

Claude 适配将 `Bash` 匹配到 `ExecCommand`，并双向转换 `command/cmd`。
`Write` 的路径前缀 `payload` 会转换成 `file_path/content`，返回的 `updatedInput`
再转换回本地格式并接受正常校验；有匹配的技能 Hook 时，无法确定写入目标的调用会被阻断。
`Edit` 沿用原参数。命令环境包含 `CLAUDE_SKILL_DIR`、`CLAUDE_SESSION_ID`、
`CLAUDE_PROJECT_DIR`；技能正文中的变量仍不会因此展开。

技能 `PreToolUse` 的 `permissionDecision: ask` 进入现有会话权限邮箱，携带 Hook
原因；即使启用了自动批准，也需要用户本次答复，已有权限拒绝仍然优先。
原生 `hooks.json` 保持 Codex 决策契约。

激活受 `app.hooks.enabled` 控制；项目技能还要求 `app.hooks.project_hooks_enabled`，
后续派发也遵守该开关。缺少所属会话、本地工作区或处于 SSH/远程工作区时明确拒绝激活，
不会回退到控制端本地执行。远程控制、Peer Device、Detached Dispatch 复用目标运行时
已有的会话和权限 owner，不增加客户端执行器。

注册跨普通回合及进程内空闲卸载保留；会话结束、删除或临时会话丢弃时清除并取消正在运行的
处理器，SessionEnd 派发被取消时也会清理。状态只存在于运行时内存，进程重启后需要重新调用技能。
未知事件、异步、`prompt/agent` 类型和未知执行字段会使整份技能加载失败，不会只丢弃部分约束。
脚本文件与原生命令 Hook 一样是实时依赖，声明指纹不代表脚本快照。

## 快速开始

创建 `<用户配置目录>/config/hooks.json`：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.command' >> ~/openbitfun-commands.log"
          }
        ]
      }
    ]
  }
}
```

新建一个会话，让 Agent 执行一条 shell 命令，它执行的每条命令都会追加到
`~/openbitfun-commands.log`。

一个会阻止操作的 Hook —— 这里拒绝修改 `migrations/` 下的文件：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "python3 ~/hooks/protect.py" }]
      }
    ]
  }
}
```

```python
#!/usr/bin/env python3
import json, sys

payload = json.load(sys.stdin)
if "/migrations/" in payload.get("tool_input", {}).get("file_path", ""):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "迁移文件由生成器产出，请改动 schema。",
        }
    }))
sys.exit(0)
```

## OpenBitFun 与 Codex 的差异

未在此列出的部分，行为与 Codex 文档所述一致。

### 不支持

| Codex 能力 | OpenBitFun |
| --- | --- |
| `config.toml` 的 `[hooks]` 表 | 不读取 —— 请把 Hook 写在 `hooks.json` |
| `[features] hooks = false` | 使用 `app.hooks.enabled` |
| 插件内置与托管 Hooks（`PLUGIN_ROOT`、`managed_dir`） | 不支持 |
| `prompt` 与 `agent` 处理器类型 | 会被解析（以便共享配置文件保持有效）但跳过 —— 只有 `type: "command"` 会执行 |
| 远程工作区 | 不派发 Hooks：本地 Hook 进程与远程工作区路径描述的不是同一个文件系统。跳过不是静默的：当宿主为该事件配置了规则时，每个会话第一次跳过会记录一条警告，Hook 概览也带有 `remote_workspace_unsupported`，供界面说明已配置的规则没有运行 |

### 尚未填充的字段

| 字段或事件 | 当前行为 |
| --- | --- |
| `transcript_path`、`agent_transcript_path` | 恒为 `null` |
| `permission_mode` | 只会是 `default` 或 `bypassPermissions` |
| `SessionStart.source` | 只有 `startup`；`resume`、`clear`、`compact` 尚未派发 |
| `SessionEnd.reason` | 恒为 `other` |
| `SubagentStop.stop_hook_active` | 恒为 `false` |
| `SubagentStop` | 仅在子 Agent 成功结束时派发；失败、取消或超时不会派发 |
| `Stop` | 仅顶层回合触发；子 Agent 回合通过 `SubagentStop` 上报 |

### 值得了解的行为

- **Hook 只能收紧权限策略，永远无法放宽。** `PreToolUse` 的
  `permissionDecision: "allow"` 只免去交互式确认；被权限规则拒绝的工具调用依然
  会被拒绝。
- `PreToolUse updatedInput` 在执行前会用最终参数重新校验。它可以修复普通的
  参数格式错误，但不能放宽已经拒绝原始参数的不可放宽内部约束（例如用户
  明确提出的编辑限制）。
- `suppressOutput` 会被解析，但当前被忽略。
- `continue: false` 对 `PreToolUse` 和 `UserPromptSubmit` 生效；其他事件请使用
  `decision: "block"`。
- `PostToolUse` 在工具返回错误结果时同样会触发，不只是成功时。
- 限制：单个 `hooks.json` 最大 1 MiB；所有层级最多检查 2048 个处理器（无效处理器
  和非 `command` 处理器同样计入）；单个 Hook 的模型可见文本上限 10,000 字节，
  超出会截断。

## 安全

Hook 是以你的用户权限运行的任意代码，且每次对应事件触发都会运行。请像对待 shell
配置文件那样对待 `hooks.json`：

- 启用任何非你本人编写的 Hook 之前先审阅它。
- 除非你信任所有能向仓库提交代码的人，否则保持项目级 Hooks 关闭。
- Hook 命令如果直接写文件，会绕过工具管道及其 `validate_input` 检查。工具参数重写
  应使用 `updatedInput`；无法接受外部进程副作时，应禁用不可信命令 Hook 或将其
  放入 sandbox。
- 载荷中的值（提示词、工具参数、文件路径）是模型和用户提供的文本。请按 JSON 解析，
  不要拼接进 shell 命令 —— 上面的示例正是为此用 `jq` / `json.load` 读取字段。
- 不要在 `SessionStart`、`UserPromptSubmit`、`SubagentStart` 中把密钥打印到
  stdout，这些事件的普通 stdout 会成为模型可见的上下文。

## 排查

| 现象 | 原因 |
| --- | --- |
| 完全没有 Hook 运行 | `app.hooks.enabled` 为 `false`、文件不在文档所述路径，或工作区是远程工作区（此时日志会为每个会话第一次跳过的派发记录一条警告）。 |
| 项目 Hooks 不运行 | `app.hooks.project_hooks_enabled` 为 `false`（默认值）。 |
| 整个文件被忽略 | JSON 无效，或存在 `description`/`hooks` 之外的根级字段。 |
| 某个事件被忽略 | 事件名拼写错误 —— 事件名区分大小写。 |
| 某个处理器从不运行 | matcher 不匹配，或 matcher 不是合法模式。matcher 是对整个值做锚定匹配的正则表达式，因此 `Bash` 匹配 `Bash` 但不匹配 `BashOutput`。 |
| `prompt`/`agent` 处理器从不运行 | 只有 `type: "command"` 处理器会执行。 |
| 阻止没有生效 | 阻止需要退出码 2（原因写入 stderr），或退出码 0 时在 stdout 输出 `decision`/`permissionDecision` 字段。 |
| 模型看不到普通 `echo` 输出 | 只有 `SessionStart`、`UserPromptSubmit`、`SubagentStart` 会把普通 stdout 转为上下文；其他事件请使用 `hookSpecificOutput.additionalContext`。 |

配置问题、非零退出、超时以及 Hook 决策都会写入 OpenBitFun 后端日志。提升日志级别的
方法见 [`src/crates/LOGGING.md`](../../src/crates/LOGGING.md)。

## 相关

- CLI 的 `/hooks` 同时展示手工与导入层，异步发现受支持的外部来源，并提供上述导入
  管理操作。只有手工 OpenBitFun 层需要直接编辑 `hooks.json`。
- `/hooks_external` 与 `/hooks-external` 是同一视图的兼容别名，不会形成第二套导入或
  执行路径。
