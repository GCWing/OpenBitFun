# User-Visible "OpenBitFun" Literals Outside the I18n Files (Scan)

> Point-in-time scan of 2026-11-10. The repo-wide i18n runtime notes that the canonical brand strings live in `src/shared/i18n/resources/shared/<locale>/terms.json` (`shared.product.name` = "OpenBitFun", `shared.product.remote` = "OpenBitFun Remote"). Literal usages below have NOT been through any i18n resource file.

## Scope and method

- Scopes grepped: `src/web-ui` (desktop UI), `src/apps/desktop` (desktop host), `src/mobile-web` (mobile browser client), `src/apps/mobile` (iOS / HarmonyOS / Android native clients).
- Excluded file types: tests, fixtures, mocks, lockfiles, images, docs (README/AGENTS), generated locale contracts.
- Every match of the exact case-sensitive token `OpenBitFun` was classified:
  - inside an i18n resource file (by definition localized)
  - comment
  - identifier-only usage (`OpenBitFun*` as camelCase code names, no quoted string)
  - platform i18n catalogs that are not part of the OpenBitFun shared i18n system (iOS `Localizable.xcstrings`, Android `strings.xml`, HarmonyOS `string.json`)
  - dev / build / config fixtures (fake relay, previews, project files, pet samples)

## Global counts

| Segment | Occurrences |
|---|---|
| Total matches across scopes | 3084 |
| Inside shared / surface i18n resource files | 1307 (fine by definition) |
| Comments | 81 (developer-facing only) |
| Non-resource code lines total | 1602 |
| — identifier-only usage (no UI string) | 870 |
| — platform catalogs outside shared i18n + dev/comment/config removed upstream | 325 |
| — quoted "OpenBitFun" brand-token lines reviewed here | 407 |

Identifiers such as `OpenBitFunTheme`, `OpenBitFunMark`, `initializeOpenBitFunControlBridge`, `openBitFunControlReady` are code names, never rendered, and are not listed further.

## Context-classified brand-token lines (407)

| Context | Lines | Meaning |
|---|---|---|
| UI literal (no i18n) | 30 | |
|  Generated catalog or content package with its own copy (outside the i18n system) | 129 | |
| Code identifier-key, storage key or log line | 19 | |
| User-reachable error / status text (no i18n) | 40 | |
| Needs manual review | 161 | |
| Agent-facing prompt text | 8 | |
| OS / system-level identity or legal notice (by design) | 8 | |
| Cryptographic domain-separation constant (must not change) | 2 | |
| Key/vector input of the platform localization scheme (method localized / literal key) | 10 | |

Per-surface totals:

| Surface | Lines |
|---|---|
| src/web-ui (total context hits) | 237 |
| src/apps/desktop (total context hits) | 100 |
| src/mobile-web (total context hits) | 8 |
| src/apps/mobile (total context hits) | 62 |

## Key findings to act on

1. `src/web-ui/src/app/components/panels/review-platform/ReviewPlatformPanel.tsx` L2386 renders `<CardHeader title="OpenBitFun Review" ...>` with a hard-coded English UI title outside every locale catalog.
2. `src/web-ui/src/app/components/NavPanel/workspaceSessionView.ts` L202 maps the session source to a hard-coded display name 'OpenBitFun'; `shared.product.name` exists and should feed it.
3. `src/web-ui/src/app/components/NavPanel/sections/sessions/useWorkspaceSessionDiscovery.ts` L165 builds a user-reachable English-only error mentioning OpenBitFun.
4. `src/mobile-web/src/pages/SessionListPage.tsx` L1614 / L1851, `src/mobile-web/src/components/RemoteHomePanel.tsx` L33, `src/mobile-web/src/pages/PairingPage.tsx` L175 and `src/mobile-web/index.html` L13 render the brand as JSX literals while mobile-web already ships `SHARED_TERMS_BY_LOCALE['fr-FR']`-style resources that contain `product.name` / `product.remote`; the same is true for HarmonyOS `WelcomeHome.ets`, `ConversationHeaderPolicy.ets (REMOTE_BRAND)`, Android `WelcomeHome.kt` and iOS launch/preview data (Swift files do localize through `model.localized(...)`, keyed by the full literal).
5. `src/apps/mobile/harmonyos/entry/src/main/ets/services/HarmonyTaskCompletionNotificationPort.ets` L12 renders a notification reason in English only ("Waiting for an active OpenBitFun task to finish") outside any catalog.
6. `src/apps/mobile/harmonyos/entry/src/main/ets/services/general-chat/GeneralChatExportFormatter.ets` L48 labels the exported assistant role 'OpenBitFun' instead of `shared.agents.Claw` / product name resources.
7. Desktop host surface strings wave: `src/apps/desktop/bootstrap-ui/*.{html}` is a self-contained static mini-app (own zh/en dictionaries); desktop start-up/plist/DMG strings, tools released for installers and `tauri.conf.json`/`Info.plist` product identity stay outside the shared i18n system by design and are tracked separately.
8. `src/web-ui/src/app/global-search/generated/interactive-capabilities.json` is the generated copy of `src/shared/interactive-capabilities/catalog.json`, which ships its own `titleZh/titleEn` style bilingual fields. It is a governed external catalog (see `scripts/product-identity-audit.test.mjs`) and is NOT the OpenBitFun i18n system; the brand appears 152 times in the generated artifact.
9. `src/web-ui/public/agent-companion-pets/openbitfun/pet.json` (`displayName`, long description, `author: 'OpenBitFun Team'`) is a stand-alone content package whose metadata is user-visible.
10. Several English-only exception errors in the desktop host, e.g. the release minimum-version checks in the couple of update/capability paths, reach the display path unlocalized in the audit sample.
11. The whole `src/apps/desktop/src/api/*.rs` layer emits English-only user-reachable messages and labels: `remote_connect_api.rs` ("remote OpenBitFun daemon did not connect to the relay within 30 seconds", `account_required: Sign in to OpenBitFun on the executing Desktop host first`, `ConnectionMethodInfo { name: "OpenBitFun Server", description: "Official OpenBitFun relay" }`), `dispatch_api.rs` ("provision persistent OpenBitFun daemon: …"), `agentic_api.rs` ("Project permission rules changed outside OpenBitFun. Reload before saving."). The Rust→UI transport layer owns no locale resources; these strings flow to the client verbatim.
12. Brand constants live as literals: `src/web-ui/src/shared/constants/app.ts` (`name: 'OpenBitFun', author: 'OpenBitFun Team'`), `src/web-ui/src/shared/utils/version.ts` (about/license text "MIT License - Copyright (c) 2025 OpenBitFun"), theme built-ins all carry `author: 'OpenBitFun Team'`. Central constants are an intended seam, but they bypass `shared.product.name` and the about text is not localized.
13. Welcome / dock brand literals in `src/web-ui/src/app/scenes/welcome/WelcomeScene.tsx` L178 (`OpenBitFun{t('welcomeScene.space.separator')}`), `src/web-ui/src/app/layout/FloatingMiniChat.tsx` L107/L236 (dock appName 'OpenBitFun'), HarmonyOS `WelcomeHome.ets` / Android `WelcomeHome.kt` per-letter brand glyph rendering, iOS `MobileLaunchConfiguration.swift` preview data.

## One constant audit note

Two occurrences are cryptographic domain-separation strings and must NEVER be branded after translation:

- `src/mobile-web/src/services/E2EEncryption.ts` L107 ('OpenBitFun Relay v1.0.0 device key')
- `src/apps/mobile/harmonyos/entry/src/main/ets/services/CloudAccountCrypto.ets` L19 (same key label)

## Appendix: all 407 classified lines

