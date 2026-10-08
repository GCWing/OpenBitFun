[中文](ui-testids-CN.md) | **English**

# UI Test IDs

This document records stable `data-testid` values used by OpenBitFun UI automation.
Test IDs are grouped by product area and should be added only when an automated
workflow needs a stable locator.

Rules:

- Use `data-testid` only as a test locator. Do not branch product logic on it.
- Prefer the real interactive element: `button`, `input`, editable region, or dialog root.
- Keep `data-testid` values stable, lowercase, and hyphen-separated.
- For repeated items, use one shared `data-testid` plus a stable data attribute.
- Do not use visible text, CSS classes, coordinates, screenshots, or XPath paths as primary locators.
- Prefer stable product identifiers in companion `data-*` attributes, such as `data-workspace-id`, `data-session-id`, `data-agent-id`, `data-skill-key`, or `data-settings-tab`.

## Coverage Planning

### Must Add

These areas are high-value UI automation entry points and should have stable IDs
before adding or expanding cross-platform pytest cases.

| Area | Scope | Rationale |
|---|---|---|
| App shell | App root, main content, scene viewport | App load and routing readiness anchors. |
| Navigation | Top actions, footer menu, workspace menu, workspace rows, session rows | Main path for opening settings, sessions, projects, agents, skills, and workspace-scoped actions. |
| Welcome scene | Scene root, open/new project buttons, recent workspace list | Default startup path currently lands here on OH. |
| Notifications | Notification button, center root, close button, active section | Current smoke coverage and async task visibility. |
| Settings | Scene root, nav tabs, active content | Current smoke coverage and future configuration tests. |
| Session and Flow Chat | Session scene, chat/aux panes, message list, composer | Main product workflow once session creation is stable. |
| Agents and Skills | Scene roots, zones/tabs, filters, cards, key actions | High-value navigation and marketplace/agent setup flows. |

### Optional Add

Add these when a concrete test needs them.

| Area | Scope | Rationale |
|---|---|---|
| Deep Review / BTW detail panels | Review action bars, reviewer/member details, report export actions | Valuable for deeper behavior tests, but not needed for app smoke. |
| Tool cards | Specific approve/retry/open-detail controls | Add per tool workflow instead of tagging every rendered result field. |
| File, Git, Terminal, Browser panels | Panel roots, primary toolbar actions, selected list rows | Useful once panel-specific pytest coverage exists. |
| Settings form controls | Specific model/provider fields and save/reset buttons | Add with configuration tests; avoid tagging every display-only label. |
| Mini apps | Gallery root, app cards, runner root | Add when Mini App flows enter the automation plan. |

### Not Recommended

Avoid adding IDs to these surfaces unless there is a clear automated workflow.

| Scope | Reason |
|---|---|
| Decorative icons, badges, counters, shadows, animations | Not meaningful interaction or state anchors. |
| Every text node, paragraph, and static label | Creates maintenance cost and duplicates i18n-visible content. |
| Generated markdown/code content and model output spans | Output is dynamic and should be asserted through higher-level state. |
| Coordinates, canvas pixels, screenshot-only markers, or native window controls | Cross-platform WebView automation should stay DOM and `data-testid` based. |
| Localized text copied into `data-testid` or required as the primary locator | Breaks when locales or copy change. |

## Naming

- Use area prefixes: `app-*`, `scene-*`, `nav-*`, `welcome-*`, `settings-*`, `notification-*`, `session-*`, `chat-*`, `flowchat-*`, `agents-*`, `skills-*`.
- Use action suffixes for buttons: `*-btn`, `*-toggle`, `*-open`, `*-close`, `*-submit`, `*-cancel`, `*-delete`.
- Use structure suffixes for containers: `*-scene`, `*-panel`, `*-list`, `*-grid`, `*-menu`, `*-content`, `*-zone`.
- For repeated rows/cards, reuse one `data-testid` and pair it with a stable attribute, for example:
  - `nav-workspace-item` + `data-workspace-id`
  - `nav-session-item` + `data-session-id`
  - `settings-nav-tab` + `data-settings-tab`
  - `agent-list-item` + `data-agent-id` / `data-agent-name`
  - `skill-list-item` + `data-skill-id` / `data-skill-name`
  - `skills-market-card` + `data-skill-install-id`

