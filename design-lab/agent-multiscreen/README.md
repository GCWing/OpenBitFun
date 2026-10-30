# Agent 多屏拓展 · 概念 Demo 说明

> 单文件 Demo：[device-hub-popout.html](device-hub-popout.html)
> 语法回归检查：[check-demo.sh](check-demo.sh)（改完先跑，再加载页面）
> 定位：**验证工具，不是交付物**。用来确认「Agent 多屏拓展 + tab 级跳出」这个方向值不值得做、具体怎么做。
> 仓库源码未做任何改动（`openbitfun/` 保持原状）。

---

## 一、怎么看

```bash
# 先 cd 进本目录（device-hub-popout.html 所在处），再起静态服务
python3 -m http.server 8099
# 打开 http://127.0.0.1:8099/device-hub-popout.html
```

> 下面所有脚本和存档都用**本目录内的相对路径**称呼（`./audit.mjs`、`./_archive/`），
> 这样这份 README 和这堆文件整体搬到仓库任何位置都成立。

**进页面就会自己播。** 不需要点任何东西——虚拟光标会真的去点按钮、拖窗口，字幕在下方同步讲解，走完整段故事后循环。

| 操作 | 结果 |
|---|---|
| （什么都不做） | 自动播放整段演示并循环 |
| 头部 ▶ / ⏸ 或按**空格** | 暂停 / 继续 |
| 头部 ↺ | 从第 1 步重播 |
| 用鼠标点任意地方 | **立刻交出控制权**，自动演示暂停并提示「已接管」——之后完全手动操作 |
| 头部「重置」 | 状态归零（不影响播放） |

想看纯手动版本（不自动播）：打开 `...?manual=1`。
系统开了「减弱动态效果」时不会自动播放，也不会跑动画。

也可以直接双击 HTML 文件（file:// 可用，但「真实窗口」那条路的状态同步可能被同源策略挡住）。

---

## 二、视觉：直接用毕方自己的设计系统

> ⚠️ **本节已改写两次，请以本节为准。**
> 第一版是「对齐毕方官网」的高保真手写样式；第二版按「要低保真的感觉」整体推翻成灰块线框；
> **现在这版把线框也推翻了** —— 线框是「我模仿设计系统」，而这版是**真的把设计系统装进来**。
> 历史存档在本目录的 `_archive/`（**未随仓库推送**，只在本地保留）：`*.hifi-*.html`（高保真）、`*.pre-ds-*.html` / `*.pre-detoken-*.html`（线框与去别名层之前）。

### 做法：内联真设计系统，而不是模仿它

`<style id="openbitfun-design-system">`（在 demo 自己的样式块**之前**）内联了两份真源码：

| 内联的 | 来源 | 取了多少 |
|---|---|---|
| token | `design-system/packages/design-tokens/dist/tokens.css` | **全文 754 行** |
| 主题 | `design-system/packages/theme-openbitfun/dist/themes.css` | **仅 light 主题块第 1–175 行**（暗色 / 高对比是死重量） |

`<html>` 挂 `data-openbitfun-design-system-root`。已实测解析成功：`surface-canvas #fdfdfd`、`radius-pill 9999px`、`control-height-md 40px`、`component-button-fill-background rgba(0,0,0,.08)`。

**自造的 `--ob-*` 别名层（36 个）已全部删除**，全量改用真 `--openbitfun-*` 名。现在 demo 自己的 `:root` 只剩两项：`--demo-logo`（base64）和 `--fit`。

### 一个被这次改造纠正的判断

真色板里 `canvas #fdfdfd` / `chrome #f8f8f9` / `workbench #f3f3f5` / `border-default rgba(16,26,39,.15)` —— **就是 demo 改之前的 token 值**。也就是说真系统本来就靠**三档 border** 分层，不靠填充。我中途那轮「加填充、减描边」其实是**改偏离了设计系统**；这轮把 18 处结构描边（`.screen` / `.titlebar` / `.rail` / `.panel` / `.composer` / `.viewport` / `.detached` / `.placeholder` 虚线 …）按真 token 全部恢复。

### 组件对照表（每个配方都注明源文件，属性名与真组件同契约）

用 `data-openbitfun-variant` / `data-tone` / `data-size` / `data-openbitfun-shape` / `aria-pressed` / `aria-checked` 驱动，和真组件一致 —— 这样从 Demo 抄回组件时属性名不用翻译。

| Demo 里的类 | 真组件 | 源文件 | 用在哪 |
|---|---|---|---|
| `.ds-btn` | Button | `Button.module.css` | 页头「重置」 |
| `.ds-icon-btn` | IconButton | `IconButton.module.css` | 播放 / 重播、发送键、左轨图标 |
| `.ds-pill` | StatusPill | `StatusPill.module.css` | 每块屏顶部的「装了啥」、卡片状态 |
| `.ds-seg` | SegmentedControl | `SegmentedControl.module.css` | 缩放缓切、列表/看板、预览目标 |
| `.ds-kbd` | KeyHint | `KeyHint.module.css` | 快捷键提示 |
| `.ds-avatar` | Avatar | `Avatar.module.css` | 对话头像（Agent 侧 `data-tone="primary"`） |
| `.ds-switch` | Switch | `Switch.module.css` | 组件矩阵 |
| `.tab` / `.tab__pop` | TabGroup | `TabGroup.module.css` | 预览面板 tab 条（`data-size="sm"` 档） |
| `.target` / `.target__*` | Listbox | `Listbox.module.css` | 两块副屏里的「预览目标」设备单选列表 |
| `.hub__group-title` | Listbox `.groupLabel` | `Listbox.module.css` | 列表分组标题 |
| `.tile` / `.tile__*` | Card | `Card.module.css` | 页面预览里的三张卡片（`data-appearance="raised"` + `data-radius="md"` + `data-padding="sm"` + `data-gap="sm"`） |
| `.placeholder` / `.placeholder__*` | Empty | `Empty.module.css` | 面板空态（`__icon`←`.media`、`__title`←`.title`、`__desc`←`.description`、`__row`←`.actions`） |

