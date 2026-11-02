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
| `pnpm run desktop:build:fast` | Debug 构建，不打包；手动测试时编译最快 |
| `pnpm run desktop:build:release-fast` | 类 Release 构建，降低 LTO；需要 release 行为但无法等待完整 LTO 时使用 |
| `pnpm run desktop:build:nsis:fast` | Windows 安装器，使用 `release-fast` profile；快速验证安装器 |

需要完整断点调试信息时设置 `CARGO_PROFILE_DEV_DEBUG=2`。默认 dev profile 保留行号信息，
同时减少 PDB 体积。

## Target 缓存 GC

`desktop:dev`（退出时）、`desktop:preview:debug`（关闭时）以及 `desktop:build*` 会裁剪过期的 `target/<profile>` 缓存代际。`incremental` 每个 crate/session 保留最新项；GC 根据 Cargo fingerprint JSON 区分 lib、test、bin、build-script 等构建单元，每个单元保留最新代际，并保留 Cargo 管理的 `invoked.timestamp` 在最近 24 小时内刷新过的全部代际，随后删除失去 fingerprint 的 `deps` 文件和 `build` 目录。忙碌检测只检查所选 profile 的 Cargo 锁文件，因此其他 worktree 的编译不会再阻止清理。手动执行：`pnpm run target:gc -- --profile debug`。禁用：`OPENBITFUN_TARGET_GC=0`；演练：`OPENBITFUN_TARGET_GC_DRY_RUN=1`；可用 `OPENBITFUN_TARGET_GC_MIN_AGE_HOURS` 调整安全窗口。

`release-fast` profile（`Cargo.toml`）：继承 `release`，但关闭 LTO、`codegen-units` 提高到 16、启用增量编译。编译速度显著提升，代价是二进制体积增大和边际运行时性能下降。

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

macOS 浏览器空 URL 和原生导航失败使用
[`third_party/wry/OPENBITFUN-PATCH.md`](../../../third_party/wry/OPENBITFUN-PATCH.md)
中的 `wkwebview_url` 原生回归测试，并运行下方 Desktop 构建。测试覆盖原生 URL
读取、页面加载回调、导航失败和手动导航恢复，不覆盖远程主机。panic hook 返回不代表捕获了 panic，日志不能宣称恢复成功。

如果改动影响启动、WebDriver、browser/computer-use 或打包行为，还需要运行：

```bash
cargo build -p openbitfun-desktop
```