### `src/web-ui/index.html` — ui
- L9: `<title>OpenBitFun - AI Code Assistant</title>`
- L25: `"loadingApp": "正在启动 OpenBitFun...",`
- L40: `"loadingApp": "Starting OpenBitFun...",`
- L57: `"loadingApp": "正在啟動 OpenBitFun...",`
- L72: `"loadingApp": "Starting OpenBitFun...",`

### `src/web-ui/public/agent-companion-pets/openbitfun/pet.json` — catalog-copy
- L3: `"displayName": "OpenBitFun",`
- L4: `"description": "OpenBitFun's mascot — Bifang (毕方), a figure from Chinese mythology said to live on Mount Zhang'e. In the Classic of Mountains and Seas`

### `src/web-ui/src/app/App.tsx` — internal
- L444: `log.error('Failed to initialize the OpenBitFun control surface', error);`

### `src/web-ui/src/app/components/NavPanel/sections/sessions/useWorkspaceSessionDiscovery.ts` — error
- L165: `throw new Error('This host does not support completing external session discovery in one request; update OpenBitFun on the host');`

### `src/web-ui/src/app/components/NavPanel/sections/workspaces/WorkspaceProjectPermissionsDialog.tsx` — review
- L304: `error instanceof Error && error.message.includes('changed outside OpenBitFun')`
- L357: `setAdditionError(t(error instanceof Error && error.message.includes('changed outside OpenBitFun')`

### `src/web-ui/src/app/components/NavPanel/workspaceSessionView.ts` — review
- L202: `return source === 'openbitfun' ? 'OpenBitFun' : isExternalSessionEcosystem(source) ? EXTERNAL_SESSION_NAMES[source] : source;`

### `src/web-ui/src/app/components/RemoteConnectDialog/RemoteConnectDialog.tsx` — review
- L131: `'zh-CN': 'https://github.com/GCWing/OpenBitFun/blob/main/docs/remote-connect/feishu-bot-setup.zh-CN.md',`
- L132: `'en-US': 'https://github.com/GCWing/OpenBitFun/blob/main/docs/remote-connect/feishu-bot-setup.md',`

### `src/web-ui/src/app/components/panels/review-platform/ReviewPlatformPanel.tsx` — ui
- L2386: `<CardHeader title="OpenBitFun Review" description={reviewStatusText} actions={`