### Card 带来的一处视觉变化（要推翻只需改一个字）

真组件 `Card` 的 `data-appearance` 只有 `raised` / `subtle` / `neutral` 三档，**没有「有边无投影」这一档**。三张卡原来的底和边（`surface-panel` + `border-subtle`）恰好等于 `raised` 的定义，但 `raised` 还会加 `shadow-overlay`（`0 4px 20px rgba(0,0,0,.12)`）—— 所以卡片现在有投影了。

不想要就把 `data-appearance="raised"` 换成 `"subtle"`（那会变成 `surface-tertiary` 灰底、无边无影）。

### 为什么没用 Capsule

`Capsule.module.css` 只有 **14 行**：一个 `display:inline-flex` 的外壳 + 四个尺寸档只改 `--_floating-action-host-height`。它**没有任何视觉**（无背景、无边框、无内边距、无字阶），是给别的组件当浮动操作宿主用的。把 surface 标识套上去等于什么都没换。

那个 `browser-detached` 标识改用 **StatusPill 的中性 tone**（`.ds-pill`，不传 `data-tone`）：底色 `action-neutral-surface` 与原来的 `key-hint-background` 同为 `rgba(0,0,0,.08)`，所以底色没变，只有字阶从 mono 变成 meta。

DS 里还有一个 `KeyHint`（`.ds-kbd`），视觉上和原来的 `.badge` 逐项相同（mono + key-hint-background + radius-xs）。但那是个**键盘按键**语义，拿去当环境标识是挪用，所以没选它。

尺寸档一律用真组件的 `data-size`：`xs` → `control-button-xs-height`（Button，24px）/ `control-icon-button-xs-size`（IconButton，22px）。**没有自造的尺寸值。**

`.ds-btn` / `.ds-icon-btn` 的图标尺寸也走 token（`control-button-xs-leading-icon-size`、`control-icon-button-xs-icon-size`）—— SVG 上的 `width`/`height` 属性优先级低于 CSS，所以这条规则能盖住 markup 里写死的数字，不用去改每一处。

### ⚠️ 一个一直没被发现的缺陷：没有 `border` 重置

本文件全局只重置了 `button { font: inherit; color: inherit }`，**没有 `border: 0`**。于是每一处没显式写 `border` 的 `<button>` 都在渲染**浏览器默认按钮描边**——它们看起来像"手绘的重框"，其实是 UA 样式，不是设计。踩到的有两处：

| 类 | 症状 | 现在 |
|---|---|---|
| `.target` | 设备列表每行一圈重框 | Listbox 的 `.option` 自带 `border: 0`，消失 |
| `.btn` / `.btn--primary` / `.btn--quiet` / `.btn--tiny` / `.icon-btn` | 弹出窗标题栏的「跳出 / 收回 / 真实窗口」一圈重框，`收回` 甚至看着像双层边 | 整套删掉，换成 `.ds-btn` / `.ds-icon-btn`（各自带 `border: 0` 或按变体给边） |

这也解释了为什么之前几轮"描边"来来回回改都不对味：**有一半的边根本不受我控制。**

`.tab` **保留旧类名**是因为演示脚本按 `.tab.is-active` 定位命中点；但形态已换成真 TabGroup —— 不是下划线 tab，是**带边框的药丸**，选中态靠 `color-selection-surface` 填充 + border 转透明。已跳出的 tab 走真组件的 `:disabled` 档 token。

### logo 与一个实测结论

官方资产：`design-system/packages/ui/src/brand/assets/openbitfun-app-icon-128.png`（黑底圆角方块 + 白色六边形环），已以 base64 data URI 内联进 `.brand-mark`。

**官方 SVG `openbitfun-mark.svg` 不能用于小尺寸**：它是 15 道 0.2px 错位细线叠出的六边形网格，**实测 48px 起就糊、30px 几乎不可见**，做不了 30px 品牌角标。改用官方光栅图标后 30px 清晰。

### 屏内不再是灰块

| 区域 | 之前（线框版） | 现在 |
|---|---|---|
| 对话 | 骨架条，不写文案 | **真文案**，且内容本身就是论点：Agent 一边聊一边把结论写回 PRD |
| PRD | 标题条 + 灰条 + 斜纹框 | 真标题 + 版本行 + 「评审中」StatusPill + 编号章节 |
| 页面预览 | 4 个骨架格 + 3 张空卡片 | SegmentedControl + 筛选 StatusPill + 3 张真卡片（带状态 pill） |
| 组件矩阵 | 4×4 灰块 | 4×4 真控件实例（Button / Pill / Seg / Kbd / Avatar / IconButton / Switch）+ 下标组件名 |
| 机型清单 | 平板 / 手机 / 手机·大 / 手表 | 同上，**保留真实尺寸**（1024×1366 / 393×852 / 430×932 / 205×251） |

