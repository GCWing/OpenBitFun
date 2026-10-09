# OpenBitFun 独立数据迁移器

[English](README.md)

这是一个可选的独立桌面工具，用于将旧版 **BitFun** 数据导入 **OpenBitFun**。

## 下载和使用

**最新版本：[v0.1.2 — 下载数据迁移器](https://github.com/GCWing/OpenBitFun/releases/tag/data-migrator-v0.1.2)。**

| 系统 | 下载文件 | 启动方式 |
| --- | --- | --- |
| Windows x64 | `openbitfun-data-migrator-v<版本>-windows-x64.zip` | 解压后双击 `openbitfun-data-migrator.exe` |
| macOS Apple Silicon | `openbitfun-data-migrator-v<版本>-macos-arm64.dmg` | 打开 DMG 中的迁移器 |
| macOS Intel | `openbitfun-data-migrator-v<版本>-macos-x64.dmg` | 打开 DMG 中的迁移器 |
| Linux x64 | `openbitfun-data-migrator-v<版本>-linux-x64.AppImage` | 添加可执行权限，在桌面会话中启动 |

Windows 需要 Microsoft Edge WebView2；macOS 使用系统 WebView，Linux 包以 Ubuntu 22.04
为构建基线。迁移不需要登录或联网，目前不产出 Windows/Linux ARM 安装包。

1. 关闭 BitFun、OpenBitFun、CLI 实例及其后台数据写入进程。
2. 启动迁移器，检查**来源和目标目录**。
3. 选择迁移范围，扫描数据，再运行预检。
4. 确认目标、范围和冲突后开始迁移。发现已知写入进程时会等待其退出，不会强制终止进程。
5. 查看结果，根据提示重新登录或修复路径，关闭迁移器，再自行打开 OpenBitFun。

## 支持范围与数据保护

支持来源为 **BitFun 0.2.17～0.2.19 正式版**，目标为 **OpenBitFun 1.0**。
暂不支持直接迁移 0.2.16 及更早版本；请先升级旧版 BitFun，并启动确认原有数据正常。

扫描会按单个会话、运行事件日志、Skill、MiniApp 和 Agent 定义隔离异常；有效条目继续迁移，
跳过的条目保留在来源中并记录到报告。旧会话的 Turn 计数以实际文件为准，仅在迁移副本中重建。
整个数据域不可用时，只跳过该域及依赖它的域。执行时某域失败会先回滚，再继续无依赖的数据域；
无法安全回滚时仍会停止。请在重试前查看警告与迁移报告。

目标是 OpenBitFun：配置 schema **1**、工作区格式 **1**、任务协调数据库 schema **2**，
以及此源码版本共享存储模块支持的会话、记忆、扩展和连接格式。未知产品/配置格式以及
超出支持范围的数据库、会话版本会被拒绝。

可迁移设置与凭据、用户 Agents/Skills/MiniApps、工作区与会话及任务记录、记忆、
本机保存的远程连接与设备记录。已有目标值优先，部分冲突会按领域规则保留双方。
缓存、锁、进程发现文件、内置可执行内容和请求追踪不迁移；不可解密的凭据需重新登录。

来源不会被自动删除。写入使用一致性快照、暂存、校验、备份、迁移锁和原子替换。
迁移期间请保持相关应用关闭；取消或关闭窗口会等到安全边界，已验证完成的领域可能已导入。

## 中断恢复与诊断

任务保存在：

```text
<目标设置与数据目录>/data/migrations/bitfun-to-openbitfun/runs/<任务 ID>/
```

重新打开迁移器，选择原来的目录，在“历史迁移任务”中查看或恢复。恢复会校验计划、
来源指纹和原目录，并沿用日志，不受原来十分钟交接请求有效期限制。
已完成任务仍可查看报告；新扫描会创建新任务，不会覆盖旧日志。
旧版交接流程留下的计划与日志仍可读取，即使 `request.json` 已过期；恢复前须选择原目录。
无法读取的任务文件不会被删除或重置。

迁移器只在自己的 `com.openbitfun.data-migrator` 配置目录中记住所选位置，不写主应用的
引导或提醒状态。“导出失败诊断”生成包含结果码和执行阶段的去敏文件。
完整报告与数据目录可能含个人信息；反馈时请按下文说明检查内容，并自行选择是否提供数据目录。

迁移器只操作运行电脑可访问的文件，不接入远程工作区执行、远程控制、Peer Device Mode
或 Detached Dispatch。请在数据所在电脑上运行；迁移连接记录并不连接或迁移远端主机。

## 异常排障

**迁移完成，但工作区或会话为空、部分数据缺失**

如果之前已经启动过 OpenBitFun 或执行过迁移，目标目录中的已有数据可能被优先保留，重试时不会覆盖。

如果 OpenBitFun 中没有需要保留的新数据，可以清空目标数据后重新迁移：

1. 完全退出 BitFun、OpenBitFun、CLI 及后台写入进程，以及其他迁移器实例。
2. 打开迁移器，检查目标位置，在“重置 OpenBitFun 数据”中点击“查看待重置目录”。
3. 另存列表目录中需要保留的数据、迁移日志及备份。**重置会永久删除这些目录的全部内容，包括 OpenBitFun 配置、凭据、助理工作区和会话，不会自动备份。**
4. 输入 `RESET`，点击“永久重置 OpenBitFun 数据”。如果部分目录未能完全删除，请关闭占用应用并重试，再进行迁移。
5. 重新扫描并开始新迁移，完成后再启动 OpenBitFun。

重置预览以所选目标位置为准；使用标准位置时，还会包含系统 Skills/SSH 所属的
OpenBitFun 目录，以及 `com.openbitfun.desktop` 下的桌面 WebView/UI 数据。
旧 BitFun 来源、迁移器自身配置和列表之外的普通项目目录会保留。
危险目录重叠、带符号链接或 junction 的重置路径会被拒绝。

Windows 目标目录：

```text
%APPDATA%\openbitfun
%USERPROFILE%\.openbitfun
%LOCALAPPDATA%\OpenBitFun
```

macOS 标准目录为 `~/.openbitfun` 和
`~/Library/Application Support/{openbitfun,OpenBitFun}`；Linux 为
`~/.openbitfun`、`~/.config/openbitfun` 和
`~/.local/share/{openbitfun,OpenBitFun}`（或对应的 XDG 目录）。
确认前请以迁移器显示的实际路径为准。

**重试后仍然异常**

请在 [GitHub Issues](https://github.com/GCWing/OpenBitFun/issues) 提交问题，或在 OpenBitFun 用户微信群中反馈，并提供：

- 操作系统、BitFun 版本、OpenBitFun 版本和迁移器版本。
- 操作步骤、预期结果及实际结果。
- 缺失数据所属的工作区、会话名称或 ID。
- 对应运行的迁移日志。

Windows 迁移日志目录：

```text
%APPDATA%\openbitfun\data\migrations\bitfun-to-openbitfun\runs\<运行ID>\
```

请提供对应运行目录中的日志文件，例如 `report.json`、`plan.json`、`journal.jsonl`、`locations.json` 和 `release-observation.json`（如存在）。`stage` 和 `backup` 目录包含个人数据，是否一并提供可自行选择；初次反馈通常只需上述日志文件。如果准备清空目标目录重试，请先保存这份日志。

提交前请检查日志中的用户名、路径等个人信息，按需脱敏。

## 开发与独立发布

安装 Rust、Node、pnpm 和对应系统的 Tauri 构建依赖后，在仓库根目录执行：

```bash
pnpm install
pnpm run data-migrator:dev       # 独立窗口，无需主应用或开发服务器
pnpm run data-migrator:build     # 独立发行包
cargo build -p openbitfun-data-migrator --bin openbitfun-data-migrator
```

直接 Cargo 构建使用已提交的静态 UI 和设计系统 CSS。修改主题源后运行
`pnpm run data-migrator:theme:generate`；独立打包入口会自动生成。
主应用开发和构建不再构建迁移器。两者仍在同一源码工作区共享稳定的数据契约和存储模块，
以保证格式一致，但迁移器不依赖主应用 Core、运行时组装、Web UI、安装器或更新器。

版本由迁移器自己的 `Cargo.toml` 和 `tauri.conf.json` 维护。**Data Migrator Package**
工作流支持手动构建，或通过 `data-migrator-v<版本>` 标签生成独立发布草稿。
标签发布使用专用的 `DATA_MIGRATOR_SIGNING_PRIVATE_KEY`、
`DATA_MIGRATOR_SIGNING_PRIVATE_KEY_PASSWORD`、`DATA_MIGRATOR_SIGNING_PUBKEY`，
完成签名和校验后创建草稿，审核后再发布。手动运行只生成 CI 构建产物。
迁移器发布不会触发主应用打包或更新源。

发布新版本时，同步更新默认分支上两份 README 顶部的最新版本链接，并检查工作流使用的
[RELEASE.md](RELEASE.md) 发布描述模板。保持指南路径不变，让用户分享的链接持续有效。

每个产物带 SHA-256 校验文件和 base64 编码的 minisign `.sig`，同时提供
`SHA256SUMS` 与 `data-migrator.minisign.pub`。验证签名前应通过可信渠道确认公钥。
独立文件签名不等于 Apple/Authenticode 系统代码签名；当前工作流尚未配置这些证书及 macOS 公证。

开发约束和针对性检查见 [AGENTS.md](AGENTS.md)。

### 损坏旧数据的处理粒度

设置和模型、工作区登记、记忆记录和文件、SSH 连接、Remote Connect 文件和 Bot、会话和扩展均按条目处理。损坏会话仍会恢复可读取的 Turn，重建 Turn 数量和工作区引用列表；相同 Turn 副本去重，身份冲突的 Turn 会跳过并报告。记忆笔记支持嵌套目录。旧记忆库的 jobs 不读取、不迁移，运行时按需创建任务，目标库已有 jobs 保留。Skill 或 MiniApp 不可用不会阻止 Agent 定义迁移。

有独立存储边界的条目在暂存失败时会从提交清单中排除，报告会显示遗漏和会话部分恢复提示。旧数据保持只读；无法读取的目标存储、路径越界、不支持的格式、输入变更和事务写入失败仍会保护相关域，成功回滚后其余独立域可继续。回滚失败时停止执行。