### `src/web-ui/src/app/global-search/generated/interactive-capabilities.json` — catalog-copy
- L3: `"product": "OpenBitFun",`
- L4: `"title": "OpenBitFun Playbook",`
- L12600: `"description": "Imported OpenBitFun pet-package directory.",`
- L18485: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L18490: `"description": "Optional directory on the OpenBitFun product host for a local process; never a remote workspace path.",`
- L18551: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L18610: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L18669: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L18733: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L20566: `"用创造模式安全定制正在运行的 OpenBitFun 前端"`
- L20572: `"Safely customize the running OpenBitFun frontend in Creative mode"`
- L20863: `"描述目标；OpenBitFun 会在会话中持续记录进度"`
- L20868: `"Describe the goal; OpenBitFun keeps progress in the session"`
- L20924: `"用创造模式安全定制正在运行的 OpenBitFun 前端",`
- L20928: `"Safely customize the running OpenBitFun frontend in Creative mode",`
- L21761: `"文件工具沿用 OpenBitFun 的工作区、权限与变更快照语义；写入后重新读取或查看差异确认结果"`
- L21765: `"The file tools preserve OpenBitFun workspace, permission, and change-snapshot semantics; read back or inspect the diff after writing"`
- L21946: `"文件工具沿用 OpenBitFun 的工作区、权限与变更快照语义；写入后重新读取或查看差异确认结果",`
- L21948: `"The file tools preserve OpenBitFun workspace, permission, and change-snapshot semantics; read back or inspect the diff after writing",`
- L22746: `"summaryZh": "在 OpenBitFun 内打开网页和本地服务；智能体可直接读取页面、选择元素并点击、填写、滚动或截图。",`
- L22747: `"summaryEn": "Open webpages and local services inside OpenBitFun, where an agent can inspect the page and select, click, fill, scroll, or capture elem`
- L22787: `"titleZh": "输入完整网址、本地域名或开发服务端口并在 OpenBitFun 内打开",`
- L22788: `"titleEn": "Open full URLs, local hostnames, or development-service ports inside OpenBitFun",`
- L23108: `"输入完整网址、本地域名或开发服务端口并在 OpenBitFun 内打开",`
- L23660: `"summaryZh": "在 OpenBitFun 内安装、创建和运行轻量应用，让界面、数据与智能体工作流组合在一起。",`
- L23661: `"summaryEn": "Install, create, and run lightweight apps inside OpenBitFun, combining UI, data, and agent workflows.",`
- L24612: `"summaryZh": "查看外部 AI 生态的内容与状态，导入受支持的 Skill、MCP、Hook，以及 Codex、Zcode 会话，并在 OpenBitFun 中继续对话。",`
- L24680: `"titleZh": "发现、移除和重新添加 Codex 来源会话，并在 OpenBitFun 分支中续聊",`
- L24681: `"titleEn": "Discover, remove and restore Codex source sessions, then continue in OpenBitFun branches",`
- L24685: `"reasonZh": "“发现、移除和重新添加 Codex 来源会话，并在 OpenBitFun 分支中续聊”由用户在生态兼容页开启发现或选择已移除的来源。打开来源时刷新历史，首次发送创建独立分支。归档、移除和分支删除各自独立，原应用历史保持不变。智能体打开入口，由用户选择具体会话。",`
- L24686: `"reasonEn": "“Discover, remove and restore Codex source sessions, then continue in OpenBitFun branches” requires the user to enable discovery or selec`
- L24691: `"titleZh": "发现、移除和重新添加 Zcode 来源会话，并在 OpenBitFun 分支中续聊",`
- L24692: `"titleEn": "Discover, remove and restore Zcode source sessions, then continue in OpenBitFun branches",`
- L24696: `"reasonZh": "“发现、移除和重新添加 Zcode 来源会话，并在 OpenBitFun 分支中续聊”由用户在生态兼容页开启发现或选择已移除的来源。打开来源时刷新历史，首次发送创建独立分支。归档、移除和分支删除各自独立，原应用历史保持不变。智能体打开入口，由用户选择具体会话。",`
- L24697: `"reasonEn": "“Discover, remove and restore Zcode source sessions, then continue in OpenBitFun branches” requires the user to enable discovery or selec`
- L24844: `"发现、移除和重新添加 Codex 来源会话，并在 OpenBitFun 分支中续聊",`
- L24845: `"Discover, remove and restore Codex source sessions, then continue in OpenBitFun branches",`
- L24846: `"发现、移除和重新添加 Zcode 来源会话，并在 OpenBitFun 分支中续聊",`
- L24847: `"Discover, remove and restore Zcode source sessions, then continue in OpenBitFun branches",`
- L25150: `"summaryZh": "从手机、Bot 或另一台 OpenBitFun 设备远程查看会话、回答权限并继续工作。手机与同账号设备互控默认使用官方 Relay，无需部署服务器；官方与局域网模式登录时均需联网。",`
- L25151: `"summaryEn": "Inspect sessions, answer permissions, and continue work from mobile, a bot, or another OpenBitFun device. Mobile and same-account device`
- L25265: `"titleZh": "进入 Peer Device Mode，把另一台 OpenBitFun 设备作为命令与事件数据面",`
- L25266: `"titleEn": "Enter Peer Device Mode and use another OpenBitFun device as the command and event data plane",`
- L25270: `"reasonZh": "“进入 Peer Device Mode，把另一台 OpenBitFun 设备作为命令与事件数据面”由多个实时状态相关步骤组成，目前没有一个能确定完成整个流程的单一结构化 Command；智能体会打开精确入口，并把后续交互保留在用户可见界面。",`
- L25271: `"reasonEn": "“Enter Peer Device Mode and use another OpenBitFun device as the command and event data plane” spans multiple live-state-dependent steps `
- L25514: `"进入 Peer Device Mode，把另一台 OpenBitFun 设备作为命令与事件数据面",`
- L25515: `"Enter Peer Device Mode and use another OpenBitFun device as the command and event data plane",`
- L25537: `"summaryZh": "把可持续运行的任务派发到另一台 OpenBitFun 主机；控制端可以断开，目标主机继续执行并保留记录。",`
- L25538: `"summaryEn": "Dispatch durable work to another OpenBitFun host; the controller may disconnect while the target continues and keeps the record.",`
- L25578: `"titleZh": "为目标主机配置运行环境并安装或更新 OpenBitFun CLI",`
- L25579: `"titleEn": "Provision the target runtime and install or update the OpenBitFun CLI",`
- L25583: `"reasonZh": "“为目标主机配置运行环境并安装或更新 OpenBitFun CLI”由多个实时状态相关步骤组成，目前没有一个能确定完成整个流程的单一结构化 Command；智能体会打开精确入口，并把后续交互保留在用户可见界面。",`
- L25584: `"reasonEn": "“Provision the target runtime and install or update the OpenBitFun CLI” spans multiple live-state-dependent steps and currently has no si`
- L25703: `"descriptionZh": "读取同账户下所有 OpenBitFun 设备（含本机，带 isCurrentDevice 标记、在线状态、型号与系统）以及本机已保存的 SSH 连接。回答“有几台设备”或派发前先调用；未登录账户时 devices 为空并说明原因。",`
- L25704: `"descriptionEn": "Read every OpenBitFun device on this account (including this one, marked isCurrentDevice, with online state, model and OS) plus this`
- L25873: `"为目标主机配置运行环境并安装或更新 OpenBitFun CLI",`
- L25874: `"Provision the target runtime and install or update the OpenBitFun CLI",`
- L26050: `"登录 OpenBitFun 账号（GitHub 或服务支持的邮箱验证码）",`
- L26055: `"Sign in to OpenBitFun with GitHub or an email code supported by the service",`
- L26677: `"titleZh": "拖动卡片到桌面任意位置，拖动卡片边缘或四角调整大小；关闭 OpenBitFun 时卡片消失，重新打开后按原位置和大小恢复",`
- L26678: `"titleEn": "Drag cards anywhere on the desktop and resize them from their edges or corners; they disappear when OpenBitFun closes and return with the `
- L26759: `"拖动卡片到桌面任意位置，拖动卡片边缘或四角调整大小；关闭 OpenBitFun 时卡片消失，重新打开后按原位置和大小恢复",`
- L26760: `"Drag cards anywhere on the desktop and resize them from their edges or corners; they disappear when OpenBitFun closes and return with the same positi`
- L26837: `"titleZh": "控制 OpenBitFun 是否在登录系统后自动启动",`
- L26838: `"titleEn": "Choose whether OpenBitFun launches automatically after system sign-in",`
- L26851: `"titleZh": "控制 OpenBitFun 运行期间是否阻止电脑自动睡眠",`
- L26852: `"titleEn": "Choose whether OpenBitFun prevents the computer from sleeping while it runs",`
- L26925: `"descriptionZh": "在当前桌面系统登录后自动启动 OpenBitFun。",`
- L26926: `"descriptionEn": "Launch OpenBitFun automatically after signing in to this desktop system.",`
- L26935: `"descriptionZh": "在 OpenBitFun 运行期间持有本机睡眠抑制器。",`
- L26936: `"descriptionEn": "Hold a local sleep inhibitor while OpenBitFun is running.",`
- L27014: `"控制 OpenBitFun 是否在登录系统后自动启动",`
- L27015: `"Choose whether OpenBitFun launches automatically after system sign-in",`
- L27016: `"控制 OpenBitFun 运行期间是否阻止电脑自动睡眠",`
- L27017: `"Choose whether OpenBitFun prevents the computer from sleeping while it runs",`
- L27201: `"descriptionZh": "使用系统、OpenBitFun 深色或 OpenBitFun 浅色外观。",`
- L27202: `"descriptionEn": "Use the system, OpenBitFun dark, or OpenBitFun light appearance.",`
- L27223: `"descriptionZh": "设置 OpenBitFun 的界面语言。",`
- L27224: `"descriptionEn": "Set the OpenBitFun interface language.",`
- L27410: `"让 OpenBitFun 使用 /path/to/pet 里的萌宠",`
- L27415: `"Make OpenBitFun use the pet at /path/to/pet",`
- L27427: `"descriptionZh": "读取当前角色以及 OpenBitFun 已导入的 Petdex 角色。",`
- L27428: `"descriptionEn": "Read the active character and Petdex characters imported into OpenBitFun.",`
- L27478: `"descriptionZh": "按角色 ID 或 OpenBitFun 包目录删除已导入角色；若正在使用则安全回退到默认角色。",`
- L27479: `"descriptionEn": "Delete an imported character by ID or OpenBitFun package path, safely falling back when it is active.",`
- L27502: `"description": "Imported OpenBitFun pet-package directory.",`
- L27569: `"让 OpenBitFun 使用 /path/to/pet 里的萌宠",`
- L27572: `"Make OpenBitFun use the pet at /path/to/pet",`
- L28818: `"summaryZh": "控制 OpenBitFun 是否从会话中提取和使用长期记忆，以及保留、整理和模型策略。",`
- L28819: `"summaryEn": "Control whether OpenBitFun extracts and uses long-term memory from sessions, including retention, consolidation, and model policy.",`
- L29581: `"descriptionZh": "设置 OpenBitFun 创建受管 Worktree 的统一根目录。",`
- L29582: `"descriptionEn": "Set the common root where OpenBitFun creates managed worktrees.",`
- L29615: `"descriptionZh": "允许 OpenBitFun 自动清理超过保留上限的受管 Worktree。",`
- L29616: `"descriptionEn": "Allow OpenBitFun to prune managed worktrees beyond the retention limit.",`
- L29919: `"titleZh": "控制 OpenBitFun 启动时是否自动连接浏览器",`
- L29920: `"titleEn": "Choose whether OpenBitFun reconnects browser control at startup",`
- L30108: `"descriptionZh": "OpenBitFun 启动后自动尝试连接浏览器控制。",`
- L30109: `"descriptionEn": "Automatically try to connect browser control after OpenBitFun starts.",`
- L30195: `"控制 OpenBitFun 启动时是否自动连接浏览器",`
- L30196: `"Choose whether OpenBitFun reconnects browser control at startup",`
- L30867: `"配置和查看 OpenBitFun Search HTTP Protocol v1"`
- L30872: `"Configure and inspect OpenBitFun Search HTTP Protocol v1"`
- L30877: `"titleZh": "在免费 Exa MCP、Exa Search API、Tavily、DeepSeek、Keenable 与 OpenBitFun Search HTTP Protocol 之间选择运行时服务",`
- L30878: `"titleEn": "Choose free Exa MCP, Exa Search API, Tavily, DeepSeek, Keenable, or OpenBitFun Search HTTP Protocol as the runtime provider",`
- L30882: `"reasonZh": "“在免费 Exa MCP、Exa Search API、Tavily、DeepSeek、Keenable 与 OpenBitFun Search HTTP Protocol 之间选择运行时服务”与各服务的配置状态相关，目前没有一个能安全完成选择、检查和保存整个流程的单一结构`
- L30883: `"reasonEn": "“Choose free Exa MCP, Exa Search API, Tavily, DeepSeek, Keenable, or OpenBitFun Search HTTP Protocol as the runtime provider” depends on `
- L30888: `"titleZh": "为 OpenBitFun Search HTTP Protocol 配置端点、认证方式和受限凭据 Header",`
- L30889: `"titleEn": "Configure the endpoint, authentication mode, and restricted credential header for OpenBitFun Search HTTP Protocol",`
- L30910: `"titleZh": "查看并复制 OpenBitFun Search HTTP Protocol v1 的请求、响应和传输限制",`
- L30911: `"titleEn": "Inspect and copy the request, response, and transport limits for OpenBitFun Search HTTP Protocol v1",`
- L30915: `"reasonZh": "协议说明仅在选中 OpenBitFun Search HTTP Protocol 时显示，并由设置页提供完整可复制内容；智能体会打开精确入口，避免用不完整摘要替代产品内协议。",`
- L30916: `"reasonEn": "The protocol specification is shown only when OpenBitFun Search HTTP Protocol is selected and the Settings page owns the complete copyabl`
- L30964: `"配置和查看 OpenBitFun Search HTTP Protocol v1",`
- L30967: `"Configure and inspect OpenBitFun Search HTTP Protocol v1",`
- L30968: `"在免费 Exa MCP、Exa Search API、Tavily、DeepSeek、Keenable 与 OpenBitFun Search HTTP Protocol 之间选择运行时服务",`
- L30969: `"Choose free Exa MCP, Exa Search API, Tavily, DeepSeek, Keenable, or OpenBitFun Search HTTP Protocol as the runtime provider",`
- L30970: `"为 OpenBitFun Search HTTP Protocol 配置端点、认证方式和受限凭据 Header",`
- L30971: `"Configure the endpoint, authentication mode, and restricted credential header for OpenBitFun Search HTTP Protocol",`
- L30974: `"查看并复制 OpenBitFun Search HTTP Protocol v1 的请求、响应和传输限制",`
- L30975: `"Inspect and copy the request, response, and transport limits for OpenBitFun Search HTTP Protocol v1",`
- L31299: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L31304: `"description": "Optional directory on the OpenBitFun product host for a local process; never a remote workspace path.",`
- L31331: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L31353: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L31375: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`
- L31402: `"description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product ho`