线框版当时留了一句代价说明：「屏内没有真实文案后，Demo 不再能证明『Agent 真读得懂文档内容』」。**这一版把这个证据补回来了** —— 这也是推倒线框版的直接原因。

### 页头直接落画布

页头去掉了白卡片底（无 background / 无 radius / 无 padding-inline），直接落在画布上。

---

## 三、版面：主屏在上，两个副屏并列在下

```
┌──────────────────────────────┐
│  Display 1 · 主屏（620×420）  │   主屏独占整行、居中
└──────────────────────────────┘
┌────────────────┐  ┌────────┐
│ Display 2 横屏  │  │ D3 竖屏 │   两块副屏并列
│   620×340      │  │ 330×420│
└────────────────┘  └────────┘
```

用 CSS Grid 实现（`.displays` 两列，`Display 1` 跨两列），**没有改 HTML 结构**：

```css
.displays { display: grid; grid-template-columns: auto auto; justify-content: center; }
.display[data-display="1"] { grid-column: 1 / -1; justify-self: center; }
```

整块台面按 `--fit` 缩放以适配视口。**这里修掉了一个真实缺陷**：`transform: scale()` 不改变布局盒尺寸，缩放后包装盒仍按原始高度占位，下方留出一大片空白（上一版截图里那段空白就是这个，我先前误判成「两端对齐的留白」）。现在 `fitDesk()` 会把包装盒压到缩放后的真实高度，并按**宽和高同时**求解缩放比（原来只看宽度），页面不再出现滚动条。

### 屏占得更大：把独立的一行状态栏吃掉

原先画布上方有一条独立的「Agent 视野」横条（跨屏数 + 三块屏的 chip + 一句说明）。它占掉 55px 高度外加 18px 间距，**这 73px 是直接从屏的高度里扣的**。现在这条横条被拆开，各自落到更该在的位置：

| 原来在横条里的 | 现在在哪 |
|---|---|
| 「Display 2 · PRD」「Display 3 · 空闲」 | **标到那块屏自己的标签上**，点一下聚焦该屏（`focus-display`，保留原行为） |
| 「Agent 视野 · 跨 N 屏」 | 收进页头，和品牌 / 概念 chips 同一行，**不额外占高度** |
| 「这些画布上的内容 Agent 都能读」 | 变成该徽标的 `title`，鼠标悬停可读 |

状态位有三种视觉状态，避免三块屏看起来像三种不同组件：

| 状态 | 用在 | 视觉 |
|---|---|---|
| 常态 | Display 1（主屏，永远有内容） | 中性底 + 细描边 |
| `is-idle` | 副屏空着 | 更轻：无底无描边 + 空心小圆点 |
| `is-busy` | 副屏上放了东西 | 强调色底 / 描边 + 加深文字 |

另外把「这块屏忙不忙」收敛到了 `renderDisplayStatus()` 一处：原先渲染、拖动、丢弃三处各自维护 `is-busy`，删掉那个横条时顺手合并，少一个会忘记同步的地方。`Agent 视野 · 跨 N 屏` 的计数也顺手改成**按实际占用的屏数**（只占 2 块屏就报 2），原来是"只要有 tab 跳出就一律报 3 屏"。

同时收紧了留白：`.desk` 间距 18→14、下内边距 36→20、缩放求解里的留白余量 16→8、网格间距 24→20、屏内标签间距 9→7，并把 `.desk` 的宽度上限 1080→1120px（外边距 40→32）。

**放大效果（1200×854 视口实测）**：

| | 消融前 | 现在 |
|---|---|---|
| `--fit` 缩放比 | 0.690 | **0.806** |
| Display 1 主屏实际渲染宽度 | 428px | **500px** |
| 不参与缩放的 chrome 高度 | 215px | **114px** |

**+16.8%**。顺手修掉一个隐患：`fitDesk()` 原来用 `window.innerWidth - 40` 估算可用宽度，忽略了 `.desk` 自身 `min(1120px, 100% - 32px)` 的上限，宽窗口下会高估；现在直接取 `.desk` 的真实可用宽度。

### 窄窗口降级（文件里唯一一处媒体查询）

页头**不参与** `--fit` 缩放，宽度不够时只能靠让位：

```css
@media (max-width: 560px) { .vision-badge { display: none; } }
```

这条 880px 档的 `.concept { display: none; }` 已经删掉了 —— 概念 chips 在转低保真时整体移除，规则随之失效。

> 补一句当时测出的结论（对现在的页头仍有参考价值）：**窄窗口下页头并不会溢出**，flex 会被动收缩兜住；真正的代价是内容被压扁（当时实测胶囊 57→46px，−19%）。所以这类断点的依据是「压扁难看」，不是「怕溢出」——两者别混。现在是「品牌 + 视野文字 + 操作区」，自然宽度远小于之前，560px 这档已经够用。

---

## 四、交互规格

### 数据模型（每个 tab 一份）

| 字段 | 取值 | 说明 |
|---|---|---|
| `where` | `null` \| `'display-2'` \| `'display-3'` \| `'window'` | 统一落点字段，面板 / 副屏 / 真实浏览器窗口三态共用 |
| `device` | 设备 id | 每个 tab 独立 |
| `zoom` | `'fit'` \| `'100'` | 每个 tab 独立 |
| `win` | `{x, y, w, h}` | 副屏内浮窗几何，按所属屏坐标缓存 |

