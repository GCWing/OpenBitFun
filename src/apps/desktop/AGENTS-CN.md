**中文** | [English](AGENTS.md)

# AGENTS-CN.md

## 适用范围

本文件适用于 `src/apps/desktop`。仓库级规则请看顶层 `AGENTS.md`。

## 这里最重要的内容

`src/apps/desktop` 是 Tauri 宿主 / 集成层。

主要区域：

- `src/api/`：Tauri commands
- `src/api/peer_host_invoke.rs`：Peer Device Mode host-invoke bridge 与 control attach；
  允许/拒绝与能力来自 Product Operation Registry（`openbitfun_product_domains::remote_surface`），
  不再有本地表
- `src/api/remote_workspace_policy.rs`：证明每个已注册 Tauri 命令在注册表中恰有一行的闭包测试
- `src/lib.rs`、`src/main.rs`：应用启动与装配
- `src/computer_use/`：操作系统相关自动化支持

Peer Device Mode 的所有权和边界见 `docs/architecture/peer-device-mode.md`。
前端防回归清单见 `src/web-ui/src/infrastructure/peer-device/README.md`。

GitHub 身份统一由 `account_identity_api.rs` 提供；Relay 设备注册和生命周期位于
`src/api/remote_connect_api.rs`。设置留在所属设备，不再提供云端/本地同步选择。
Relay 部署向导已移除。保留 `src/apps/relay-server` 下供开发者使用的脚本和
[运维文档](../relay-server/README.md)，不要重新加入产品 UI。

如果改动影响多个运行时共享的行为，应把稳定契约、执行策略和服务放在各自的下层 owner
crate；`src/crates/assembly/core` 只保留产品装配与兼容桥接。

## 本模块规则

- 桌面端专属集成留在这里，不要下沉到共享 core
- 窗口 lifecycle 行为（包括 close/minimize-to-tray 默认值）属于桌面端 surface；修改时必须保留用户已保存偏好。
- `window_state_support` 负责主窗口布局校验，并沿用旧 `.window-state.json` 格式原子保存。
  不要同时注册 window-state 插件，其退出时写入的缓存可能覆盖修复结果。

## 命令

以下命令用于桌面开发循环；验证命令只在下方“验证”章节维护。

```bash
pnpm run desktop:dev
pnpm run desktop:preview:debug
pnpm run prepare:dsh-profile   # 可选：本地 DeepSeek Harness 会话
```

## 快速构建

| 命令 | 使用场景 |
|---|---|
| `pnpm run desktop:build:fast` | Debug 构建，不打包；用于编译验证。产物连 dev server 时 IPC 会被拒，见下方两种语义说明 |
| `pnpm run desktop:build:release-fast` | 类 Release 构建，降低 LTO；需要 release 行为但无法等待完整 LTO 时使用 |
| `pnpm run desktop:build:nsis:fast` | Windows 安装器，使用 `release-fast` profile；快速验证安装器 |

需要完整断点调试信息时设置 `CARGO_PROFILE_DEV_DEBUG=2`。默认 dev profile 保留行号信息，
同时减少 PDB 体积。

### Debug 二进制有两种语义；desktop:build:fast 的产物连 dev server 时 IPC 全被拒

`target/debug/bitfun-desktop.exe` 因构建方式不同有两种 tauri 语义：

- `cargo build -p bitfun-desktop`（`desktop:preview:debug` 内部重建也用这个）：tauri dev 语义（`DEP_TAURI_DEV=true`），dev server origin `http://localhost:1422` 被信任，IPC 正常。
- `desktop:build:fast` 执行 `tauri build`，会启用 `custom-protocol`：tauri production 语义，同一 origin 被视为 remote URL，ACL 拒绝所有 app 命令和 `plugin-log`。

Debug 构建总是导航到 `devUrl`（启动日志 `url_kind=external`），所以 `desktop:build:fast` 的产物 + dev server 会呈现"界面完整渲染但所有 invoke 被拒"：`... not allowed. Plugin not found` 错误弹窗、会话列表加载失败、小应用列表为空（加载错误被吞成空列表）、会话日志目录里 `webview.log` 为 0 字节。不带 dev server 直接启动则表现为 `ERR_CONNECTION_REFUSED`。

