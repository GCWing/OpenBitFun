# 毕方手机版 · UI 提取原型

> 单文件原型：[mobile-ui.html](mobile-ui.html)
> 定位：**可迭代的 UI 骨架**，用来继续改手机端设计，不是截图、不是交付代码。
> 仓库源码未做任何改动（`openbitfun/` 保持原状）。

---

## 一、怎么看

```bash
cd demo && python3 -m http.server 8099
# 打开 http://127.0.0.1:8099/mobile-ui.html
```

双击 HTML 也能开（纯静态，无外部依赖）。

| 操作 | 结果 |
|---|---|
| 左栏点界面名 | 切到该界面 |
| 按数字键 `1`–`4` | 同上（欢迎 / 配对 / 列表 / 对话） |
| 左栏「切换深色」 | 整机换到深色外观（两套颜色都是契约值） |
| 对话页右上 `···` | 会话操作面板 |
| 对话页输入区左下 `+` | 输入区展开成两行 |
| 展开态点模型 chip | 模型选择面板 |
| 点遮罩 / 关闭按钮 / `Esc` | 收起弹层 |
| 侧栏点任意会话 | 进入对话页 |

---

## 二、提取的来源

仓库里有**两套**手机端，先说清楚我用了哪套、为什么。

| | A. 原生手机 App（本次基座） | B. 手机网页遥控端 |
|---|---|---|
| 路径 | `openbitfun/src/apps/mobile/` | `openbitfun/src/mobile-web/` |
| 技术 | ArkTS / Kotlin / Swift 原生，HarmonyOS 为视觉基线 | React + Vite |
| 形态 | 装在手机上的 App | 手机浏览器打开的遥控端 |
| 设计规格 | ✅ 有权威契约（见下） | 只有 CSS 实现 |
| 界面代码 | 313 个 `.ets` 文件 | 33 个组件 + 11 个页面 |

**选 A 的理由**：它才是「装在手机上的版本」，而且带一套机器可读的设计契约——颜色、字阶、几何、动效、组件解剖、状态枚举都在里面，能保证提取的忠实度。B 的视觉与 A **同源**（都映射 `theme-openbitfun` 的语义角色），但没有独立规格文件，且离开真实桌面连不进主界面。

如果目标其实是 B，说一声即可——B 的 CSS 可以近乎逐像素搬过来，切换成本很低。

### 契约文件（本次提取的规格全部来自这里）

| 文件 | 内容 |
|---|---|
| [mobile-tokens.json](../openbitfun/src/apps/mobile/design-system/tokens/mobile-tokens.json) | 语义色（浅/深双套）、字阶、几何、断点、动效 |
| [mobile-components.json](../openbitfun/src/apps/mobile/design-system/components/mobile-components.json) | 33 个组件的解剖 / 状态 / 消费的 token 角色 |
| [mobile-preview-scenarios.json](../openbitfun/src/apps/mobile/design-system/scenarios/mobile-preview-scenarios.json) | 6 个确定性预览场景 |
| [welcome-brand-contours.json](../openbitfun/src/apps/mobile/design-system/assets/welcome-brand-contours.json) | 品牌 mark 的 15 条轮廓路径 |

界面布局另参考了原生实现：`ConversationHeader.ets`、`ChatMessageChrome.ets`、`AppSidebar.ets`、`RemoteSessionRow.ets`、`RemoteSessionList.ets`、`WelcomeHome.ets`、`Theme.ets`。

---

## 三、契约对照

原型里**没有写死过任何一个数值**——所有值都来自 token，改一处即全改。

### 几何（geometry）

| token | 值 | 用在哪 |
|---|---|---|
| `conversation_header_height` | 76 | 对话 / 侧栏标题栏 |
| `control_touch_size` | 48 | 全部圆形控制 |
| `content_gutter` | 16 | 页面左右留白 |
| `message_bubble_max_width` | 276 | 用户气泡上限 |
| `message_bubble_radius` | 17 | 气泡圆角 |
| `message_bubble_horizontal/vertical_padding` | 14 / 11 | 气泡内边距 |
| `message_spacing` | 18 | 消息间距 |
| `timeline_top_padding` | 22 | 时间线顶部 |
| `conversation_edge_fade_height` | 28 | 时间线两端渐隐 |
| `connection_strip_height` | 48 | 连接状态条 |
| `composer_collapsed_height` / `_radius` | 56 / 28 | 输入区收起态 |
| `composer_expanded_height` / `_radius` | 120 / 18 | 输入区展开态 |
| `composer_expanded_input_row_height` | 60 | 展开态输入行 |
| `composer_expanded_action_row_height` | 48 | 展开态动作行 |
| `selection_top_radius` / `selection_row_height` | 20 / 64 | 选择面板 |
| `sheet_header_height` / `sheet_action_height` | 56 / 48 | 面板头 / 主按钮 |
| `compact_popover_width` / `_action_height` | 150 / 42 | 紧凑操作面板 |
| `approval_card_radius` | 12 | 工具卡 |
| `welcome_mark_size` / `welcome_button_height` | 92 / 49 | 欢迎页品牌 mark / 按钮 |

### 颜色

浅/深两套完整取自 `colors` 段。几个值得注意的：