## App Shell

| Element name | data-testid | Notes |
|---|---|---|
| App layout root | `app-layout` | App load-ready anchor. |
| Main content area | `app-main-content` | Primary scene content container. |
| Navigation panel | `nav-panel` | Left navigation container. |
| Scene viewport root | `scene-viewport` | Scene host root. |
| Scene viewport clip | `scene-viewport-clip` | Mounted scene clip area. |
| Empty scene viewport | `scene-viewport-empty` | Rendered when no tabs are open. |
| Mounted scene wrapper | `scene-viewport-scene` | Repeated item. Pair with `data-scene-id` and `data-scene-active`. |

## Welcome

| Element name | data-testid | Notes |
|---|---|---|
| Welcome scene root | `welcome-scene` | Default startup scene anchor. |
| Open project button | `welcome-open-project-btn` | Opens the file/folder picker. |
| New project button | `welcome-new-project-btn` | Opens the new project flow. |
| Recent workspace list | `welcome-recent-workspace-list` | Present when recent workspaces exist. |
| Recent workspace row | `welcome-recent-workspace-row` | Repeated item. Pair with `data-workspace-id`. |
| Recent workspace open button | `welcome-recent-workspace-open` | Repeated item. Pair with `data-workspace-id`. |
| Recent workspace remove button | `welcome-recent-workspace-remove` | Repeated item. Pair with `data-workspace-id`. |
| Recent workspace empty state | `welcome-recent-workspace-empty` | Present when no recent workspace is available. |

## Navigation

| Element name | data-testid | Notes |
|---|---|---|
| Nav search trigger | `nav-search-trigger` | Opens navigation search. |
| New code session button | `nav-new-code-session-btn` | Creates or opens a code session for the active project workspace. |
| New cowork session button | `nav-new-cowork-session-btn` | Creates or opens a cowork session for the active project workspace. |
| Assistant button | `nav-assistant-btn` | Opens assistant/persona scene. |
| Agent/Skill entry | `agent-skill-entry` | Expands the Agents/Skills navigation entry group. |
| Agent/Skill panel | `agent-skill-panel` | Agents/Skills entry group or active discovery scene root. |
| Agent/Skill tabs | `agent-skill-tabs` | Navigation tab container for Agent and Skill entries. |
| Agent tab | `agent-tab` | Opens the Agents discovery scene. |
| Skill tab | `skill-tab` | Opens the Skills discovery scene. |
| Navigation sections | `nav-sections` | Container for workspace/session sections. |
| Navigation bottom bar | `nav-bottom-bar` | Container for Mini App/footer region. |
| Footer more button | `nav-footer-more-btn` | Opens the footer overflow menu. |
| Footer menu | `nav-footer-menu` | Overflow menu opened from the footer more button. |
| Footer settings item | `nav-footer-settings-item` | Opens the Settings scene from the footer menu. |
| Footer shell button | `shell-panel-entry` | Opens or closes the shell scene nav. |
| Footer browser button | `browser-panel-entry` | Opens browser scene or browser panel depending on active context. |

## Navigation Workspaces