### `src/web-ui/src/app/global-search/interactiveCapabilityActivator.ts` — error
- L19: `if (!capability) throw new Error(`Unknown OpenBitFun capability: ${capabilityId}`);`

### `src/web-ui/src/app/global-search/openBitFunControlBridge.ts` — error
- L79: `if (!capability) throw new Error(`Unknown OpenBitFun capability: ${request.capabilityId}`);`

### `src/web-ui/src/app/layout/FloatingMiniChat.tsx` — ui
- L107: `appName={entry.kind === 'control' ? 'OpenBitFun' : entry.kind === 'miniapp' ? appName : resolveDisplayTitle(session)}`
- L236: `const label = (entry: DockConversation) => entry.kind === 'control' ? 'OpenBitFun' : entry.kind === 'miniapp'`
- L261: `}} /> : <OverflowText className="openbitfun-fmc__title-wrapper">{active ? label(active) : 'OpenBitFun'}</OverflowText>}`

### `src/web-ui/src/app/scenes/miniapps/customization/miniAppCustomizationPrompt.ts` — prompt
- L9: `'You are customizing a OpenBitFun MiniApp draft.',`

### `src/web-ui/src/app/scenes/miniapps/hooks/useMiniAppBridge.ts` — review
- L469: `replyError('This instance survives view reloads. Cancel a specific Agent turn, or stop the instance explicitly in OpenBitFun.');`

### `src/web-ui/src/app/scenes/miniapps/views/MiniAppSubmissionsView.tsx` — internal
- L67: `log.warn('Failed to load current OpenBitFun version for MiniApp submission defaults', error);`

### `src/web-ui/src/app/scenes/my-agent/InsightsScene.tsx` — internal
- L613: `{/* How You Use OpenBitFun */}`

### `src/web-ui/src/app/scenes/welcome/WelcomeScene.tsx` — ui
- L178: `OpenBitFun{t('welcomeScene.space.separator')}`

### `src/web-ui/src/app/services/AppManager.ts` — internal
- L404: `localStorage.removeItem('OpenBitFun-left-panel-width');`
- L405: `localStorage.removeItem('OpenBitFun-left-panel-collapsed');`
- L406: `localStorage.removeItem('OpenBitFun-right-panel-collapsed');`

### `src/web-ui/src/app/utils/projectDraft.ts` — review
- L27: `export const DEFAULT_PROJECT_SUBDIRECTORY = 'OpenBitFun/Projects';`

### `src/web-ui/src/assets/fonts/harmonyos-sans/NOTICE.txt` — system
- L3: `Non-Apple OpenBitFun GUI distributions use unmodified copies of HarmonyOS Sans`

### `src/web-ui/src/flow_chat/assets/subagent-avatars/palette.json` — catalog-copy
- L3: `"owner": "OpenBitFun subagent joystick character family",`

### `src/web-ui/src/flow_chat/components/ChatInput.tsx` — review
- L1424: `const canSwitchModes = chatInputModePolicy.canSwitchModes && !isSubagentInputTarget && currentSession?.mode !== 'OpenBitFun';`

### `src/web-ui/src/flow_chat/components/modern/ExportImageButton.tsx` — ui
- L125: `aria-label="OpenBitFun"`
- L127: `<div className="export-content__title" data-openbitfun-product-component="export-image" data-openbitfun-product-part="title">OpenBitFun</div>`
- L196: `<span className="export-content__footer-brand">OpenBitFun</span>`

### `src/web-ui/src/flow_chat/components/modern/useFlowChatToolActions.ts` — internal
- L98: `log.warn('Ignoring legacy OpenBitFun tool confirmation without a permission request id', { toolId });`
- L138: `log.warn('Ignoring legacy OpenBitFun tool rejection without a permission request id', { toolId });`

### `src/web-ui/src/flow_chat/components/voice/useRealtimeVoiceCall.ts` — internal
- L316: `log.warn('Failed to enqueue OpenBitFun task speech; retrying once', {`
- L336: `log.warn('Failed to speak OpenBitFun task update after retry', { sessionId, error });`
- L552: `error: 'A OpenBitFun task is already running through the client voice assistant',`
- L596: `: { kind: 'workspace', id: workspace?.id ?? boundTarget!.sessionId, name: workspace?.name ?? 'OpenBitFun' },`
- L693: `log.warn('Failed to return OpenBitFun task cancellation to realtime voice session', {`
- L715: `log.error('OpenBitFun client voice tool failed', { callId: call.callId, tool: call.name, error });`
- L725: `log.warn('Failed to return OpenBitFun task error to realtime voice session', { sendError });`

### `src/web-ui/src/flow_chat/components/voice/voiceClientContext.ts` — error
- L226: `throw new Error('No OpenBitFun workspace is currently open');`

### `src/web-ui/src/flow_chat/components/voice/voiceTaskBridge.ts` — review
- L75: `super('OpenBitFun task was cancelled');`
- L212: `.replace(/^(?:\u6211\|\u6211\u4EEC\|OpenBitFun)\s*/, '');`
- L315: `return 'OpenBitFun completed the task without a text response.';`
- L327: `return summary \|\| 'OpenBitFun completed the task without a text response.';`
- L394: `reject(new Error('OpenBitFun task timed out after 30 minutes'));`
- L531: `throw new Error('OpenBitFun task session disappeared before completion');`
- L535: `throw new Error(turn?.error \|\| session.error \|\| 'OpenBitFun task failed');`
- L576: `throw new Error('OpenBitFun task description is empty');`
- L613: `throw new Error('OpenBitFun task description is empty');`