`where !== null` 即视为「已跳出」（`isPopped`）。

### 关键交互序列

```
跳出单个 tab：点跳出 → 选落点（第一块空闲副屏，否则 Display 2 级联）
            → tab.where 置 display-N → 若是激活 tab，activeId 置下一个未跳出的 tab
            → renderAll → 幽灵元素从面板飞到目标位置 430ms

自动顶位：  从当前 tab 往后扫描，遇到第一个未跳出的就顶上；扫到末尾回绕
            全部已跳出时保持原位不变（此时面板只剩占位清单）

跨屏拖动：  pointerdown 标题栏 → 拖动中按窗口中心命中屏框 → 命中即 appendChild 重挂载
            → 换算成新屏的 CSS 坐标 → 换到更小的屏时收敛尺寸（下限 150×140）
            → pointerup 整树重渲染，让 tab 角标 / 占位符 / 屏名标签全部跟上

收回：      点收回 → tab.where 置 null → 该 tab 变成激活 tab → 幽灵飞回面板
真实窗口关闭：轮询 popup.closed → 自动执行收回
```

### 边界规则（已实现）

- **Display 1 不接受浮窗**：它是主窗口本身，拖过去不生效。
- **换小屏自动收敛**：窗口从横屏拖到竖屏时按新屏可用宽高收缩，不会溢出被裁。
- **全部跳出后**：面板显示占位符 + 全部收回清单，「跳出」按钮置灰。

### 缩放策略

- **适应**：`k = min(1, 画布可用宽 / 设备视口宽)`，视口 `transform: scale(k)`，外层 sizer 按 `宽×k / 高×k` 撑开。
- 三处渲染（面板 body、副屏浮窗、独立 surface）共用 `applyZoom()`，靠 `canvas.closest('[data-tab]')` 解析所属 tab。

---

## 五、自动演示是怎么实现的

**光标是虚拟的，操作是真的。** 每一步调的都是手动点击时那套函数（`popTab` / `recallAll`）；拖动那一步甚至派发真实 `PointerEvent`，走的是和手动拖动完全同一条代码路径。所以演示不会「演一套、实际另一套」。

```js
const STEPS = [
  { say: '三块屏：主屏在改需求，副屏留给 Agent 把要看的东西铺开。' },
  { say: 'PRD 先跳到 Display 2 —— 长文档需要横向空间。', focus: 2, target: '#popBtn', action: … },
  { say: '跳走的 tab 从面板让位，页面 1 自动顶上。',      target: () => $('.tab.is-active') },
  { say: '页面 1 再跳到 Display 3 —— 一边看 PRD，一边看页面。', focus: 3, … },
  { say: '每块屏装了什么，就标在那块屏上方 —— Agent 读得到，你也一眼看得见。', target: () => $('.display[data-display="3"] .display__status') },
  { say: '页面 2 也铺开 —— 级联错位，不互相遮挡。',        focus: 2, … },
  { say: '落点不合适？直接把窗口拖到另一块屏。',           drag: { tabId: 'prd', toDisplay: 3 } },
  { say: '要专注的时候一键收回：屏幕跟着任务走，而不是任务挤在一块屏里。', … },
];
```

每一步 = 把光标移过去 → 按下（涟漪 + 目标高亮）→ 执行 → 停留。配套：

- **字幕条**：深色圆角、`1 / 8` 步序，`aria-live="polite"`
- **聚光**：非当前步骤的屏压暗（`opacity .34` + 去饱和）
- **进度**：顶部 2px 进度条 + 头部步点
- **中断**：所有等待都用 token 守卫，暂停/接管时正在跑的拖动会补发 `pointerup`，不留悬挂状态

---

## 六、本轮验证结果