| Element name | data-testid | Notes |
|---|---|---|
| Workspace add button | `nav-workspace-add-btn` | Opens workspace add/recent menu. |
| Workspace add menu | `nav-workspace-menu` | Portal menu opened from add button. |
| Workspace menu open project | `nav-workspace-menu-open-project` | Opens project picker. |
| Workspace menu new project | `nav-workspace-menu-new-project` | Opens new project flow. |
| Workspace menu remote SSH | `nav-workspace-menu-remote-ssh` | Opens SSH remote connect flow. |
| Workspace menu recent workspace | `nav-workspace-menu-recent-workspace` | Repeated item. Pair with `data-workspace-id`. |
| Workspace list | `nav-workspace-list` | Repeated by list type. Pair with `data-workspace-list`. |
| Workspace list empty state | `nav-workspace-list-empty` | Pair with `data-workspace-list`. |
| Workspace drop target | `nav-workspace-drop-target` | Repeated drag target. Pair with `data-workspace-id`. |
| Workspace row | `nav-workspace-item` | Repeated item. Pair with `data-workspace-id`, `data-workspace-kind`, and `data-workspace-active`. |
| Workspace card | `nav-workspace-card` | Clickable row body. Pair with `data-workspace-id`. |
| Workspace sessions toggle | `nav-workspace-sessions-toggle` | Expands/collapses session rows. Pair with `data-workspace-id`. |
| Workspace name button | `nav-workspace-name-btn` | Activates workspace or toggles sessions. Pair with `data-workspace-id`. |
| Workspace files button | `nav-workspace-files-btn` | Opens file viewer for workspace. Pair with `data-workspace-id`. |
| Workspace search index button | `nav-workspace-search-index-btn` | Opens search index status modal when present. Pair with `data-workspace-id`. |
| Workspace row menu button | `nav-workspace-menu-btn` | Opens row action menu. Pair with `data-workspace-id`. |
| Workspace row menu | `nav-workspace-item-menu` | Portal menu for one workspace. Pair with `data-workspace-id`. |
| Workspace create session | `nav-workspace-menu-create-session` | Assistant workspace session action. |
| Workspace create code session | `nav-workspace-menu-create-code-session` | Normal workspace code session action. |
| Workspace create cowork session | `nav-workspace-menu-create-cowork-session` | Normal workspace cowork session action. |
| Workspace create ACP session | `nav-workspace-menu-create-acp-session` | Repeated item. Pair with `data-acp-client-id`. |
| Workspace related paths | `nav-workspace-menu-related-paths` | Opens related paths dialog. |
| Session worktree toggle | `chat-input-worktree-toggle` | Chat input strip. Toggles worktree isolation for the current session. Pair with `data-worktree-enabled`. |
| Workspace copy path | `nav-workspace-menu-copy-path` | Copies workspace path. |
| Workspace reveal | `nav-workspace-menu-reveal` | Reveals workspace in file explorer. |
| Workspace session storage | `nav-workspace-menu-open-session-storage` | Opens the host-managed sessions root, including a local remote-workspace mirror. Local desktop only. |
| Workspace close | `nav-workspace-menu-close` | Closes workspace. |
| Workspace reset assistant | `nav-workspace-menu-reset-assistant` | Resets default assistant workspace. |
| Workspace delete assistant | `nav-workspace-menu-delete-assistant` | Deletes named assistant workspace. |
| Workspace session region | `nav-workspace-session-region` | Contains sessions for one workspace. Pair with `data-workspace-id`. |

## Navigation Sessions

| Element name | data-testid | Notes |
|---|---|---|
| Session list | `nav-session-list` | Workspace-scoped list. Pair with `data-workspace-id`. |
| Session row | `nav-session-item` | Repeated item. Pair with `data-session-id`, `data-session-kind`, `data-session-level`, and `data-session-active`. |
| Session menu button | `nav-session-menu-btn` | Opens row action menu. Pair with `data-session-id`. |
| Session menu | `nav-session-menu` | Portal menu for one session. Pair with `data-session-id`. |
| Session rename item | `nav-session-menu-rename` | Starts session rename. |
| Session copy ID item | `nav-session-menu-copy-id` | Copies the session ID. Pair with `data-session-id`. |
| Session storage | `nav-session-menu-open-storage` | Opens this session's stored directory. Pair with `data-session-id`. Unavailable for peer and detached-dispatch sessions. |
| Session scheduled jobs item | `nav-session-menu-scheduled-jobs` | Opens scheduled jobs for the session. Pair with `data-session-id`. |
| Session archive item | `nav-session-menu-archive` | Archives the session. Pair with `data-session-id`. |
| Session delete item | `nav-session-menu-delete` | Deletes session. |
| Session list toggle | `nav-session-list-toggle` | Expands/collapses long session lists. |

## Session And Chat

