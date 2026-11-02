# OpenBitFun Web UI 动效排查与优化清单

本清单覆盖 `src/web-ui` 的桌面端与 Server/Web 共用 React 前端。排查对象包括按钮、输入控件、菜单、Tooltip、Select、弹窗、抽屉、页面/面板切换、列表增删与排序、拖拽、滚动导航、进度与异步状态，以及 Flow Chat 和工具面板中的交互反馈。

## 三遍排查

1. **全量静态扫描**：逐目录检查 `app`、`features`、`flow_chat`、`infrastructure`、`shared`、`tools` 以及独立设计系统中的交互处理器、CSS transition/keyframe、无限动画、滚动行为与 reduced-motion。
2. **生命周期复查**：专查条件挂载、Portal、弹层 placement、快速重开、退出期数据快照、焦点与 `aria-hidden`/`inert`，以及列表删除、折叠、拖拽后的空间连续性。
3. **独立反向审查**：用高标准动效 review 再查一遍 transform 所有权、键盘路径、焦点交接、异步竞态、虚拟列表滚动稳定性和无障碍降级；发现的阻断项修复后重新验证。

可重复运行：

```bash
pnpm run motion:audit
```

该命令是意图清单，不机械替代人工判断。目前目标项均为 0：`transition: all`、`scale(0)`、未经审查的 JS smooth scroll、缺少局部 reduced-motion 的无限动画、重复全局 keyframe。

首轮修改前的静态基线约为 590 个 TSX、348 个样式文件、1464 个交互处理器属性、190 处 `transition: all`、382 个 keyframe 定义和 13 组重名 keyframe。最终审计覆盖 2080 个生产源文件和 1593 个交互处理器属性；新增交互来自退出生命周期、焦点与键盘支持，不是装饰动画。

## 优化清单

| 区域 | 排查到的不丝滑点 | 已完成优化 |
| --- | --- | --- |
| 动效基础与组件原语 | 时长/曲线不统一；Button、Input、Card、Select 等大量 `transition: all`；hover 放大未限制精确指针；Tooltip 双重入场 | 统一更短的 motion token 与 decelerate 曲线；显式列出属性；hover 仅限 fine pointer；按下反馈约 `.97`；Tooltip 单一动效所有权 |
| Dialog、Popover、Select、菜单 | 上层条件卸载使 Dialog 退出失效；自定义 overlay 只进不退；placement 翻转后方向错误；快速关闭/重开被 keyframe 抢占 | 统一使用 `RetainedMountBoundary`；Dialog 调用方、自定义 overlay、Select、模型/推理/会话树弹层均保留退出态与最后快照；按实际 placement 设置 origin；改为可中断 transition；退出期 `inert`/`aria-hidden`；键盘打开即时 |
| 通知 | 通知删除和堆栈重排跳变；进度条动画 width | 通知退出 retention 与堆栈收拢；进度改 `scaleX`；退出禁交互并清理 timer |
| Flow Chat | 选择器/文件弹层无退出；权限、运行状态、BTW 操作条瞬移；滚到底部控件闪现；TokenUsage 改高度/宽度；Pixel Pet 在 reduced-motion 下仍强行动画 | 补齐退出与焦点交接；权限快照绑定 session；BTW 退出期保留布局；运行状态固定槽 crossfade；高频滚动控件仅短 opacity；TokenUsage 固定 hitbox + `scaleX`；无限动效均有静止降级 |
| 列表、折叠与配置 | Context/Todo/权限规则删除后空间跳变；配置 disclosure 只有入口；Nav 主 section 被覆盖为无动画；Todo 编辑器关闭时内容/高度突变 | Context 行稳定退出；Todo 编辑器/日期详情冻结完整数据并同步收起布局；权限规则增删与排序用可取消 FLIP；配置 disclosure 使用 grid presence；Nav section 恢复 150ms 收拢 |
| 拖拽与排序 | Tab 与 Workspace 拖拽时邻项不让位、drop 后瞬移；Workspace drop line 作为 flex child 改变布局 | 拖动本体保持 1:1；邻项 120ms transform 让位；drop 后 160ms FLIP；drop line 改绝对定位，不再挤动列表 |
| 工具与功能面板 | File Explorer 2s 高亮与全局 smooth scroll；Git Graph pulse/scale；编辑器光标/匹配项高频 pulse；生成 Widget 每个 DOM 节点入场；SSH/Relay/Peer picker 等退出缺失 | 高亮缩至 240ms；自动/键盘滚动即时、仅显式定位保留 RM-aware smooth；移除高频 pulse/scale；Widget 根级一次淡入；SSH/Relay/Peer、自定义 diff/branch overlay 补齐退出和竞态保护 |