**已验证**（内置浏览器实跑，`http://127.0.0.1:8099/...`）：

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 进页面自动播放 | ✅ 850ms 后启动 |
| 2 | 字幕 / 步点 / 进度 / 聚光同步 | ✅ 抽查 4/8 步：字幕、`is-now` 步点、`scaleX(0.5)`、Display 1+2 压暗、Display 3 聚焦 |
| 3 | 完整循环 | ✅ 40s 观察到进入第二轮 |
| 4 | 拖动那一步 | ✅ 真实指针事件驱动，PRD 从 D2 拖到 D3，角标 / 屏名标签 / 几何（302×296 自适应竖屏）全同步 |
| 5 | 运行时错误 | ✅ 40s 内 `error` / `unhandledrejection` 均为空 |
| 6 | 元素泄漏 | ✅ 涟漪与幽灵元素残留计数 0 |
| 7 | 两行版面 | ✅ 主屏居中在上、两副屏并列在下；`scrollHeight == 视口高度`，无滚动 |
| 8 | 交互回归 | ✅ 连跳 4 个 tab 分布正确、自动顶位、全部收回后视图恢复 |
| 9 | 消融后回归 | ✅ 说明条移除后 tab 条仍有 4 个 tab、副屏空闲态正常；实测点占位列表的「收回」能把 tab 召回（面板从占位列表切回真实设备视图）；`scrollHeight == 视口高度`，无 JS 报错 |
| 10 | 分析脚本误判的捕获与修复 | ✅（反面记录）初版脚本误报 `$$` 为死码、删掉后初始化抛 `ReferenceError`；`node --check` 语法通过、**静态检查查不出**，靠「进页面是否自动播放 + 是否无滚动」两条行为断言抓出；恢复后复测 `playing: true` / `fits: true` / 字幕正常推进 |
| 11 | 状态栏下移进画布 | ✅ 页头徽标 `Agent 视野 · 跨 N 屏` 计数随实际占用屏数变化（只占 2 块屏就报 2，不再一律 3）；三块屏标签各自的状态位随跳出/收回逐个更新；点状态位触发 `focus-display` 聚焦；召回后计数回 1、三块屏全部转「空闲」 |
| 12 | 放大后的版面 | ✅ `--fit` 0.690 → **0.806**，主屏渲染宽度 428 → **500px**（+16.8%）；chrome 215 → 114px；`scrollHeight == 视口高度`，无滚动、无报错 |
| 13 | 窄窗口降级 | ✅（已过时但保留记录）当时验证 `(max-width: 880px) → .concept` 与 `(max-width: 560px) → .vision-badge` 均被解析；模拟 704px 台面：chips 显示时胶囊被压缩 57→46px（−19%），隐藏后各元素恢复自然尺寸。**低保真改造后 `.concept` 已删，880px 那档规则一并移除** |
| 14 | 低保真改造后回归 | ✅ 交互全链未受影响：跳出/顶上/拖动/收回/真实窗口/自动演示均正常；线框占位渲染正确（组件矩阵 4×4 = 16 格、页面骨架 4 个筛选格 + 3 张卡片、文档骨架）；`scrollHeight == 视口高度`、零 JS 报错 |
| 15 | 工具栏折行缺陷 | ✅ 修前 Display 3 窄窗口里「适应」被折成两行；修后实测 6 个分段按钮高度均为 16px（= 20px × 0.806 缩放），工具栏 25px，无折行 |
| 16 | 死码审计 | ✅ 死变量 0 / 死类 0 / 死符号 0。顺带修掉 `audit.mjs` 自身一处误报：它的"动态拼接"启发式里有个 `x${...}y` 分支会匹配全文任意模板插值，等于恒为真，导致 `titlebar__surface`、`wire__block` 两个真死类被误判为"动态保留" |
| 17 | 真设计系统内联 | ✅ 实测 token 解析成功（`surface-canvas #fdfdfd` / `radius-pill 9999px` / `control-height-md 40px` / `component-button-fill-background rgba(0,0,0,.08)`）；全量对账「引用的 `--openbitfun-*` vs 已定义的」= 180 / 860，**未定义却被引用 0 个** |
| 18 | 控件换真组件配方 | ✅ 页头 3 个控件 + 左轨 3 个图标 + 发送键 + tab 条 + 缩放缓切 + 每屏状态 pill 全部走真配方；`.tab` 换成 TabGroup 形态后演示脚本的 `.tab.is-active` 命中点仍正常 |
| 19 | 竖屏副屏工具条裁切 | ✅（本轮修）修前 Display 3 的 seg 右边缘超出工具条 30px、`100%` 被裁成 `10`；修后四块工具条 `segClipped` 全为 `false` |
| 20 | 两块副屏的「预览目标」换 Listbox | ✅ 实测 `border 0px none`、`min-height 30px`、`radius 8px`、`padding-inline 8px`（= `overlay-menu-item-*`）；选中态 `rgba(0,0,0,.08)`（= `color-selection-surface`）；名称 `13px/15.6px`（= `type-label-md`）、尺寸行 `rgb(106,106,106)`（= `content-muted`）；`::before` 为 `normal`（手搓黑竖条已删除） |
| 21 | 旧按钮体系整体移除 | ✅ `.btn` / `.btn--primary` / `.btn--quiet` / `.btn--tiny` / `.icon-btn` 共 5 个类、8 处 markup 全删；实测标题栏 `border 0px`、图标按钮 22px、文字按钮 24px（= `control-icon-button-xs-size` / `control-button-xs-height`） |
| 22 | 语义状态色与「去色」要求不冲突 | ✅ 核实状态色板：success `#12722a` / info `#2360c2` / warning `#8a4c00` / danger `#bd1b19` —— **均非**青色 `#059cb0`。青色只出现在 `component-button-text-content`（`text` 变体）与 `accent-*`，本 Demo 一个都没用，故早前「去色不要青色」仍然成立（`text` 变体也因此**刻意不用**） |
| 23 | Card 换装 | ✅ 实测 `data-appearance="raised"` / 底 `rgb(255,255,255)` / 边 `1px rgba(16,26,39,.08)` / 圆角 `12px` / 内边距 `12px`（后两者与手写版一致）/ 投影 `rgba(0,0,0,.12) 0 4px 20px`；`header` / `header-content` / `footer` 三个槽位齐全 |
| 24 | Empty 换装 | ✅ 实测 `gap 10px` / `padding 32px 16px` / media `32px` / 图标色 `component-empty-media`；`__where` 已是 `ds-pill` + `ds-pill__dot`；`badge` 已是中性 `ds-pill` |
| 25 | 面板空态内容被裁（本轮发现并修） | ✅ 修前 `.panel__body` 是 `overflow-y: visible`，`scrollHeight 423` / `clientHeight 255` → **168px 内容被裁且无滚动条**，4 行「收回」基本点不到。修后 `overflow-y: auto`，滚到底可达（`maxScroll 180` = `scrolledTo 180`） |

**未验证 / 测不了**：