| Element name | data-testid | Notes |
|---|---|---|
| Session scene root | `session-scene` | Session scene anchor. |
| Session chat pane | `session-chat-pane` | Left chat pane within session scene. |
| Session right pane resizer | `session-right-pane-resizer` | Splitter between chat and aux pane. |
| Session aux pane | `session-aux-pane` | Right content canvas pane. Includes `data-mode`. |
| Chat pane root | `chat-pane` | FlowChat host pane. |
| FlowChat container | `flowchat-container` | FlowChat root. Includes `data-session-id`. |
| FlowChat messages region | `flowchat-messages` | Message list/welcome panel host. |
| FlowChat message list | `flowchat-message-list` | Virtual message list root when messages exist. |
| FlowChat empty message list | `flowchat-message-list-empty` | Empty virtual list state. |
| FlowChat message item | `flowchat-message-item` | Repeated virtual item. Pair with `data-turn-id`, `data-item-type`, and `data-item-index`. |
| Chat input container | `chat-input-container` | Root container for the composer. |
| Chat input editable region | `chat-input-textarea` | Rich text editable region. |
| Chat send button | `chat-input-send-btn` | Send action when input is valid. |
| Chat cancel button | `chat-input-cancel-btn` | Cancels in-progress send/generation when present. |
| Chat continue interrupted button | `chat-input-continue-interrupted-btn` | Resumes the latest recoverably interrupted turn when the composer is empty. |
| Chat input workspace strip | `chat-input-workspace-strip` | Active workspace strip above composer. |
| Chat input target switcher | `chat-input-target-switcher` | Target/mode switcher. |
| Chat input image strip | `chat-input-image-strip` | Attached image strip. |
| Chat input start BTW button | `chat-input-boost-start-btw` | Starts the BTW flow when present. |
| Chat model selector button | `chat-model-selector-btn` | Opens the session model selector. |
| Chat model selector menu | `chat-model-selector-menu` | Model selector dropdown root. |
| Chat model selector option | `chat-model-selector-option` | Repeated item. Pair with `data-model-id`, `data-model-name`, and `data-selected`. |
| Chat model selector provider | `chat-model-selector-provider` | Repeated item. First-level provider row that opens its models. Pair with `data-provider-key` and `data-selected`. |
| Chat model selector back | `chat-model-selector-back` | Returns from one provider's models to the provider list. |
| Chat user message | `chat-user-message` | Repeated user message. Pair with `data-turn-id`, `data-status`, and `data-failed`. |
| Chat user message content | `chat-user-message-content` | User message text content. Pair with `data-turn-id`. |
| Chat assistant message | `chat-assistant-message` | Repeated model round container. Pair with `data-turn-id`, `data-round-id`, `data-status`, `data-model-id`, `data-model-alias`, and `data-streaming`. |
| Chat assistant message content | `chat-assistant-message-content` | Assistant text block. Pair with `data-turn-id`, `data-flow-item-id`, `data-status`, and `data-streaming`. |
| Chat explore group | `chat-explore-group` | Explore-group root that wraps collapsed/merged tool rounds. Includes `data-group-kind`, `data-expanded`, `data-read-count`, `data-search-count`, and `data-command-count`. |
| Chat explore group toggle | `chat-explore-group-toggle` | Real click target that expands/collapses an explore group. Includes `data-group-kind` and `data-expanded`. |
| Chat explore group content | `chat-explore-group-content` | Inner content container for explore-group items. Includes `data-group-kind` and `data-expanded`. |
| Chat thinking panel | `chat-thinking-panel` | Thinking/reasoning panel root. Includes `data-status`, `data-streaming`, and `data-expanded`. |
| Chat thinking toggle | `chat-thinking-toggle` | Clickable thinking expand/collapse header. |
| Chat thinking content | `chat-thinking-content` | Thinking/reasoning text content. Includes `data-status` and `data-streaming`. |
| Chat shell command card | `chat-shell-command-card` | Shell command tool card root. Includes `data-status`, `data-expanded`, and `data-terminal-session-id`. |
| Chat shell command toggle | `chat-shell-command-toggle` | Click target for expanding/collapsing a shell command card. |
| Chat shell command text | `chat-shell-command-text` | Shell command text node. |
| Chat shell command output | `chat-shell-command-output` | Shell command stdout/stderr or live output area. |
| Chat shell command exit code | `chat-shell-command-exit-code` | Exit code node. Includes `data-exit-code` and `data-status`. |
| Chat shell tool card | `chat-shell-tool-card` | Outer FlowToolCard wrapper for ExecCommand. Includes `data-tool-name` and `data-tool-card-id`. |
| Chat shell tool open panel | `chat-shell-tool-open-panel` | Opens the associated terminal panel when a terminal session is available. |
| Chat browser tool card | `chat-browser-tool-card` | Outer FlowToolCard wrapper for WebFetch. Includes `data-tool-name` and `data-tool-card-id`. |
| Chat file change card | `chat-file-change-card` | File operation card root. Includes `data-status`, `data-action`, `data-path`, and `data-expanded`. |
| Chat file change toggle | `chat-file-change-toggle` | Click target for expanding/collapsing a file operation card. |
| Chat file change path | `chat-file-change-path` | File path/name node. Includes `data-path`. |
| Chat file change action | `chat-file-change-action` | File operation action node. Includes `data-action`. |
| Chat file change preview | `chat-file-change-preview` | Code/diff preview area for file operation cards. |
| Chat MiniApp card | `chat-miniapp-card` | MiniApp result card root. Includes `data-status`, `data-app-id`, and `data-expanded`. |
| Chat MiniApp title | `chat-miniapp-title` | MiniApp title/name node. Includes `data-app-id`. |
| Chat MiniApp file list | `chat-miniapp-file-list` | MiniApp result file list container. |
| Chat MiniApp file row | `chat-miniapp-file-row` | MiniApp result file row. Includes `data-path`. |
| Chat MiniApp open button | `chat-miniapp-open-btn` | Opens the MiniApp scene. Includes `data-app-id`. |
| Pending queue panel | `pending-queue-panel` | Pending background task queue. |