### `src/web-ui/src/flow_chat/deep-review/action-bar/CapacityQueueNotice.tsx` — system
- L36: `defaultValue: 'The model provider is rate-limiting requests. OpenBitFun will wait briefly and continue when capacity returns.',`
- L40: `defaultValue: 'The model provider rejected another concurrent review request. OpenBitFun will retry after capacity opens.',`
- L44: `defaultValue: 'The model provider asked OpenBitFun to retry later. Waiting here avoids spending Review work while the provider cools down.',`
- L56: `defaultValue: 'The model provider reported temporary overload. OpenBitFun will wait briefly and then continue or reduce coverage.',`

### `src/web-ui/src/flow_chat/hooks/useChatInputModeSync.ts` — review
- L38: `const nextMode = sessionMode === 'OpenBitFun' ? 'OpenBitFun' : resolveAvailableChatInputMode({`

### `src/web-ui/src/flow_chat/services/controlConversation.ts` — internal
- L66: `flowChatStore.addExternalSession(result.sessionId, 'OpenBitFun', 'OpenBitFun', result.workspacePath,`

### `src/web-ui/src/flow_chat/services/flow-chat-manager/EventHandlerModule.ts` — review
- L1070: `if (agentType === 'OpenBitFun') return; // The control host registers its dedicated presentation reference.`

### `src/web-ui/src/flow_chat/services/flow-chat-manager/MessageModule.ts` — error
- L468: `throw new Error('External subagent command delegation requires the local OpenBitFun runtime');`

### `src/web-ui/src/flow_chat/tool-cards/MCPToolDisplay.tsx` — review
- L372: `hostInfo: { name: 'OpenBitFun', version: '1.0.0' },`

### `src/web-ui/src/flow_chat/tool-cards/openBitFunControlDiscovery.ts` — review
- L7: `super(`OpenBitFun discovery failed: ${code}`);`
- L29: `scope.assertCurrent('Read OpenBitFun discovery results');`
- L32: `scope.assertCurrent('Apply OpenBitFun discovery results');`

### `src/web-ui/src/flow_chat/tool-cards/toolCardMetadata.ts` — review
- L111: `displayName: 'OpenBitFun',`
- L115: `description: 'Discover and control OpenBitFun features and settings',`
- L513: `description: 'List, publish, update, delete, and manage access to OpenBitFun Pages',`
- L523: `description: 'Deploy a saved OpenBitFun Page version to production',`
- L533: `description: 'Publish OpenBitFun Page content (upload, save version, deploy)',`

### `src/web-ui/src/font-profiles/harmony-bundled.css` — review
- L3: `font-family: "OpenBitFun HarmonyOS Sans";`
- L11: `font-family: "OpenBitFun HarmonyOS Sans SC";`
- L81: `--openbitfun-font-family-sans: "OpenBitFun HarmonyOS Sans", system-ui, "Segoe UI", Arial, sans-serif;`
- L82: `--openbitfun-font-family-control: "OpenBitFun HarmonyOS Sans", system-ui, "Segoe UI", Arial, sans-serif;`
- L87: `--openbitfun-font-family-sans: "OpenBitFun HarmonyOS Sans SC", "OpenBitFun HarmonyOS Sans", system-ui, "Microsoft YaHei UI", sans-serif;`
- L88: `--openbitfun-font-family-control: "OpenBitFun HarmonyOS Sans SC", "OpenBitFun HarmonyOS Sans", system-ui, "Microsoft YaHei UI", sans-serif;`

### `src/web-ui/src/infrastructure/account-identity/AccountIdentityService.ts` — review
- L318: `throw new AccountIdentityError('failed', 'OpenBitFun authorized sign-in but returned no account.');`

### `src/web-ui/src/infrastructure/api/service-api/AppearanceMarketAPI.ts` — review
- L206: `filters: [{ name: 'OpenBitFun Appearance', extensions: ['openbitfun-appearance'] }],`

### `src/web-ui/src/infrastructure/appearance/builtins/chinaNight.ts` — review
- L36: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/chinaStyle.ts` — review
- L38: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/cyber.ts` — review
- L37: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/dark.ts` — review
- L38: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/light.ts` — review
- L46: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/midnight.ts` — review
- L37: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/monochrome.ts` — review
- L23: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/slate.ts` — review
- L38: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/appearance/builtins/tokyoNight.ts` — review
- L43: `author: 'OpenBitFun Team',`

### `src/web-ui/src/infrastructure/config/services/AgentCompanionPetService.ts` — review
- L129: `displayName: 'OpenBitFun',`
- L131: `"OpenBitFun's mascot — Bifang, a figure from Chinese mythology said to live on Mount Zhang'e. In the Classic of Mountains and Seas (Shan Hai Jing · We`

### `src/web-ui/src/infrastructure/config/skillSourcePresentation.ts` — review
- L4: `openbitfun: 'OpenBitFun',`
- L5: `'openbitfun-system': 'OpenBitFun',`

### `src/web-ui/src/infrastructure/file-export/saveHtmlFile.ts` — review
- L7: `if (!stem) stem = 'OpenBitFun';`

### `src/web-ui/src/infrastructure/peer-device/peerHostRefusal.ts` — review
- L10: `const UNKNOWN_TO_HOST = /command '[^']+' is unknown to this OpenBitFun \w+ peer host version/;`

### `src/web-ui/src/main.tsx` — internal
- L224: `log.info('Initializing OpenBitFun');`
- L318: `log.info('OpenBitFun core systems initialized successfully');`
- L352: `log.error('Failed to initialize OpenBitFun (pre-render)', error);`

### `src/web-ui/src/shared/constants/app.ts` — review
- L5: `name: 'OpenBitFun',`
- L8: `author: 'OpenBitFun Team',`

### `src/web-ui/src/shared/services/review-team/pathMetadata.ts` — review
- L69: `if (normalizedPath.startsWith('OpenBitFun-Installer/')) {`

### `src/web-ui/src/shared/services/reviewTargetClassifier.ts` — review
- L103: `match: { pathPrefixes: ['OpenBitFun-Installer/src/i18n/locales/'], extensions: ['.json'] },`
- L177: `match: { pathPrefixes: ['OpenBitFun-Installer/'] },`

### `src/web-ui/src/shared/utils/version.ts` — review
- L8: `name: 'OpenBitFun',`
- L104: `text: 'MIT License - Copyright (c) 2025 OpenBitFun',`

### `src/web-ui/src/tools/generative-ui/GenUIGallery.tsx` — ui
- L28: `<p className="gen-ui-gallery__eyebrow">OpenBitFun · OpenUI Lang</p>`

### `src/web-ui/src/tools/generative-ui/components/openbitfunComponents.tsx` — error
- L67: `if (event !== 'click') throw new Error('OpenBitFun button event is unavailable');`
- L72: `if (event !== 'change') throw new Error('OpenBitFun input event is unavailable');`
- L74: `if (!input \|\| input.disabled) throw new Error('OpenBitFun input is unavailable');`
- L210: `if (event !== 'change') throw new Error('OpenBitFun segmented control event is unavailable');`
- L223: `if (event !== 'change') throw new Error('OpenBitFun checkbox event is unavailable');`
- L262: `if (event !== 'change') throw new Error('OpenBitFun radio group event is unavailable');`

### `src/apps/desktop/Info.plist` — review
- L6: `<string>OpenBitFun uses the microphone for voice input and local speech transcription.</string>`