## 逐项落地索引

| 状态 | 交互面 | 落地点 |
| --- | --- | --- |
| 完成 | 全局时长、曲线与 popup fallback | `app/styles/motion.scss`、Appearance motion tokens；组件自有 motion 可显式排除全局 fallback |
| 完成 | Button、IconButton、Input、Textarea、NumberInput、Card、FilterPill | 移除 `transition: all`；限定变化属性；hover 只在 fine pointer 生效；按下反馈方向正确 |
| 完成 | Tooltip、Select、Search、NavSearch | 去除 Tooltip 双重入场；Select placement-aware presence；键盘选项/搜索输入保持即时；warm tooltip 不排队 |
| 完成 | 共享 Dialog 调用方 | 首次打开后由 `RetainedMountBoundary` 保留 owner，让 Dialog 自身退出真正执行；快速重开取消卸载 |
| 完成 | BranchSelect、Diff fullscreen、Peer directory picker | 自定义 overlay/surface 具备进出场、退出快照、焦点与异步竞态保护 |
| 完成 | ContextMenu | placement origin、100ms 退出、退出期 inert；补齐 roving focus、方向键、Home/End、Enter/Space、Escape 与子菜单焦点返回 |
| 完成 | Notification | Toast 退出 retention、焦点先移出再 inert、堆栈收拢；进度条由 width 改为 `scaleX` |
| 完成 | ModelSelector、ReasoningPreset、SessionTree、输入区弹层 | 根据实际 placement 决定位移和 origin；退出保留、快速重开、兄弟菜单清理与焦点返回 |
| 完成 | Permission、BTW、RuntimeStatus | 会话切换不残留旧权限卡；操作条退出时不塌布局；运行状态使用固定槽 crossfade |
| 完成 | ScrollToBottom、ScrollToLatest、TokenUsage | 高频控件只做短 opacity；退出前焦点回到消息滚动区；进度固定 hitbox + `scaleX` |
| 完成 | ContextList | 连续删除保持稳定顺序；160ms 收拢后提交；unmount 不丢删除意图；reduced-motion 即时完成 |
| 完成 | Todos editor、日期详情 | 保留完整 committed snapshot（含新建态）；内容与占位同步 160ms 收起；快速开关不闪旧数据 |
| 完成 | Global permission rules | 新增 150ms；删除 retention 120ms；上下移动使用可取消 WAAPI FLIP 160ms；退出禁交互并安全移焦 |
| 完成 | Config disclosure、Nav section | Grid presence 补齐收起；chevron 与内容同节奏；桌面 Nav 被覆盖的无动画规则恢复为 150ms |
| 完成 | Tab 与 Workspace 拖拽 | 拖动物体 1:1；邻项 transform 让位；drop FLIP；drop indicator 绝对定位避免挤布局 |
| 完成 | Update 与通知进度 | determinate 全部 `scaleX`；indeterminate 保留状态表达，reduced-motion 下静止可见 |
| 完成 | File Explorer、Git Graph、Generative Widget | 去除 2s paint、自动 smooth、pulse/scale 和逐 DOM 节点入场；只保留一次根级反馈 |
| 完成 | SSH、Relay、Dispatch、Canvas、Terminal、Git/Editor 工具 | 弹层退出补齐；generic keyframe 命名空间化；无限 spinner/pulse 均有局部 reduced-motion 静止态 |
| 完成 | Markdown、FlowChat tool cards、CodeEditor | 删除挂载 fade 与高频光标/匹配 pulse；虚拟/流式内容不因重挂载重复播放 |

## 明确不增加的动效

- 虚拟化消息行、流式 Markdown、工具卡挂载不做 fade/slide，避免滚动锚点与高度估算抖动。
- 键盘重复导航、搜索输入、Select option highlight、warm tooltip 保持即时。
- drag/resize 本体严格跟手，不加 easing；只让受影响的邻项和 drop settle 动。
- 场景快捷键切换不等待长退出；高频滚动按钮不做位移/弹簧入场。
- indeterminate loading 可继续表达“进行中”，但 reduced-motion 下必须静止且保持可见。

## 默认参数

- 直接反馈：80–120ms。
- 弹层/列表空间连续性：120–180ms。
- 大型 Modal：进入约 180–220ms，退出约 120–180ms。
- 位移通常 2–8px，scale 通常不低于 `.985`；不用 `scale(0)`。
- reduced-motion：取消位移、旋转、pulse 与滚动动画；必要时只保留不超过约 100ms 的 opacity。