## Settings

| Element name | data-testid | Notes |
|---|---|---|
| Settings scene root | `settings-scene` | Root content area for the Settings scene. Includes `data-settings-tab`. |
| Settings scene content | `settings-scene-content` | Active settings tab content wrapper. |
| Settings navigation root | `settings-nav` | Left-side settings navigation. |
| Settings navigation tab | `settings-nav-tab` | Repeated item. Pair with `data-settings-tab`. |

## Settings Models

| Element name | data-testid | Notes |
|---|---|---|
| Model list | `settings-model-list` | Container for configured model rows. |
| Create first model config button | `settings-model-create-first-config-btn` | Starts the first model provider setup from the empty state. |
| Custom model config button | `settings-model-custom-config-btn` | Starts custom provider configuration. Includes `data-provider-id="custom"`. |
| Model provider option | `settings-model-provider-option` | Repeated provider row. Pair with `data-provider-id`, for example `openbitfun`. The resting list is truncated, so reach a provider outside it through the search field or the expand button below. |
| Model provider search | `settings-model-provider-search` | Filters the preset provider list by provider name, id, or model name. |
| Model provider expand button | `settings-model-provider-expand-btn` | Expands the truncated preset provider list to every provider, and collapses it again. |
| Model provider name input | `settings-model-provider-name-input` | Provider/config display name field, such as a mock LLM provider name. |
| Model API key input | `settings-model-api-key-input` | API key field in the model configuration form. Do not hardcode real keys in tests; load them from local config. |
| Model base URL input | `settings-model-base-url-input` | API base URL field for custom/OpenAI-compatible providers. |
| Model request format select | `settings-model-request-format-select` | Request format selector, for example OpenAI-compatible vs Anthropic. |
| Model select button | `settings-model-select-btn` | Opens the model selection dropdown. |
| Model selection menu | `settings-model-select-menu` | Model selection dropdown root. |
| Model selection option | `settings-model-option` | Repeated dropdown item. Pair with `data-model-id`, `data-model-name`, and `data-selected`. |
| Manual model name input | `settings-model-manual-name-input` | Manual/custom model name entry field. |
| Add custom model button | `settings-model-add-custom-btn` | Adds the manual model name into the selected model list. |
| Selected model list | `settings-model-selected-list` | Selected model draft list. Includes `data-selected-count`. |
| Selected model empty state | `settings-model-selected-list-empty` | Empty selected model draft state. Includes `data-selected-count="0"`. |
| Selected model row | `settings-model-selected-row` | Repeated selected model draft. Pair with `data-model-id`, `data-model-name`, `data-selected`, and `data-expanded`. |
| Selected model remove button | `settings-model-selected-remove-btn` | Removes a selected model draft. Pair with `data-model-id` and `data-model-name`. |
| Model save button | `settings-model-save-btn` | Saves the model provider/configuration form. |
| Model row | `settings-model-row` | Repeated saved model row. Pair with `data-model-id`, `data-model-name`, and `data-config-id`. |
| Model test status | `settings-model-test-status` | Repeated saved model test status. Pair with `data-model-id`, `data-model-name`, `data-config-id`, and `data-status` (`success` or `error`). |

