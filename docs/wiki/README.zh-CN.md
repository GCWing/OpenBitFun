# GitHub Wiki 文字来源与发布

[English](README.md)

此目录用于通过主仓库 PR 审阅 OpenBitFun 1.0 Wiki 文字。可发布的 Markdown
位于 `pages/`，包含侧边栏和页脚；本次不添加截图素材，只保留截图占位与清单。

## 阅读入口

- [首页](pages/首页.md)与[产品全景](pages/产品全景.md)
- [Harness 与智能体](pages/Agent-模式.md)
- [会话与持续目标](pages/会话与持续目标.md)
- [任务板与定时任务](pages/任务板与定时任务.md)
- [远程与多设备](pages/远程与多设备.md)、[设备控制](pages/Peer-Device-Mode-中文.md)、[远程派发](pages/远程任务派发.md)
- [语音与实时通话](pages/语音与实时通话.md)
- [待补截图清单](pages/截图清单.md)

正文保留 Wiki 使用的无扩展名链接，如 `(首页)`。它们发布到 Wiki 后才按 Wiki
页面解析，不是主仓库中的普通 `.md` 链接；审阅时使用文件列表或此索引。
保留原页面文件名，以兼容旧 URL 和中英文互链。

核验基于 v1.0.0 文档及开发版本 f72a28eb8，日期为 2026-09-18；源码文档核对
不等于运行或远程实测。Playbook 继续提供完整功能/设置参考，Wiki 提供概念与场景教程。

## 检查与发布

在主仓库根目录运行：

```bash
node docs/wiki/check-links.mjs
pnpm run check:repo-hygiene
git diff --check
```

检查器校验 Wiki 目标、中英文互链、版本化源码引用的本地文件与截图主题/占位一致性，
不验证线上 URL、图片加载或应用行为。

GitHub Wiki 使用独立的 `.wiki.git` 仓库，没有原生 PR 合并流程。
本 PR 合入主仓库后，不会自动更新线上 Wiki。需要拥有 Wiki 写权限的维护者，
另行核对并发布。本次不引入自动同步、工作流、凭据或权限变更。

本次核对的上游 Wiki 提交为 `f143e0b13a631909a3aa6818d43646c95a8a9b83`。
发布前应新克隆 Wiki，检查 HEAD；若已有新提交，停止复制并先整合新增修改。
仅从已审阅的主仓库版本复制 `pages/*.md`，不复制 README 或检查器，不删除未列出的
页面，不强制推送。具体命令见[英文发布指南](README.md#publication-is-separate-from-pr-merge)。

发布后检查双语首页、导航和链接。截图以后单独补充，不阻塞本次文字 PR。