`desktop:preview:debug` 按二进制 mtime 是否新于 tracked inputs 决定复用——`desktop:build:fast` 的产物同样会被复用。跑过 `desktop:build:fast` 之后，必须先 `cargo build -p bitfun-desktop`（或 `pnpm run desktop:preview:debug -- --force-rebuild`）再启动 preview，否则会复用坏二进制。

诊断捷径：UI 正常渲染 + `config/logs/<session>/` 下 `webview.log` 为 0 字节 = IPC 被 ACL 拒绝，是构建语义问题，不是数据问题；`BITFUN_USER_ROOT` 下的数据不受影响。

另外：内置 miniapp 资源（例如 `bitfun-loopx` 的 `ui.js`/`worker.js`）通过 `include_str!` 内嵌进 `openbitfun-product-domains`，改资源会连带重编 product-domains → assembly-core → desktop 链路，增量构建耗时几分钟属于正常。exe 自身报 `os error 5` 表示有实例仍在运行、exe 被锁定，见下方 GC 竞争一节。

## Target 缓存 GC

`desktop:dev`（退出时）、`desktop:preview:debug`（关闭时）以及 `desktop:build*` 会裁剪过期的 `target/<profile>` 缓存代际。`incremental` 每个 crate/session 保留最新项；GC 根据 Cargo fingerprint JSON 区分 lib、test、bin、build-script 等构建单元，每个单元保留最新代际，并保留 Cargo 管理的 `invoked.timestamp` 在最近 24 小时内刷新过的全部代际，随后删除失去 fingerprint 的 `deps` 文件和 `build` 目录。忙碌检测只检查所选 profile 的 Cargo 锁文件，因此其他 worktree 的编译不会再阻止清理。手动执行：`pnpm run target:gc -- --profile debug`。禁用：`OPENBITFUN_TARGET_GC=0`；演练：`OPENBITFUN_TARGET_GC_DRY_RUN=1`；可用 `OPENBITFUN_TARGET_GC_MIN_AGE_HOURS` 调整安全窗口。

`release-fast` profile（`Cargo.toml`）：继承 `release`，但关闭 LTO、`codegen-units` 提高到 16、启用增量编译。编译速度显著提升，代价是二进制体积增大和边际运行时性能下降。

### 手动并发构建会与退出时 GC 竞争

杀掉 `bitfun-desktop.exe` 会结束 `desktop:dev` / `desktop:preview:debug` 会话，退出过程会执行 target GC。此时立即手动执行 `cargo build -p bitfun-desktop` 可能编译中途失败，报 `os error 3`（系统找不到指定的路径），原因是 GC 在构建写入时删除了 `target/debug/build` 或 `target/debug/incremental` 目录。`bitfun-desktop.exe` 自身报 `os error 5`（拒绝访问）则是应用仍在运行、exe 被锁定。两者都是暂时性的：确认 preview 会话（node `dev.cjs` + vite + exe）完全退出——杀掉 exe 后等几秒——然后直接重跑构建即可，无需 `cargo clean`。

## DevTools feature（模型规则）

`devtools` Cargo feature 用于桌面端 UI/UX 调试。添加或修改调试相关代码时：

- 所有调试专用 API 和 command 必须用 `#[cfg(any(debug_assertions, feature = "devtools"))]` 保护
- 在 `#[cfg(not(any(debug_assertions, feature = "devtools")))]` 下提供 no-op stub，确保 command 始终可以注册到 `invoke_handler`
- 该 feature 通过 `--features devtools` 在 `dev` 构建和 `release-fast` profile 构建中自动启用
- 面向最终用户的 `release` profile 构建中永不启用

## 验证

```bash
cargo check -p openbitfun-desktop && cargo test -p openbitfun-desktop
```

窗口布局恢复、旧状态兼容和快照保存使用：

```bash
cargo test -p openbitfun-desktop --lib window_state_support::tests
pnpm --dir src/web-ui run test:run src/app/startup/startupPerformanceContract.test.ts
```

如果改动影响启动、WebDriver、browser/computer-use 或打包行为，还需要运行：

```bash
cargo build -p openbitfun-desktop
```