## Settings Appearance

| Element name | data-testid | Notes |
|---|---|---|
| Appearance config root | `appearance-config` | Appearance page content root inside the settings scene. |
| Appearance theme section | `appearance-theme-section` | Language and theme settings section root. |
| Appearance font section | `appearance-font-section` | Font preference section root. |
| Appearance language select | `appearance-language-select` | Language select trigger in Appearance settings. |
| Appearance language option | `appearance-language-option` | Repeated language dropdown option. Includes `data-locale-id` and Select-provided `data-selected`. |
| Appearance theme select | `appearance-theme-select` | Theme select trigger in Appearance settings. |
| Appearance palette option | `appearance-palette-option` | Repeated appearance dropdown option. Includes `data-appearance-id` and Select-provided `data-selected`. |
| Appearance UI font level group | `appearance-ui-font-level-group` | UI font preset control root. Presets render as design-system segmented control segments; target one via `[data-openbitfun-part="segment"][data-openbitfun-value="<level>"]`, selected segment has `aria-checked="true"`. |
| Appearance UI font custom controls | `appearance-ui-font-custom-controls` | Custom UI font px controls root, rendered when custom is active. |
| Appearance UI font custom input | `appearance-ui-font-custom-input` | Custom UI font px number input. Includes `data-font-level="custom"`. |
| Appearance UI font custom step minus | `appearance-ui-font-custom-step-minus` | Custom UI font px decrement button. |
| Appearance UI font custom step plus | `appearance-ui-font-custom-step-plus` | Custom UI font px increment button. |
| Appearance UI font preview | `appearance-ui-font-preview` | UI font preview area. |
| Appearance font reset button | `appearance-font-reset-btn` | Resets font preferences to defaults. |

## Shell Panel

| Element name | data-testid | Notes |
|---|---|---|
| Shell panel entry | `shell-panel-entry` | Footer entry that opens the Shell scene/nav. |
| Shell panel | `shell-panel` | Shell scene, shell nav, or terminal scene root. |
| Shell panel title | `shell-panel-title` | Shell nav title or active terminal toolbar title. |
| Shell command list | `shell-command-list` | Shell nav terminal list or active terminal container. |
| Shell command item | `shell-command-item` | Shell nav row or active xterm root. Includes `data-command-id` and, when available, `data-command-status`. |
| Shell command text | `shell-command-text` | Shell nav terminal/session label. |
| Shell command output | `shell-command-output` | Real xterm output container for the active terminal. |
| Shell command exit code | `shell-command-exit-code` | Terminal status bar exit code when the session has exited. Includes `data-exit-code` and `data-status`. |
| Shell command status | `shell-command-status` | Shell nav status dot, terminal loading/error state, or terminal status bar. Includes `data-command-status`. |
| Shell command rerun | `shell-command-rerun` | Retry button in terminal error state or Ctrl+C toolbar action on active terminal. |
| Shell panel close | `shell-panel-close` | Active terminal close button. |

Notes:

- The standalone xterm terminal does not expose a structured per-command history DOM. Tests should use `shell-command-output` for rendered terminal output and `chat-shell-command-*` for structured ExecCommand card assertions.
- `shell-command-copy` is not currently exposed because the active terminal copy action is context-menu/selection driven rather than a stable visible button.

## Browser Panel