- **真实屏幕尺寸下的窄窗口渲染**：内置浏览器面板宽度是调用方给的，改不了；第 13 项是用「把 `.desk` 宽度设成 704px」模拟的，验证的是布局算术，不是媒体查询的真实触发（触发条件本身只是一条 CSS 声明，已确认被解析）。
- **真实 `window.open`**：浏览器要求真实用户手势，自动化触发不了。跨窗口 `postMessage` 同步、`popup.closed` 自动回收逻辑**从未实际跑过**，需要手动点一下验证。
- 真实多显示器下的实际摆放效果（`window.screen` 坐标判断）。
- 键盘可达性全链路（部分已做：按钮可 Tab、空格播放/暂停、`Esc` 收回）。
- 单色方案在真实色觉障碍用户下的可读性（这是去色的已知代价：状态只能靠文案区分）。

---

## 七、消融实验：系统性摘掉沉冗

做法是**先取证再动手**：分析脚本（死类 / 死变量 / 死 JS 符号、函数体量 / 重复 SVG / 内联 style）逐项跑，每删一项都有引用计数支撑，删完再复查一遍有没有误删在用的东西。

**结论先说：这个文件不臃肿。** 大部分"看起来像沉冗"的东西经查证属于**必要复杂度**，真正能删的只有 3 类。

### 已删（都有两种独立方法交叉验证）

| 项 | 取证 | 量 |
|---|---|---|
| 10 个死 CSS 变量 | `var()` 引用数 = 0，`var()` 引用与裸字符串出现次数两种方法同时为 0 | ≈ −0.6k 字符 |
| 底部说明条 | 3 条信息里 2 条别处已有（见下） | −5 行 markup、−4 条 CSS 规则 |
| 内联 `style="height:20px;padding:0 6px"` | 绕过 token 体系 | → `.btn--tiny` |

删掉的变量：`--ob-info` `--ob-info-content` `--ob-info-border` `--ob-info-surface` `--ob-warning` `--ob-accent-2` `--ob-serif` `--ob-shadow-base` `--ob-subtle` `--ob-r-2xl`

> ⚠️ 当时只删了 `--ob-warning` **本身**——同区块的 `--ob-warning-content / -surface / -border` 和整组 `--ob-success*` 都还在用，没有连坐。
> （后记：这 6 个 token 在后来的低保真改造中因状态徽标被删而失去全部引用，已一并清掉。见第二节。）

**说明条为什么能删**：它 3 条里，第 1 条「tab 跳出 / 下一个顶上」面板底栏已经写了，第 3 条「真实窗口契约」按钮 `title` 里已经有，只有第 2 条「跨屏拖动」是独有的——把它挪到拖动条的 `title="拖动可换屏"`，落在真正用得上的地方，而不是留在页脚当说明书。

### ⚠️ 一次误判，以及它暴露的方法问题

第一版分析脚本报 `$$` 这个辅助函数"全文引用 0 次"，我据此删掉了它 —— **结果是错的**：`$$` 实际被引用 **8 处**，删掉后初始化直接抛 `ReferenceError`，页面不再自动播放、缩放也失效。

坏在两点，都值得记下来：

1. **脚本的正则把 `$` 当成了行尾锚点**，所以任何含 `$` 的标识符都会被误判为死码。
2. **我用语法检查放行了它。** `check-demo.sh` 只做 `node --check`，语法完全合法——一个"引用了不存在的变量"的错误它结构上就看不见。是浏览器端"进页面是否自动播放 / 是否无滚动"这两个**行为断言**把它抓出来的，不是静态检查。
3. 更该批评的是流程：核对 CSS 变量时我老老实实做了 grep 交叉验证，到 JS 符号这一步却信了单一工具的结论就直接下手。

已恢复 `$$`，并把脚本改写成 `audit.mjs`：**每一项都用两种独立方法验证**（变量用 `var()` 引用 + 裸字符串；类用 markup 出现 + 动态拼接探测；符号用词法边界计数 + 删掉声明行后复查），只有两种方法都判死才标为可疑，且可疑项必须人工 grep 复核后才动手。

### 测过、判定「不值得删」（数字留在这，你可以推翻）

| 项 | 数字 | 为什么不删 |
|---|---|---|
| 死 CSS 类 | **0 个** | 分析器初报 4 个全是误报：2 个只出现在注释里，`hub--compact` 是 `hub--${mode}` 拼的，`concept__title` 早已不存在 |
| 死 JS 顶层符号 | **0 个**（65 个全在用） | 唯一"候选" `$$` 是上述误判，实际 8 处在用 |
| JS 里重复的图标 SVG | 唯一一组 ×2，去重最多省 **329 字符 = 全文 0.40%** | 为 0.4% 引入一层间接引用，读代码时再也看不见图标长什么样，净亏 |
| 230 条 CSS 规则里"重复的 body" | 210 个唯一 body | 是不同组件的巧合同值（如 `.matrix` 与 `.page__body`），抽成共享类会让两处改动互相绑架 |
| 概念 chips（对话 / 生成 / 多屏画布） | 信息唯一，且会随跳出翻状态 | 低价值，但**不冗余** |
| 第三条 AI 聊天气泡 | 与字幕文案部分重叠 | 撑起聊天 mock 的真实密度 |
| 3 处内联 `style` | `width:${…}%`、`width:${…}px`、窗口几何 | 全是数据驱动的动态值，提不走 |

### 结果

