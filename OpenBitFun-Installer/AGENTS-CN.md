**中文** | [English](AGENTS.md)

# AGENTS-CN.md

## 适用范围

本文件适用于 `OpenBitFun-Installer`。仓库级规则请看顶层 `AGENTS.md`。

## 这里最重要的内容

`OpenBitFun-Installer` 是独立的 Tauri + React 应用，不属于主 Cargo workspace。

模块 README 明确提到的重要区域：

- `src-tauri/src/installer/commands.rs`：Tauri IPC 与卸载执行
- `src-tauri/src/installer/registry.rs`：Windows 注册表集成
- `src-tauri/src/installer/shortcut.rs`：快捷方式创建
- `src-tauri/src/installer/extract.rs`：压缩包解压
- `src/hooks/useInstaller.ts`：前端安装流程状态
- `src/i18n/`：安装器专属文案；locale 元数据由
  `src/shared/i18n/contract/locales.json` 生成

安装流程：

```text
Language Select → Options → Progress → Model Setup → Theme Setup
```

如果所选路径已有 OpenBitFun 安装，流程会在 `Progress` 后结束，保留已有的模型和主题配置。

## 命令

这些是命令参考，不是默认预检清单。PR 范围请以下方 Verification 为准。

```bash
pnpm --dir OpenBitFun-Installer run installer:dev
pnpm --dir OpenBitFun-Installer run tauri:dev
pnpm --dir OpenBitFun-Installer run tauri:preview    # 原生界面预览，不执行安装
pnpm --dir OpenBitFun-Installer run type-check
pnpm --dir OpenBitFun-Installer run build            # React build / 复现 CI
pnpm --dir OpenBitFun-Installer run installer:build  # 仅打包场景
```

## 验证

按触及范围选择最小检查：

```bash
pnpm run i18n:audit                                                   # 仅资源类 i18n
pnpm run i18n:generate && pnpm run i18n:contract:test && pnpm run i18n:audit
pnpm --dir OpenBitFun-Installer run type-check                            # 前端 i18n/runtime
cargo check --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml      # Tauri/Rust 改动
```

修改原生 `--preview` 命令边界时，运行聚焦策略测试：

```bash
cargo test --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml --lib preview::tests
```

修改 ZIP 依赖或解压逻辑时，验证旧版安装器载荷的兼容性：

```bash
cargo test --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml --lib installer::extract::tests
```

只有修改打包、payload、native bundling、安装/卸载流程、注册表、快捷方式或解压逻辑时，才运行完整安装器构建：

```bash
pnpm --dir OpenBitFun-Installer run type-check && pnpm --dir OpenBitFun-Installer run installer:build
```

如果修改了卸载流程，还需要验证 `OpenBitFun-Installer/README.md` 中描述的卸载模式入口。
