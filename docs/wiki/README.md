# GitHub Wiki text sources

[中文](README.zh-CN.md)

This directory contains reviewable OpenBitFun 1.0 Wiki text. The publishable
Markdown is in `pages/`; `_Sidebar.md` and `_Footer.md` are Wiki navigation files.
There are no screenshot assets in this update. The bilingual screenshot checklist
records pending topics and capture requirements for a later contribution.

## Read and review

- [Home](pages/Home.md) / [中文首页](pages/首页.md)
- [Harness selection](pages/Agent-Modes.md) / [Harness 与智能体](pages/Agent-模式.md)
- [Sessions and goals](pages/Sessions-and-Goals.md) / [会话与持续目标](pages/会话与持续目标.md)
- [Scheduling](pages/Tasks-and-Automation.md) / [定时任务](pages/任务板与定时任务.md)
- [Remote guide](pages/Remote-and-Multi-device.md) / [远程指南](pages/远程与多设备.md)
- [Peer Device Mode](pages/Peer-Device-Mode.md) / [设备控制](pages/Peer-Device-Mode-中文.md)
- [Detached Dispatch](pages/Detached-Dispatch.md) / [远程派发](pages/远程任务派发.md)
- [Voice](pages/Voice-and-Realtime.md) / [语音](pages/语音与实时通话.md)
- [Screenshot checklist](pages/Screenshot-Checklist.md) / [截图清单](pages/截图清单.md)

The page bodies intentionally use extensionless Wiki links such as `(Home)`.
These resolve after publication to the Wiki, not as ordinary `.md` links in the
main repository. Use the file browser or this index during PR review. Keep page
filenames stable so existing Wiki URLs and cross-language links continue working.

Text is based on v1.0.0 documentation and development revision f72a28eb8, checked
on 2026-09-18. Review of source documentation is not runtime or remote scenario
testing. The Playbook remains the detailed, source-backed feature/settings
reference; Wiki pages provide conceptual and scenario-oriented guidance.

## Verification

From the main repository root:

```bash
node docs/wiki/check-links.mjs
pnpm run check:repo-hygiene
git diff --check
```

The focused check validates Wiki targets, language counterparts, local paths for
versioned source references, and screenshot topic/placeholder consistency. It does
not verify remote URLs, image availability, or application behavior.

## Publication is separate from PR merge

GitHub does not provide native pull requests for a `.wiki.git` repository.
The [Wiki editing guide](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages)
describes editing/cloning the separate Git repository; Wiki PR support is tracked
in [GitHub Community](https://github.com/orgs/community/discussions/50163).

Merge text changes into the main repository through a normal PR. A maintainer
with Wiki write access must then review and publish them separately. This update
adds no automatic synchronization, workflow, credential, or permission changes.
The main repository's `GITHUB_TOKEN` must not be assumed to grant Wiki write access.

The upstream Wiki snapshot reviewed for this refresh is
`f143e0b13a631909a3aa6818d43646c95a8a9b83`.

To publish, start from a fresh Wiki clone and compare its HEAD with that snapshot.
If it differs, stop and reconcile intervening edits before copying any pages.
Work from the reviewed main-repository revision, not an unreviewed working copy.

```bash
# Run from the reviewed main-repository checkout.
wiki_publish_dir=$(mktemp -d)
git clone https://github.com/GCWing/OpenBitFun.wiki.git "$wiki_publish_dir/wiki"
git -C "$wiki_publish_dir/wiki" log -1 --format=%H
```

Only after checking the snapshot and reconciling any newer Wiki changes:

```bash
cp docs/wiki/pages/*.md "$wiki_publish_dir/wiki/"
git -C "$wiki_publish_dir/wiki" status --short
git -C "$wiki_publish_dir/wiki" diff --check
git -C "$wiki_publish_dir/wiki" diff
git -C "$wiki_publish_dir/wiki" add -- '*.md'
git -C "$wiki_publish_dir/wiki" commit -m "docs: refresh OpenBitFun 1.0 wiki text"
git -C "$wiki_publish_dir/wiki" push origin HEAD:master
```

Copy only `pages/*.md`, not this README or the checker. Do not delete unlisted
pages, force-push, or overwrite intervening edits. Review the exact diff before
pushing. After publication, inspect both language home pages, sidebar, and links.
Screenshots remain a separate follow-up and are not a prerequisite for this text PR.