| | 消融前 | 消融后 |
|---|---|---|
| 行数 | 1,931 | **1,908**（−23） |
| 字符 | ≈84.2k | **83.2k**（−1.1k，−1.3%） |
| 死 CSS 变量 / 死 CSS 类 / 死 JS 符号 | 10 / 0 / 0 | **0 / 0 / 0** |

> 口径说明：**行数**用 `wc -l`；**字符**用 JS `String.length`（中文按 1 个字符算）。同一文件 `wc -c` 是 89,839 —— 那是 UTF-8 字节数，含中文时两者必然不同，别混着比。

只削掉 1.3%，这本身就是结论：**demo 的体量在必要复杂度上**——8 步动画状态机、缩放求解（宽高双约束 + 每次渲染重算）、跨屏拖动、窗口几何与角标同步。想再瘦只能靠删功能，靠去重压不动。

脚本在本目录的 `./audit.mjs`（初版 `ablate.mjs` 已在 `/tmp`，含上述正则 bug，不要再参考），用法 `node audit.mjs device-hub-popout.html`。它可以并进 `check-demo.sh` 一起跑，但注意它只能提示候选，**删之前必须 grep 复核**。

---

## 八、本轮修掉的缺陷

| # | 严重度 | 问题 | 状态 |
|---|---|---|---|
| 1 | 🟠 高 | `transform: scale()` 不改变布局盒尺寸 → 缩放区仍按原始高度占位，下方留出约 340px 空白 | ✅ 已修（按缩放后的真实高度压平包装盒） |
| 2 | 🟠 高 | `fitDesk()` 只按宽度求解缩放，且曾在 `renderAll()` **之前**调用（视野栏还没内容，高度按 0 算）→ 页面出现滚动条 | ✅ 已修（宽高同时约束 + 调整启动顺序 + 每次渲染后重算） |
| 3 | 🟡 中 | `recallAll()` 里 `if (isPopped(activeId))` 在循环之后判断，此时所有 `where` 已置空，条件永远为假（死代码） | ✅ 已删（保留最后一个激活 tab 才是实际行为） |
| 4 | 🟡 中 | 视野栏提示文字用内联硬编码颜色 `#7d879d`，脱离 token 体系 | ✅ 已修（当时改为 `.agentbar__hint`；该横条后来整体下移进画布，这个类已随之删除） |
| 5 | 🟡 中 | 拖动时把光标过渡调到 60ms 后未恢复 | ✅ 已修 |
| 6 | 🔴 致命 | （更早一轮）3 处模板字符串多写单引号 → 整个脚本 `SyntaxError`、页面白屏 | ✅ 已修，并建立 `check-demo.sh` 回归检查 |
| 7 | 🟠 高 | （本轮消融中自伤）误信分析脚本结论把在用的 `$$` 当死码删掉 → 初始化 `ReferenceError`，不再自动播放、缩放失效。`node --check` 语法合法，**静态检查结构上查不出这类错误** | ✅ 已恢复；脚本改写为 `audit.mjs`（双方法交叉验证），并把「行为断言」列为删码后的必跑项 |
| 8 | 🟡 中 | 竖屏副屏（工具条内容盒仅 141px）里缩放组固定 149px 且不收缩 → seg 被挤出容器，`100%` 裁成 `10` | ✅ 已修（`@container (max-width: 210px)` 隐藏重复的百分比读数；阈值按内容盒实测 248 / 431 / 415 / 141 定，只命中竖屏那个） |
| 9 | 🟡 中 | 中途那轮「加填充减描边」其实**改偏离了设计系统**（真系统本就靠三档 border 分层） | ✅ 已修（18 处结构描边按真 token 全量恢复） |
| 10 | 🔴 高 | **全局缺 `button { border: 0 }`** → 所有未显式写 `border` 的按钮都在渲染 UA 默认描边。`.target`（设备列表）和 `.btn` / `.icon-btn`（弹出窗标题栏）都中招，看起来像手绘重框；`收回` 甚至像双层边 | ✅ 已修（`.target` 走 Listbox 的 `border: 0`；`.btn`/`.icon-btn` 整套换成 `.ds-btn`/`.ds-icon-btn`） |
| 11 | 🟡 中 | 配方漏了 `:not(:disabled)`，禁用按钮仍会触发 hover 底色；且禁用态只靠 `opacity: .35`，没走真组件的 content-disabled token | ✅ 已修（补 `:not(:disabled)`；禁用态改用 `color-action-neutral-content-disabled` 并显式清掉 fill/primary 底色） |
| 12 | 🟠 高 | `.panel__body` 是 `overflow-y: visible`，空态里那段「已跳出清单」在窄面板下比可视区高 168px —— **内容被裁且没有滚动条**，4 行「收回」按钮实际点不到。这是上一版就存在的缺陷，换 Empty 后 padding 从 18px 变 32px 才让它明显到被发现 | ✅ 已修（`overflow-y: auto`，实测滚到底可达） |

---

## 九、⚠️ 待确认清单

这些我从现有信息里定不下来，需要你拍板——**Demo 阶段改是分钟级，进了工程代码就是小时级**：