| Element name | data-testid | Notes |
|---|---|---|
| Browser panel entry | `browser-panel-entry` | Footer entry that opens the Browser scene or Browser panel, depending on active context. |
| Browser panel | `browser-panel` | Browser scene or right-side Browser panel root. |
| Browser panel title | `browser-panel-title` | Browser toolbar/form region. |
| Browser URL input | `browser-url-input` | Real URL input field. Press Enter to open the typed URL. |
| Browser page frame | `browser-page-frame` | iframe/webview host content area. |
| Browser loading indicator | `browser-loading-indicator` | Refresh/loading icon while a URL is loading. |
| Browser error message | `browser-error-message` | URL validation/connectivity/webview load failure message. |
| Browser current URL | `browser-current-url` | Current URL display in the webview placeholder. |
| Browser refresh button | `browser-refresh-button` | Refreshes the current browser page. |
| Browser back button | `browser-back-button` | Navigates browser history back. |
| Browser forward button | `browser-forward-button` | Navigates browser history forward. |

Notes:

- `browser-open-button` is not currently exposed because URL navigation is submitted by the existing address form via Enter; no dedicated visible open button exists.
- `browser-panel-close` depends on the surrounding scene/canvas tab chrome rather than the Browser component itself.

## Notifications

| Element name | data-testid | Notes |
|---|---|---|
| Notification button | `notification-button` | Opens or toggles the notification center. |
| Notification center dialog | `notification-center` | Notification center modal root. |
| Notification center close button | `notification-center-close-btn` | Closes the notification center. |
| Notification center active section | `notification-center-active-section` | Present only when active task notifications exist. |

## Flow Chat Header

| Element name | data-testid | Notes |
|---|---|---|
| Background subagents button | `flowchat-header-background-subagents` | Opens background subagent activity state. |
| Pull requests button | `flowchat-header-pull-requests` | Opens pull request related UI. |
| Turn list | `flowchat-header-turn-list` | Turn navigation list. |
| Previous turn button | `flowchat-header-turn-prev` | Moves to previous visible turn. |
| Next turn button | `flowchat-header-turn-next` | Moves to next visible turn. |

## Agents

| Element name | data-testid | Notes |
|---|---|---|
| Agent/Skill panel | `agent-skill-panel` | Agents scene root when the Agents discovery page is active. |
| Agent list | `agent-list` | Container for all agent zones and cards. |
| Agent list item | `agent-list-item` | Repeated card. Includes `data-agent-id`, `data-agent-name`, and `data-agent-kind`. |
| Agent list item title | `agent-list-item-title` | Agent card title. |
| Agent list item description | `agent-list-item-description` | Agent card description. |
| Agent list empty | `agent-list-empty` | Empty state for an agent list section. |
| Agent detail panel | `agent-detail-panel` | Agent detail modal root. |
| Agent detail title | `agent-detail-title` | Agent detail modal title. |
| Agent detail description | `agent-detail-description` | Agent detail description. |
| Agent detail tools section | `agent-detail-tools-section` | Agent capability/tools section. |
| Agent detail tool item | `agent-detail-tool-item` | Repeated enabled tool item. Includes `data-tool-name`. |
| Agent detail close | `agent-detail-close` | Modal close button. |
| Core anchor button | `agents-anchor-core` | Scrolls to core agents zone. |
| Custom agents anchor button | `agents-anchor-custom` | Scrolls to custom agents zone. |
| Agents search button | `agents-search-btn` | Search suffix button. |
| Core agents zone | `agents-core-zone` | Core agents section. |
| Custom agents zone | `agents-custom-zone` | Custom/subagent section. |
| Agent source filter | `agents-source-filter` | Repeated item. Pair with `data-agent-source`. |
| Agent kind filter | `agents-kind-filter` | Repeated item. Pair with `data-agent-kind`. |
| Create agent button | `agents-create-agent-btn` | Opens custom agent creation page. |
| BTW stop review button | `btw-session-panel-stop-review` | Stops review session from BTW panel. |
| BTW origin button | `btw-session-panel-origin-button` | Opens origin session from BTW panel. |

## Skills