### `src/apps/desktop/bootstrap-ui/frontend-update-confirm.html` — ui
- L32: `<p id="message">OpenBitFun is waiting for the real app shell to render. You can roll back immediately if the preview looks wrong.</p>`
- L48: `messageLoading: 'OpenBitFun 正在等待真实应用界面完成渲染。如果预览不对，可以立即回滚。',`
- L49: `messageReady: function (seconds) { return '请在 <strong>' + seconds + '</strong> 秒内确认，否则 OpenBitFun 会自动恢复上一版本。'; },`
- L53: `bridgeError: 'OpenBitFun 宿主桥接不可用',`
- L60: `messageLoading: 'OpenBitFun is waiting for the real app shell to render. You can roll back immediately if the preview looks wrong.',`
- L61: `messageReady: function (seconds) { return 'Confirm within <strong>' + seconds + '</strong> seconds or OpenBitFun will restore the previous version aut`
- L65: `bridgeError: 'OpenBitFun host bridge is unavailable',`

### `src/apps/desktop/bootstrap-ui/index.html` — ui
- L6: `<title>OpenBitFun recovery</title>`
- L18: `<h1>OpenBitFun frontend recovery</h1>`
- L19: `<p>The external frontend bundle could not be loaded. Restart OpenBitFun to restore the packaged revision. / 外置前端无法加载，请重启 OpenBitFun 以恢复打包版本。</p>`

### `src/apps/desktop/capabilities/default.json` — review
- L4: `"description": "OpenBitFun default capabilities",`

### `src/apps/desktop/dmg-extras/If app is damaged read this.txt` — review
- L1: `If macOS says "OpenBitFun is damaged and can't be opened", follow these steps:`
- L3: `1. Drag OpenBitFun.app into the Applications folder`
- L7: `xattr -d com.apple.quarantine /Applications/OpenBitFun.app`
- L9: `4. Open OpenBitFun again — it should launch normally`
- L15: `Because OpenBitFun is not yet notarized by Apple, the system incorrectly reports`

### `src/apps/desktop/dmg-extras/如果提示已损坏请看这里.txt` — review
- L1: `如果 macOS 提示 "OpenBitFun 已损坏，无法打开"，请按以下步骤操作：`
- L3: `1. 将 OpenBitFun.app 拖入 Applications（应用程序）文件夹`
- L7: `xattr -d com.apple.quarantine /Applications/OpenBitFun.app`
- L9: `4. 再次打开 OpenBitFun 即可正常使用`
- L15: `由于 OpenBitFun 尚未进行 Apple 公证（Notarization），系统会误报"已损坏"。`

### `src/apps/desktop/src/api/agentic_api.rs` — error
- L1399: `"Project permission rules changed outside OpenBitFun. Reload before saving."`

### `src/apps/desktop/src/api/app_state.rs` — review
- L243: `.join("OpenBitFun")`

### `src/apps/desktop/src/api/appearance_market_api.rs` — error
- L309: `.map_err(\|_\| "Minimum OpenBitFun version must use semantic version syntax.".to_string())?;`
- L355: `.map_err(\|_\| "The release declares an invalid minimum OpenBitFun version.".to_string())?;`
- L358: `"The release declares a minimum OpenBitFun version earlier than 1.0.0.".to_string(),`
- L362: `.map_err(\|_\| "The current OpenBitFun version is invalid.".to_string())?;`
- L365: `"This Appearance requires OpenBitFun {minimum} or newer. Current version: {current}."`

### `src/apps/desktop/src/api/config_api.rs` — error
- L360: `.map_err(\|error\| format!("Failed to parse OpenBitFun config export: {error}"))?;`

### `src/apps/desktop/src/api/dispatch_api.rs` — error
- L266: `return Err(format!("provision persistent OpenBitFun daemon: {error}"));`

### `src/apps/desktop/src/api/dispatch_host.rs` — review
- L22: `"OpenBitFun CLI dispatch runner is not installed on this device; install `openbitfun` in ~/.local/bin or PATH"`

### `src/apps/desktop/src/api/generative_ui_api.rs` — review
- L30: `.user_agent("OpenBitFun/1.0 (GenUI host provider)")`

### `src/apps/desktop/src/api/miniapp_market_api.rs` — error
- L475: `.map_err(\|error\| format!("Could not read the OpenBitFun window position: {error}"))?;`
- L478: `.map_err(\|error\| format!("Could not read the OpenBitFun window size: {error}"))?;`
- L481: `"The OpenBitFun window is too small to capture a review screenshot.".to_string(),`
- L514: `"Window capture failed. On macOS, grant OpenBitFun Screen Recording permission: {error}"`
- L677: `.map_err(\|_\| "The release declares an invalid minimum OpenBitFun version.".to_string())?;`
- L680: `"The release declares a minimum OpenBitFun version earlier than 1.0.0.".to_string(),`
- L684: `.map_err(\|_\| "The current OpenBitFun version is invalid.".to_string())?;`
- L687: `"This MiniApp requires OpenBitFun {minimum} or newer. Current version: {current}."`

### `src/apps/desktop/src/api/peer_host_invoke.rs` — error
- L912: `error.contains("is unknown to this OpenBitFun desktop peer host version"),`
- L925: `"command 'lsp_open_workspace' is unsupported because the OpenBitFun LSP runtime has been retired"`

### `src/apps/desktop/src/api/remote_connect_api.rs` — error
- L988: `"remote OpenBitFun daemon did not connect to the relay within 30 seconds"`
- L1394: `"account_required: Sign in to OpenBitFun on the executing Desktop host first".to_string()`
- L2035: `name: "OpenBitFun Server".into(),`
- L2037: `description: "Official OpenBitFun relay".into(),`

### `src/apps/desktop/src/api/remote_workspace_policy.rs` — review
- L109: `"token usage is recorded by the current OpenBitFun runtime and does not follow the workspace filesystem to an SSH host"`

### `src/apps/desktop/src/api/search_api.rs` — review
- L127: `"Workspace search daemon is unavailable. OpenBitFun will continue using legacy search."`

### `src/apps/desktop/src/api/skill_api.rs` — error
- L88: `Err("Only OpenBitFun-owned, non-built-in Skills can be deleted from OpenBitFun".to_string())`
- L1864: `"Command 'npx' is not available. Install Node.js or configure OpenBitFun runtimes."`

### `src/apps/desktop/src/api/system_api.rs` — review
- L21: `None => "https://github.com/GCWing/OpenBitFun/releases/latest/download/latest-v1.json",`
- L77: `log::info!("GitHub updater metadata is unavailable; trying the OpenBitFun mirror first");`
- L88: `"GitHub updater speed is {} KiB/s, under the {} KiB/s bar; trying the synchronized OpenBitFun mirror first.",`

### `src/apps/desktop/src/appearance.rs` — review
- L611: `.title("OpenBitFun")`
- L1118: `.title("OpenBitFun Agent Companion")`

### `src/apps/desktop/src/desktop_cards/commands.rs` — error
- L96: `return Err("Desktop cards are turned off in OpenBitFun settings.".to_string());`

### `src/apps/desktop/src/desktop_cards/desktop_layer.rs` — review
- L37: `const ORIGINAL_STYLE: windows::core::PCWSTR = w!("OpenBitFun.DesktopCard.OriginalStyle");`

### `src/apps/desktop/src/desktop_cards/mod.rs` — error
- L221: `Err("Desktop cards are turned off in OpenBitFun settings.".to_string())`

### `src/apps/desktop/src/desktop_cards/refresh.rs` — system
- L93: `request = request.header("User-Agent", "OpenBitFun-DesktopCard");`

### `src/apps/desktop/src/desktop_cards/windows.rs` — review
- L173: `.title(format!("OpenBitFun Card - {}", card.title))`

### `src/apps/desktop/src/frontend_workbench.rs` — review
- L1341: `.title("Review OpenBitFun frontend update")`
- L2423: `assert!(String::from_utf8_lossy(response.body()).contains("OpenBitFun frontend recovery"));`