1. ~~**单色要不要保住语义色？**~~ **已随本轮改造反向解决**：语义色回来了，但不是手调的，是从真设计系统取的 —— 状态 pill 用 `color-status-{success,info,warning,danger}-{content,surface}` 四组真 token。你早前「去色不要青色」的要求不受影响：真系统里只有 `text` 变体和 `accent-*` 是青色，这个 Demo 一个都没用（主操作色 `component-button-primary-background` 本身就是 `rgba(0,0,0,.8)`）。
2. **一块屏 = 一个窗口，还是一个屏可以放多个浮窗？** Demo 允许 Display 2 同时承载多个窗口（叠放错位）。真实实现里一块副屏很可能就是一个**原生窗口**，那多个 tab 落到同一块屏应该是「同窗口内多 tab」还是「叠放的独立窗口」？
3. **tab 跳出后是否还留在 tab 条里？** 目前保留 + 灰显 + 落点角标。
4. **自动演示要不要更短？** 现在一整轮约 28–30s。要投放的话可能需要 15s 版。
5. **演示文案的口径**：现在是按「Agent 替你把东西铺开」写的，是否需要改成第二人称（「Agent 替你…」→「让 Agent 替你…」）。
6. **同一 tab 能否多实例**（同一份 PRD 同时投两块屏）？
7. **「移屏」在真实实现里怎么做？** Demo 里是同一 DOM 内重挂载；真实实现里每块屏是独立原生窗口，等价操作是「关旧窗 + 开新窗 + 状态迁移」，涉及 webview 交接时序。
8. **谁发起多屏分配？** 目前全是用户手动跳出。最有意思的形态是 **Agent 主动说「我把 PRD 放到 Display 2」**——这需要定义 Agent 的分配权限（要不要在 capability 层暴露一个 `place_preview` 之类的动作）。
9. **设备 / 缩放是否按 tab 记忆？** 目前是。
10. **`Esc` 一次性收回全部**：是否应该改成只收回当前 tab / 当前屏？
11. ~~**屏内要不要留一块真实内容？**~~ **已解决 —— 不是「留一块」，是三块都换成了真实内容**（PRD 真文案 + 页面预览真组件卡片 + 组件矩阵 4×4 真控件 + 机型真实尺寸）。线框占位整体移除，「Agent 读得懂画布内容」这个证据点补回来了。
12. ~~**屏内线框占位要不要配文字标签？**~~ **线框已整体移除**，这条不存在了。

---

## 十、与仓库真实实现的关系

Demo 在验证已经写进仓库的那套契约；但**本轮需求带出了两处真实实现必须改的地方**：

| Demo 里的 | 仓库真实实现 | 差异 |
|---|---|---|
| 跳出 / 收回 | `open_detached_browser_window` / `close_detached_browser_window` / `detached_browser_window_info` | 可用 |
| surface 参数 | `?openbitfunWindow=browser-detached&browserUrl=…&browserTitle=…`（键名与前端读取逐字一致） | 可用；Demo 额外加了 `demoTab`（Demo 专有） |
| 拖动 / 缩放窗口 | 原生窗口拖动缩放 + 几何持久化到 `.detached-browser-window-state.json` | 可用 |
| 关窗自动恢复 | `CloseRequested` / `Destroyed` 事件 → 广播 `browser://detached-window` | 可用 |
| **多 tab 各自跳出** | 跳出粒度是**整个浏览器面板**，不是 per-tab | 🔴 **要改**：需要引入 tab 归属模型 |
| **同时多个跳出窗口** | 目前是**单例**（已存在则复用 + 聚焦） | 🔴 **要改**：多屏拓展的前提是多实例并存 |
| 跨屏拖动重新挂载 | 每屏是独立原生窗口，等价操作是「关旧窗 + 开新窗 + 状态迁移」 | 🟡 需要定义迁移时序（webview 交接） |
| （Demo 未体现） | 显示器感知放置、过期几何保护、ACL 授权、capability 登记、三语 i18n、appearance 契约 | — |
| （Demo 未体现） | 跳出窗口内重建嵌入式 webview、主窗口释放 webview（`released` 语义） | — |

---

## 十一、下一步

1. 上面「待确认清单」里挑你关心的回答——**第 2 条（一块屏一个窗口 vs 多个浮窗）和第 7 条（移屏怎么实现）最关键**，它们决定工程形态。
2. 想先看真实弹窗效果的话，在浏览器里手动点一下窗口标题栏的「真实窗口」图标（自动化点不了，需要真实手势）。
3. `audit.mjs` 若要并进 `check-demo.sh`，记得它是**候选提示**而非判决——删任何符号前 grep 复核（教训见第七节）。
4. 方向定了再谈工程化——仓库里那部分代码已经编译通过、测试通过，届时是按 Demo 结论调整，不是重写。

**还欠你一个功能**：早前你提过把 Display 3 做成**手机模拟器**——手机外框 + iOS / Android / HarmonyOS 平台切换 + 按系统分组的设备清单。它被后面的版面和消融指令压过去了，一直没做。

注意这和 `mobile-ui.html` 是**两件事，但能接上**：

| | 是什么 | 状态 |
|---|---|---|
| `mobile-ui.html` | **装进外框里的内容**——毕方手机版 4 个界面（欢迎 / 配对 / 列表 / 对话）+ 深色模式，规格逐条取自仓库 mobile 契约（见 [mobile-ui.md](mobile-ui.md)） | 已有 |
| 手机模拟器 | **外框本身**——机身边框、平台切换、按系统分组的设备清单 | 未做 |

也就是说：把 `mobile-ui.html` 嵌进手机外框、再由平台切换驱动外框形态，这块就齐了。要不要接着做？
