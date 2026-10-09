**中文** | [English](AGENTS.md)

# AGENTS-CN.md

## 适用范围

本文件适用于 `tests/e2e`。仓库级规则请看顶层 `AGENTS.md`。

## 这里最重要的内容

这里是桌面端 E2E 测试，使用 WebDriverIO 和 OpenBitFun 内置 WebDriver。

根据 `E2E-TESTING-GUIDE.md`：

- L0：smoke tests
- L1：functional tests
- L2：已规划，但尚未实现

核心规则：

1. 测试真实用户工作流
2. 使用 `data-testid` 作为稳定选择器
3. 遵循 Page Object Model
4. 保持测试独立且幂等

## 命令

```bash
cargo build -p openbitfun-desktop
pnpm --dir tests/e2e install
pnpm --dir tests/e2e run test:l0
pnpm --dir tests/e2e run test:l0:all
pnpm --dir tests/e2e run test:l1
pnpm --dir tests/e2e exec wdio run ./config/wdio.conf.ts --spec "./specs/<file>.spec.ts"
```

## 验证

优先运行最窄的相关 spec，必要时再扩大范围。

验证内置 WebDriver 的滚动、聚焦与外层布局时，先构建 Desktop 和当前前端资源，再运行：

```bash
node tests/e2e/scripts/run-interaction-scroll.mjs
```

该脚本使用真实产品控件、独立的打包前端快照、临时应用存储和私有 WebView 存储，检查点击、
指针与滚轮动作、元素截图、输入清空与填写、屏外控件定位和超大元素点击坐标。证据 `result.json`
保存在输出的临时目录；不使用 Mock 页面，也不代表远程场景或其他平台已经验证。
并行构建时，可用 `OPENBITFUN_E2E_FRONTEND_DIR` 指向含 `frontend-revision.json` 的已完成构建快照。
脚本也复制可执行文件；默认 exe 被开发实例锁定时，可用 `OPENBITFUN_E2E_DESKTOP_BINARY` 指向新链接的产物。