### `src/apps/desktop/src/lib.rs` — review
- L152: `let title = "OpenBitFun startup error"`
- L172: `eprintln!("OpenBitFun startup error: {message}");`
- L528: `eprintln!("=== OpenBitFun Desktop Starting ===");`
- L535: `"OpenBitFun could not select its Desktop agent profile and cannot continue.\n\n{error}\n\nSee early-startup.log for details."`
- L544: `"OpenBitFun could not initialize its configuration and cannot continue.\n\n{e}\n\nSee early-startup.log for details."`
- L698: `"OpenBitFun could not initialize its application state and cannot continue.\n\n{e}\n\nSee {} for details.",`
- L777: `"Existing OpenBitFun Desktop instance received launch request: args_count={}, cwd={}",`
- L799: `.app_name("OpenBitFun")`
- L923: `r"HKCU\Software\OpenBitFun Team\OpenBitFun",`
- L939: `r"HKCU\Software\OpenBitFun Team\OpenBitFun",`
- L1288: `log::info!("OpenBitFun Desktop started successfully");`

### `src/apps/desktop/src/macos_menubar.rs` — review
- L65: `about_openbitfun: "About OpenBitFun",`
- L78: `about_openbitfun: "關於 OpenBitFun",`
- L91: `about_openbitfun: "关于 OpenBitFun",`
- L112: `let app_menu = SubmenuBuilder::new(app, "OpenBitFun")`

### `src/apps/desktop/src/miniapp_desktop/launcher.rs` — review
- L293: `.ok_or("Missing OpenBitFun application directory")?`
- L565: `let host = root.path().join("OpenBitFun");`

### `src/apps/desktop/src/miniapp_desktop/mod.rs` — review
- L92: `return Err("The running OpenBitFun host uses an incompatible MiniApp protocol. Restart the host before opening this version.".into());`
- L104: `eprintln!("An existing OpenBitFun host in the {channel:?} channel accepted this launch; exiting the secondary process");`
- L111: `"The existing OpenBitFun host did not become ready; its data was left untouched"`
- L996: `return Err("MiniApp document is empty; rebuild it in OpenBitFun".into());`

### `src/apps/desktop/src/miniapp_desktop/sdk.rs` — review
- L157: `"agent.cancelStaleRuns" => Err("This instance survives view reloads. Cancel a specific Agent turn, or stop the instance explicitly in OpenBitFun.".int`

### `src/apps/desktop/src/miniapp_desktop/system_install.rs` — review
- L9: `.map(\|root\| root.join("Applications/OpenBitFun Apps"))`
- L13: `.map(\|root\| root.join("Microsoft/Windows/Start Menu/Programs/OpenBitFun Apps"))`
- L203: `host_executable: root.join("OpenBitFun"),`

### `src/apps/desktop/src/openbitfun_control_host.rs` — error
- L1006: `"The default OpenBitFun companion is unavailable".to_string()`
- L1243: `"The active OpenBitFun presentation surface detached".to_string()`

### `src/apps/desktop/src/sleep_prevention.rs` — review
- L122: `.reason("Prevent sleep is enabled in OpenBitFun")`
- L123: `.app_name("OpenBitFun")`

### `src/apps/desktop/src/tray.rs` — review
- L268: `.tooltip("OpenBitFun")`

### `src/apps/desktop/src/webview_recovery.rs` — review
- L259: `"OpenBitFun's display stopped responding and automatic recovery was paused to avoid a restart loop. Restart OpenBitFun now?",`
- L261: `.title("OpenBitFun display recovery")`
- L264: `"Restart OpenBitFun".to_string(),`
- L271: `MessageDialogResult::Custom(label) if label == "Restart OpenBitFun" => {`

### `src/apps/desktop/tauri.conf.json` — review
- L3: `"productName": "OpenBitFun",`
- L14: `"publisher": "OpenBitFun Team",`

### `src/apps/desktop/tauri.dev.conf.json` — review
- L3: `"productName": "OpenBitFun",`

### `src/mobile-web/index.html` — ui
- L13: `<title>OpenBitFun Remote</title>`

### `src/mobile-web/src/components/RemoteHomePanel.tsx` — ui
- L33: `<h2 id="remote-home-title">OpenBitFun</h2>`

### `src/mobile-web/src/pages/PairingPage.tsx` — ui
- L175: `<span>OpenBitFun</span>`

### `src/mobile-web/src/pages/SessionListPage.tsx` — ui
- L1614: `<h1>OpenBitFun</h1>`
- L1851: `<img src={logoMark} alt="OpenBitFun" className="session-list__logo" />`
- L1853: `<h1>OpenBitFun</h1>`

### `src/mobile-web/src/services/E2EEncryption.ts` — crypto
- L107: `return hkdf(sha256, shared, new TextEncoder().encode('OpenBitFun Relay v1.0.0 device key'), info, 32);`

### `src/mobile-web/src/services/RemoteSessionManager.ts` — error
- L46: `super('Connected host does not support workspace ID references; update OpenBitFun on that device');`

### `src/apps/mobile/android/app/src/androidTest/kotlin/com/openbitfun/mobile/app/ConversationHeaderTest.kt` — review
- L42: `contextTitle = "OpenBitFun · main",`
- L53: `composeRule.onNodeWithText("OpenBitFun · main").assertIsDisplayed()`

### `src/apps/mobile/android/app/src/main/AndroidManifest.xml` — review
- L16: `android:theme="@style/Theme.OpenBitFun">`

### `src/apps/mobile/android/app/src/main/kotlin/com/openbitfun/mobile/app/ui/shell/WelcomeHome.kt` — review
- L35: `val phrases = listOf("OpenBitFun", stringResource(R.string.welcome_work), stringResource(R.string.welcome_play), stringResource(R.string.welcome_yours`
- L58: `Row { "OpenBitFun".forEach { c -> WelcomeGlyph(c, G.WelcomeHeaderWordSize.value, Modifier) } }`
- L64: `Row(Modifier.height(48.dp).clearAndSetSemantics { contentDescription = "OpenBitFun" }, verticalAlignment = Alignment.CenterVertically) {`
- L106: `private fun welcomeDuration(word: String) = 250+word.length*185+(if(word=="OpenBitFun")600 else 0)+1800+650`

### `src/apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` — review
- L8: `foreground is the white OpenBitFun mark on transparency, sized to the safe`

### `src/apps/mobile/design-system/tokens/mobile-tokens.json` — review
- L4: `"name": "OpenBitFun Mobile",`

### `src/apps/mobile/harmonyos/AppScope/app.json5` — review
- L6: `"vendor": "OpenBitFun",`

### `src/apps/mobile/harmonyos/entry/src/main/ets/pages/components/WelcomeHome.ets` — i18n-input
- L58: `return ['OpenBitFun', RemoteI18n.t('home.welcome_work'), RemoteI18n.t('home.welcome_play'), RemoteI18n.t('home.welcome_yours')];`
- L60: `private duration(word: string): number { return 250 + word.length * 185 + (word === 'OpenBitFun' ? 600 : 0) + 1800 + 650; }`
- L94: `ForEach('OpenBitFun'.split(''), (letter: string) => { this.Glyph(letter, G.welcomeHeaderWordSize); })`

### `src/apps/mobile/harmonyos/entry/src/main/ets/pages/policy/ConversationHeaderPolicy.ets` — review
- L30: `static readonly REMOTE_BRAND: string = 'OpenBitFun';`

### `src/apps/mobile/harmonyos/entry/src/main/ets/services/CloudAccountCrypto.ets` — crypto
- L19: `salt: Encoding.utf8ToBytes('OpenBitFun Relay v1.0.0 device key'),`