- `welcome_dock` `#171917` / `#000000`、`welcome_button` `#FFFFFF`：欢迎页的深色动作坞**不跟主题反转**，浅深两态都保持黑底白钮，所以它单独占了一组 token。
- `sidebar_*` 是一个独立家族（`sidebar_bg` `#F8F8F9` / `#0E0E10`）：侧栏是「一层 chrome」，故意比对话纸面偏离一档，不复用 `page_bg`。契约里它和桌面端语义角色一一对应。
- `file_link` `#2563EB` / `#60A5FA`：全产品**唯一的信息强调蓝**。
- `accent` 浅色 `#111111` / 深色 `#5B5954`：主按钮其实是「墨色」而不是彩色，深色下会退成灰。

### 字阶

`display_large` 24/30/700 → `label_small` 12/16/400。原型用到的：`conversation_header_title` 17/22/600（对话标题）、`title_small` 15/20/500（会话行）、`body_large` 16/24/400（消息正文与用户气泡）、`body_medium` 14/21/400、`label_small` 12/16/400（元信息）。

---

## 四、还原了哪些界面

| # | 界面 | 覆盖的状态 |
|---|---|---|
| 01 | 未登录欢迎页 | `signed_out`：字标 + 15 轮廓品牌 mark + 逐字短语 + 深色动作坞 |
| 02 | 配对 | 扫码 + 手动配对码 + 账号登录入口 |
| 03 | 会话列表 / 侧栏 | 设备选中、在线/离线、工作区面板、会话分组、运行中徽标、滚动渐隐、工具页脚 |
| 04 | 对话 | 标题栏、连接状态条、用户气泡、助手全宽正文、思考块、代码块、工具卡（含等待授权）、打字指示、输入区收起态 |
| 04+ | 弹层 | 输入区展开态、模型选择面板（选中项在首位 + soft 面 + 前置勾选）、会话操作面板 |

按契约要求落实的几处细节：

- **设备行不带 disclosure chevron**——契约明确禁止，可达性只由状态点表达。
- **模型行无分隔线、无 provider 图标**，选中项置顶并带前置勾选。
- **用户气泡用 `soft` 面 + 17 圆角**，助手消息全宽无气泡。
- **欢迎页 mark 不参与动画**，动的是短语的逐字进场（55ms 递进 / 800ms 缓出）和轮廓高光。

---

## 五、没提取的部分

原型覆盖的是核心链路，以下在契约里有、原型里没有：

- 工作区 / 文件浏览 / 编辑 / 上传下载 / xterm 终端
- 设置面板（模型服务、语言、连接与权限策略）
- 交互邮箱（运行时提问与权限请求的独立面板）
- MiniApp 目录与 WebView 容器
- 首启品牌动画（6800ms）、冷启首页过渡（2400ms）
- 宽屏（≥600 / ≥840）布局分支——原型只做了紧凑态
- 无障碍语义（原型是视觉稿，`aria` 只做了基本标记，未做完整键盘链路与读屏验证）

---

## 六、⚠️ 待确认清单

这些定不下来，需要你拍板——**原型阶段改是分钟级，进了工程就是小时级**：

1. **设备行和工作区行的选中态用同一个面**（都是 `sidebar_selection`，见左栏截图）。层级上有点平，要不要让工作区退一档用 `sidebar_hover`？契约没规定，两种都说得通。
2. **深色下主按钮退成灰色**（`accent` `#5B5954`）。这是契约值不是 bug，但深色下发送按钮的存在感明显弱于浅色——是保持克制，还是深色单独给一个更实的墨色？
3. **连接状态条**（`connection_strip_height` 48）现在是个整宽的 `soft` 色块，占掉屏幕可观的纵向空间。要不要改成一行更轻的文本，或者只在不健康时出现？
4. **用户气泡的消息动作**（复制/编辑）现在挂在长按上；助手消息的「复制 / 重新生成」是常驻胶囊。两者要不要统一？
5. **侧栏的「运行中」徽标**是我加的。契约里会话行只有 title + metadata 两行，没有徽标位。要保留吗？（保留的话得进契约。）
6. **欢迎页的短语**用了仓库 README 里提到的「桌面端本地化短语」，具体文案得你定——现在是三句占位。
7. **时间线两端渐隐 28**：滚动到底时最后一条消息会被渐隐吃掉一部分。是保持（视觉干净）还是让底部只在滚动中渐隐、到底部时取消？
8. **配对页**是先扫码还是先登录？现在扫码在上、账号在下，且两个都是主按钮级。真实产品的第一动作是哪个？

---

## 七、怎么改

改设计就改这几处，不用碰组件结构：

```css
:root { /* 字阶与几何 token —— 改这里全站生效 */ }
:root[data-theme='light'] { /* 浅色 */ }
:root[data-theme='dark']  { /* 深色 */ }
```

- 换颜色 / 字阶 / 尺寸 → 只动上面三段
- 改界面结构 → 找 `.screen[data-screen='...']` 那一段
- 改弹层 → `.sheet` / `.popover` 两段

改完先跑语法回归（脚本笔误会让整页白屏，这是上一轮踩过的坑）：

```bash
./check-demo.sh mobile-ui.html
```
