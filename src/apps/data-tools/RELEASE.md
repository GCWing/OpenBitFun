# OpenBitFun Data Tools

OpenBitFun 数据工具提供数据迁移、数据重置和会话修复。数据迁移保留旧版 BitFun 数据，不会自动删除 BitFun 的数据目录。

OpenBitFun Data Tools provides data migration, data reset and session repair. Migration preserves the original BitFun data and does not automatically delete its data directories.

首页提供“数据迁移”“重置 OpenBitFun 数据”“会话修复”三个独立入口，按需进入流程。
重置用于清空目标后重新开始，会永久删除所选 OpenBitFun 数据。

新增并列的“会话修复”功能：扫描迁移造成的会话目录与助理身份异常，查看计划后执行。
包含本机保存的远程会话镜像，提供验证后的完整备份、任务恢复和回滚；无需 Python。

The home page offers **Data migration**, **Reset OpenBitFun data**, and
**Session repair**, each with its own workflow. Reset permanently removes the
selected OpenBitFun data when you need a clean start.

**Session repair** is a parallel tool for migration-damaged session locations and
assistant identities, including local remote-workspace mirrors. Scan and review
before applying; verified full backups, durable resume and rollback are included.
The GUI uses native Rust and does not require Python. Older migration tasks and
the existing bundle identity remain compatible. The executable is now
`openbitfun-data-tools`; build with `pnpm run data-tools:build`.

最新版本与使用指南：[中文](https://github.com/GCWing/OpenBitFun/blob/main/src/apps/data-tools/README.zh-CN.md) · Latest release and guide: [English](https://github.com/GCWing/OpenBitFun/blob/main/src/apps/data-tools/README.md)

## 中文

### 支持版本

- **来源：BitFun 0.2.17～0.2.19 正式版。**
- **目标：OpenBitFun 1.0。**
- 暂不支持直接迁移 BitFun 0.2.16 及更早版本。请先升级旧版 BitFun，并启动确认原有数据正常后再迁移。

### 如何使用

1. 下载本 Release 中适合你系统的数据工具，完成解压（如有）。Windows 用户解压 ZIP 后双击数据工具运行。
2. 完全退出 BitFun 和 OpenBitFun。
3. 使用原来运行 BitFun 的系统用户启动数据工具。
4. 在首页选择“数据迁移”，按提示确认来源和目标目录，选择需要迁移的数据，然后开始迁移。
5. 迁移完成后，检查结果中的警告和跳过项，再启动 OpenBitFun 确认数据。

建议迁移前备份数据，并在确认迁移结果前保留旧版 BitFun 数据。中断的迁移可以从已保存的迁移任务中恢复。

### 异常排障

**迁移完成，但工作区或会话为空、部分数据缺失**

如果之前已经启动过 OpenBitFun 或执行过迁移，目标目录中的已有数据可能被优先保留，重试时不会覆盖。

如果 OpenBitFun 中没有需要保留的新数据，可以清空目标数据后重新迁移：

1. 完全退出 BitFun、OpenBitFun、CLI 和后台写入进程。
2. 在数据工具首页选择“重置 OpenBitFun 数据”，检查目标位置，查看待重置目录并另存需要保留的数据和日志。**重置会永久清除现有配置、会话及其他本地数据，不会自动备份。**
3. 输入 `RESET` 并确认重置，再返回首页选择“数据迁移”。完成后再启动 OpenBitFun。

Windows 目标目录：

```text
%APPDATA%\openbitfun
%USERPROFILE%\.openbitfun
%LOCALAPPDATA%\OpenBitFun
```

**重试后仍然异常**

请在 [GitHub Issues](https://github.com/GCWing/OpenBitFun/issues) 提交问题，或在 OpenBitFun 用户微信群中反馈，并提供：

- 操作系统、BitFun 版本、OpenBitFun 版本和数据工具版本。
- 操作步骤、预期结果及实际结果。
- 缺失数据所属的工作区、会话名称或 ID。
- 对应运行的迁移日志。

Windows 迁移日志目录：

```text
%APPDATA%\openbitfun\data\migrations\bitfun-to-openbitfun\runs\<运行ID>\
```

请提供对应运行目录中的日志文件，例如 `report.json`、`plan.json`、`journal.jsonl`、`locations.json` 和 `release-observation.json`（如存在）。`stage` 和 `backup` 目录包含个人数据，是否一并提供可自行选择；初次反馈通常只需上述日志文件。如果准备清空目标目录重试，请先保存这份日志。

提交前请检查日志中的用户名、路径等个人信息，按需脱敏。

### 下载校验

每个安装包均附带 SHA-256 校验文件和 minisign 分离签名。该发布流程未配置平台代码签名或 macOS 公证。兼容性、恢复及签名校验说明请参阅本 Release 标签下的数据工具 README。

## English

### Supported versions

- **Source: stable BitFun releases 0.2.17–0.2.19.**
- **Target: OpenBitFun 1.0.**
- Direct migration from BitFun 0.2.16 or earlier is not supported. Upgrade BitFun first, then launch it and verify that your existing data is accessible before migrating.

### How to use

1. Download the data tool for your system from this release and extract it if necessary. On Windows, extract the ZIP and double-click the data tool.
2. Fully quit BitFun and OpenBitFun.
3. Run the data tool under the same system account you used for BitFun.
4. Choose **Data migration** on the home page, confirm the source and destination directories, select the data to migrate, and start migration.
5. Review any warnings or skipped items, then launch OpenBitFun and check your data.

Back up your data before migrating. Keep the original BitFun data until you have verified the results. Interrupted runs can be resumed from saved migration tasks.

### Troubleshooting

**Migration finishes, but workspaces or sessions are empty, or some data is missing**

If you have already launched OpenBitFun or run a migration, existing destination data may take precedence and remain unchanged during retries.

If OpenBitFun contains no new data you need to keep, you can clear its destination data and retry:

1. Fully quit BitFun, OpenBitFun, their CLI instances and background writers.
2. Choose **Reset OpenBitFun data** on the tool's home page, check the destination locations and review reset directories. Save any data and logs you need. **Reset permanently removes existing settings, sessions and other local data without creating a backup.**
3. Type `RESET` and confirm. Return to the home page and choose **Data migration**, then launch OpenBitFun after migration finishes.

Windows destination directories:

```text
%APPDATA%\openbitfun
%USERPROFILE%\.openbitfun
%LOCALAPPDATA%\OpenBitFun
```

**The issue persists after retrying**

Open a report in [GitHub Issues](https://github.com/GCWing/OpenBitFun/issues) or share your feedback in the OpenBitFun user WeChat group. Include:

- Your operating system and the BitFun, OpenBitFun, and Data Tools versions.
- Steps to reproduce, the expected result, and the actual result.
- The workspace and session name or ID associated with missing data.
- Migration logs from the affected run.

Windows migration log location:

```text
%APPDATA%\openbitfun\data\migrations\bitfun-to-openbitfun\runs\<run-id>\
```

Provide the log files from the affected run, such as `report.json`, `plan.json`, `journal.jsonl`, `locations.json`, and `release-observation.json` when present. The `stage` and `backup` directories contain personal data, so sharing them is optional and at your discretion; the log files listed above are usually sufficient for an initial report. Save the logs before clearing the destination directories for another attempt.

Review the logs for personal information, such as usernames and paths, and redact it as needed before submitting.

### Download verification

Each package includes a SHA-256 checksum file and a detached minisign signature. Platform code signing and macOS notarization are not configured by this release workflow. See the data tool README at this release tag for compatibility, recovery, and signature verification details.