| Element name | data-testid | Notes |
|---|---|---|
| Agent/Skill panel | `agent-skill-panel` | Skills scene root when the Skills discovery page is active. |
| Skill list | `skill-list` | Installed skill list grid by default. Also used for marketplace results. |
| Skill list item | `skill-list-item` | Repeated installed skill card. Includes `data-skill-id`, `data-skill-name`, `data-skill-key`, `data-skill-level`, and `data-skill-builtin`. |
| Skill list item title | `skill-list-item-title` | Skill card title. |
| Skill list item description | `skill-list-item-description` | Skill card description when present. |
| Skill list empty | `skill-list-empty` | Empty state for installed or marketplace skill list. |
| Skill detail panel | `skill-detail-panel` | Skill detail modal root. |
| Skill detail title | `skill-detail-title` | Skill detail modal title. |
| Skill detail description | `skill-detail-description` | Skill detail description. |
| Skill detail capabilities section | `skill-detail-capabilities-section` | Detail metadata/capability rows for installed or marketplace skill. |
| Skill detail close | `skill-detail-close` | Modal close button. |
| Skills tabs root | `skills-tabs` | Installed/discover tabs container. |
| Installed tab | `skills-tab-installed` | Includes `data-skills-tab-active`. |
| Discover tab | `skills-tab-discover` | Includes `data-skills-tab-active`. |
| Installed panel | `skills-installed-panel` | Installed skills view root. |
| Installed sidebar | `skills-installed-sidebar` | Installed category sidebar. |
| Installed category | `skills-installed-category` | Repeated item. Pair with `data-skill-category`. |
| Installed content | `skills-installed-content` | Main installed skills content. |
| Installed search | `skills-installed-search` | Installed skills search root. |
| Hide duplicates button | `skills-hide-duplicates-btn` | Includes `data-active`. |
| Add local skill button | `skills-add-local-btn` | Opens add skill form. |
| Installed loading state | `skills-installed-loading` | Loading skeleton container. |
| Installed error state | `skills-installed-error` | Error state container. |
| Installed empty state | `skills-installed-empty` | Empty state container. |
| Installed grid | `skills-installed-grid` | Installed skills card grid. |
| Installed skill card | `skills-installed-card` | Repeated item. Pair with `data-skill-key`, `data-skill-level`, and `data-skill-builtin`. |
| Installed card path button | `skills-installed-card-path` | Repeated item. Pair with `data-skill-key`. |
| Installed card delete button | `skills-installed-card-delete` | Repeated item. Pair with `data-skill-key`. |
| Installed pagination | `skills-installed-pagination` | Installed list pagination root. |
| Installed previous page | `skills-installed-page-prev` | Previous page button. |
| Installed next page | `skills-installed-page-next` | Next page button. |
| Discover panel | `skills-discover-panel` | Marketplace view root. |
| Discover search | `skills-discover-search` | Marketplace search root. |
| Discover content | `skills-discover-content` | Marketplace content area. |
| Discover loading state | `skills-discover-loading` | Initial loading skeleton container. |
| Discover page loading state | `skills-discover-page-loading` | Loading state for page changes. |
| Discover error state | `skills-discover-error` | Error state container. |
| Discover empty state | `skills-discover-empty` | Empty state container. |
| Discover grid | `skills-discover-grid` | Marketplace card grid. |
| Market skill card | `skills-market-card` | Repeated item. Pair with `data-skill-install-id` and `data-skill-installed`. |
| Skill card action | `skills-card-action` | Repeated card action. Pair with `data-skill-action`. |
| Discover pagination | `skills-discover-pagination` | Marketplace pagination root. |
| Discover previous page | `skills-discover-page-prev` | Previous page button. |
| Discover next page | `skills-discover-page-next` | Next page button. |
| Detail delete button | `skills-detail-delete-btn` | Deletes selected installed skill. |
| Detail installed button | `skills-detail-installed-btn` | Disabled installed marker for marketplace detail. |
| Detail project download button | `skills-detail-download-project-btn` | Downloads market skill to project scope. |
| Detail user download button | `skills-detail-download-user-btn` | Downloads market skill to user scope. |
| Detail path button | `skills-detail-path-btn` | Reveals installed skill path. |
| Detail external link | `skills-detail-external-link` | Opens marketplace link. |
| Add form | `skills-add-form` | Add local skill modal content. |
| Add path input | `skills-add-path-input` | Local skill path input. |
| Add browse button | `skills-add-browse-btn` | Opens path picker. |
| Add validation result | `skills-add-validation` | Includes `data-validation-valid`. |
| Add cancel button | `skills-add-cancel-btn` | Closes add form. |
| Add submit button | `skills-add-submit-btn` | Adds validated local skill. |
