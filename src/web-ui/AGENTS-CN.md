**中文** | [English](AGENTS.md)

# AGENTS-CN.md

## 适用范围

本文件适用于 `src/web-ui`。仓库级规则请看顶层 `AGENTS.md`。

## 这里最重要的内容

`src/web-ui` 是共享前端，对应两种运行时：

- Tauri 桌面端
- 通过 WebSocket / Fetch 适配层访问的 server/web

大多数改动从这些位置开始：

- `src/infrastructure/`：adapters、i18n、theme、providers、config
- `src/infrastructure/peer-device/`：Peer Device Mode transport switch 与 host-invoke bridge
- `src/app/`：应用外壳与顶层装配
- `src/flow_chat/`：聊天流 UI 与状态
- `src/tools/`：editor、terminal、git、workspace、file explorer
- `src/shared/`：共享 services、stores、helpers、types
- `src/locales/`：多语言文案

Peer Device Mode（同账号远程完整客户端）的边界见 `docs/architecture/peer-device-mode.md`。
前端不变量见 `src/infrastructure/peer-device/README.md`。不要重新引入内嵌会话/聊天壳；
应从设备列表（Remote Connect 的「我的 OpenBitFun」组）进入 peer mode。

Remote Connect 使用全局 GitHub 账户和官方版本化 Relay。账户控件复用 account-identity
服务，不再提供独立 Relay 账户、自定义服务器或自建部署入口。SSH 与 Docker 远程工作区
继续独立使用，不受 Relay 登录限制。

## 本模块规则

- 不要在 UI 组件里直接调用 Tauri API；应通过 adapter / infrastructure 层访问
- 新增前端基础设施前，先复用 `@openbitfun/ui`、设计令牌、theme、i18n 和 Zustand stores
- 单行标签优先使用设计系统 `OverflowText`，避免自行添加省略号样式或裁剪字符串。纯文字默认渐隐截断并在悬停、聚焦时跑马灯展示；搜索高亮等纯文本富内容显式设置 `behavior="marquee"`，图标和操作按钮放在文字槽外。所属控件设置 `data-overflow-trigger`；标准组件已内置溢出处理。多行、触屏与可编辑内容保留适合自身的布局。
- 主题与颜色 Token 改动遵循 `docs/architecture/theme-token-optimization.md`。审计失败应通过复用 Token、
  收敛冗余值或增加最小 owner contract 修复，不得仅为通过检查提高 baseline 或测试期望；跨形态改动运行
  `pnpm run theme:color-audit:all`。
- Locale 元数据只在生成式 i18n contract 中维护。修改 `src/shared/i18n/contract/locales.json` 后运行
  `pnpm run i18n:generate`，Web UI 文案留在 `src/web-ui/src/locales`。
- 路由或功能文案使用 `useI18n(namespace)` 保持非 bootstrap namespace 懒加载；直接调用
  `i18nService.t(...)` 必须有 bootstrap namespace 覆盖。
- 遵循 `src/web-ui/LOGGING.md`：仅英文、无 emoji、结构化日志

## 动态界面的 CSS 失效范围

- 对频繁增删 DOM 的组件自有兄弟关系样式，优先使用专属类名，避免仅按标签或通配符匹配。CSS Modules 和祖先作用域不能隔离浏览器的样式失效工作。
- 现有布局与间距语义允许时使用 flex/grid 的 `gap`；不要机械地将同类相邻关系替换为 `:not(:first-child)`，也不要仅为此切换布局模式。
- 生成内容可以保留语义标签选择器。对实测热点添加渲染器专属类名；用 `:where(.owned-class)` 限定复合选择器时可保持原优先级。保留内嵌 HTML、嵌套列表、混合表格单元格及数学内容的行为。
- 改写后核对匹配集合与层叠效果。短时 Selector Stats 录制用于定位失效原因，普通录制用于验证收益；失效次数不等于可感知提升。不全面禁止兄弟选择器。

## 命令

这里只维护开发/构建入口；验证命令统一放在下方“验证”章节。

```bash
pnpm --dir src/web-ui dev
pnpm run build:web                     # 构建相关改动或复现 CI
```

`pnpm run build:web` 会并发执行类型检查与 Vite 构建，错误出现顺序不固定，输出分别带
`[type-check]` / `[vite-build]` 前缀。只有网络盘或 WSL 挂载等原生文件事件漏报场景才设置
`VITE_USE_POLLING=1`。

## 验证

按改动范围选择最小检查：

```bash
pnpm run i18n:audit
pnpm run i18n:generate && pnpm run i18n:contract:test && pnpm run i18n:audit
pnpm run type-check:web && pnpm --dir src/web-ui run test:run src/infrastructure/i18n/core/I18nService.test.ts
pnpm run check:web
```

以上依次用于 locale 资源、locale contract/shared terms、i18n runtime/namespace loading 和普通 Web UI 代码。
`check:web` 会执行类型检查，以及 CI 使用的 Appearance contract、主题颜色和主题视觉治理门禁，确保渲染 DOM
或样式回归能在本地发现。完整 lint、build 与大范围测试由 CI 兜底，除非本地改动确实需要复现。