### `src/apps/mobile/harmonyos/entry/src/main/ets/services/GitHubAccountProfile.ets` — system
- L55: `header: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'OpenBitFun-Mobile' },`

### `src/apps/mobile/harmonyos/entry/src/main/ets/services/HarmonyTaskCompletionNotificationPort.ets` — review
- L12: `const BACKGROUND_REASON: string = 'Waiting for an active OpenBitFun task to finish';`

### `src/apps/mobile/harmonyos/entry/src/main/ets/services/general-chat/GeneralChatExportFormatter.ets` — review
- L48: `return role === 'user' ? '用户' : 'OpenBitFun';`

### `src/apps/mobile/harmonyos/entry/src/main/ets/services/general-chat/ModelProviderGeneralChatAdapter.ets` — prompt
- L17: `'You are the general-purpose AI work assistant in the OpenBitFun HarmonyOS mobile app.',`
- L18: `'The OpenBitFun product is a local AI workbench built around a Code Agent for long-horizon engineering and productivity tasks.',`
- L19: `'The mobile app provides general chat plus entry points to OpenBitFun Remote/Code; this chat itself does not have local workspace access.',`
- L231: `workspaceName: 'OpenBitFun'`

### `src/apps/mobile/ios/OpenBitFun/App/MobileLaunchConfiguration.swift` — review
- L29: `ChatMessage(id: UUID(), role: .assistant, text: "这是 OpenBitFun 的移动端会话界面。你可以从手机连接桌面端，查看工作区、会话和智能体的执行状态。")`
- L126: `content: "// Remote workspace preview\nfn main() {\n    println!(\"Hello from OpenBitFun\");\n}\n",`
- L176: `secondaryLabel: "OpenBitFun 账号",`
- L311: `workspacePath: "/workspace/OpenBitFun",`
- L312: `workspaceName: "OpenBitFun"`
- L319: `workspacePath: "/workspace/OpenBitFun", workspaceName: "OpenBitFun", deviceKey: "preview-desktop"`
- L332: `let previewWorkspace = MobileWorkspaceGroup(path: "/workspace/OpenBitFun", name: "OpenBitFun", selected: true, sessions: remoteSessions.filter { $0.de`
- L340: `workspaceCatalog = [(path: "/workspace/OpenBitFun", name: "OpenBitFun", selected: true, remoteConnectionId: nil, remoteSshHost: nil, workspaceId: nil)`
- L342: `MobileAssistantOption(path: "/workspace/OpenBitFun/.openbitfun/assistants/review", name: "代码审查助手")`
- L349: `ChatMessage(id: UUID(), role: .assistant, text: "这是 OpenBitFun 的远程会话预览。"),`

### `src/apps/mobile/ios/OpenBitFun/App/OpenBitFunApp.swift` — i18n-input
- L56: `Text(model.localized("允许 OpenBitFun 在任务完成时发送通知。你可以稍后在系统设置中更改。"))`

### `src/apps/mobile/ios/OpenBitFun/Features/Account/AccountSettingsView.swift` — i18n-input
- L99: `label: model.localized(model.accountAuthorizationURL != nil ? "打开 OpenBitFun 授权"`

### `src/apps/mobile/ios/OpenBitFun/Features/Chat/ComposerBar.swift` — review
- L30: `? "向 OpenBitFun 提问"`
- L31: `: (model.localSessionSelected ? "输入消息" : "问问 OpenBitFun"))`

### `src/apps/mobile/ios/OpenBitFun/Features/Chat/ConversationHeader.swift` — review
- L16: `return "OpenBitFun"`

### `src/apps/mobile/ios/OpenBitFun/Features/Remote/RemoteHomeViews.swift` — i18n-input
- L124: `private var phrases: [String] { ["OpenBitFun", model.localized("干点活儿"), model.localized("玩点花样"), model.localized("随你发挥")] }`
- L132: `HStack(spacing: 0) { ForEach(Array("OpenBitFun".enumerated()), id: \.offset) { _, c in welcomeGlyph(c, size: MobileDesignGeometry.welcomeHeaderWordSiz`
- L201: `private func duration(_ word: String) -> Double { 250+Double(word.count)*185+(word == "OpenBitFun" ? 600 : 0)+1800+650 }`
- L203: `if reduceMotion { return ("OpenBitFun",2700) }`

### `src/apps/mobile/ios/OpenBitFun/Features/Settings/AppSettingsView.swift` — review
- L70: `value: "OpenBitFun iOS版"`

### `src/apps/mobile/ios/OpenBitFun/Features/Shell/RemoteCreateSessionView.swift` — i18n-input
- L200: `prompt: Text(model.localized(speech.isListening ? "正在聆听" : "告诉 OpenBitFun 要做什么"))`

### `src/apps/mobile/ios/OpenBitFun/Features/Shell/SidebarView.swift` — review
- L188: `Text(verbatim: "OpenBitFun")`

### `src/apps/mobile/ios/OpenBitFun/Features/Shell/StartupBrandReveal.swift` — review
- L30: `.accessibilityLabel("OpenBitFun")`

### `src/apps/mobile/ios/OpenBitFun/Info.plist` — review
- L6: `<string>OpenBitFun</string>`
- L12: `<string>OpenBitFun</string>`

### `src/apps/mobile/ios/OpenBitFun/Infrastructure/MobileCoreAdapter.swift` — review
- L82: `deviceName: "OpenBitFun iPhone",`

### `src/apps/mobile/ios/OpenBitFun/Infrastructure/Platform/TaskCompletionNotifier.swift` — review
- L45: `content.body = MobileLocalization.text("打开 OpenBitFun 查看结果。")`

### `src/apps/mobile/ios/OpenBitFunUITests/RemoteCodeSessionSendUITests.swift` — review
- L18: `"No active Remote Code Session is visible. Keep the phone unlocked and navigate OpenBitFun to the intended existing remote code session; this test wil`
- L340: `app.buttons["登录 OpenBitFun 账号"],`
- L341: `app.buttons["Sign in to OpenBitFun"],`

### `src/apps/mobile/miniapps/generate.cjs` — review
- L45: `const output = process.argv[3] \|\| path.resolve(__dirname, target === 'android' ? '../android/app/src/main/assets/miniapps' : '../ios/OpenBitFun/Reso`

### `src/apps/mobile/shared/core-crypto/src/commonMain/kotlin/com/openbitfun/mobile/core/crypto/DeviceIdentity.kt` — review
- L27: `SHA256, 32.bytes, "OpenBitFun Relay v1.0.0 device key".encodeToByteArray(), info,`

### `src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/generalchat/GeneralChatStore.kt` — prompt
- L755: `"You are the general-purpose AI work assistant in the OpenBitFun mobile app.",`
- L756: `"OpenBitFun is a local AI workbench built around a Code Agent for long-horizon engineering and productivity tasks.",`
- L757: `"The mobile app provides general chat plus entry points to OpenBitFun Remote/Code; this chat itself does not have local workspace access.",`

### `src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/session/ConversationHeaderPresentation.kt` — review
- L16: `private const val BRAND = "OpenBitFun"`

### `src/apps/mobile/shared/core-feature/src/commonTest/kotlin/com/openbitfun/mobile/core/feature/session/ConversationHeaderPresentationTest.kt` — review
- L18: `"OpenBitFun · feat/chat",`
- L26: `"OpenBitFun",`

### `src/apps/mobile/shared/core-feature/src/commonTest/kotlin/com/openbitfun/mobile/core/feature/session/SessionListPresentationTest.kt` — review
- L15: `selectedName = "OpenBitFun",`

### `src/apps/mobile/shared/core-transport/src/commonMain/kotlin/com/openbitfun/mobile/core/transport/CloudAccountClient.kt` — system
- L568: `headers.append("User-Agent", "OpenBitFun-Mobile")`

