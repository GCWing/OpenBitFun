import Foundation
import OpenBitFunMobileCore
import OSLog

@MainActor
enum MobileLaunchConfiguration {
    static var streamingRegressionPreview: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--streaming-regression")
        #else
        false
        #endif
    }

    static var pairingAccountPreview: Bool { ProcessInfo.processInfo.arguments.contains("--pairing-account") }
    static var pairingManualPreview: Bool { ProcessInfo.processInfo.arguments.contains("--pairing-manual") }
    static func makeModel() -> MobileAppModel {
        let first = ChatSession(id: UUID().uuidString, title: "你好", updatedLabel: "刚刚")
        let model = MobileAppModel(
            sessions: [first],
            selectedSessionID: first.id,
            messages: [
                ChatMessage(id: UUID(), role: .user, text: "你好"),
                ChatMessage(id: UUID(), role: .assistant, text: "这是 OpenBitFun 的移动端会话界面。你可以从手机连接桌面端，查看工作区、会话和智能体的执行状态。")
            ],
            connectCore: !streamingRegressionPreview && !ProcessInfo.processInfo.arguments.contains("--permission-mailbox-preview") && !ProcessInfo.processInfo.arguments.contains("--harness-preview") && designPreviewScenario() == nil
        )
        return configure(model)
    }

    private static func configure(_ model: MobileAppModel) -> MobileAppModel {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--english") {
            model.setLanguage(.english)
        } else if arguments.contains("--simplified-chinese") {
            model.setLanguage(.simplifiedChinese)
        }
        if arguments.contains("--remote") {
            model.surface = .remote
        }
        if arguments.contains("--harness-preview") {
            model.configureConnectedPreview()
            model.remoteHostCapabilities = ["harness_profiles_v1"]
        }
        #if DEBUG
        if arguments.contains("--permission-mailbox-preview") {
            model.configureTimelinePreview()
            model.permissionMailbox = PermissionMailboxUiState(requests: [
                PermissionMailboxRequest(requestId: "preview-write", action: "write", resources: ["/workspace/readme.md"], toolCallId: nil, source: "Write")
            ], busy: false, failed: false)
            Logger(subsystem: "com.openbitfun.mobile.ios", category: "permission-mailbox").info("Mailbox preview requests=\(model.permissionMailbox?.requests.count ?? -1)")
        }
        #endif
        if arguments.contains("--connected") {
            model.configureConnectedPreview()
        }
        if arguments.contains("--remote-chat-section") {
            if !model.remoteConnected { model.configureConnectedPreview() }
            model.remoteSessions.append(
                ChatSession(
                    id: "preview-remote-chat",
                    title: "移动端体验对齐",
                    updatedLabel: "刚刚",
                    status: "idle",
                    agentType: "Claw",
                    workspacePath: nil,
                    workspaceName: nil
                )
            )
            model.rebuildRemoteWorkspaceGroups()
        }
        if arguments.contains("--remote-view-settings") {
            if !model.remoteConnected { model.configureConnectedPreview() }
            model.remoteViewSettingsOpen = true
        }
        if arguments.contains("--remote-view-density") {
            if !model.remoteConnected { model.configureConnectedPreview() }
            let now = ISO8601DateFormatter().string(from: Date())
            for index in model.remoteSessions.indices {
                model.remoteSessions[index].updatedLabel = now
            }
            model.remoteGroupMode = "TIME"
            model.remoteShowWorkspaceMetadata = true
            model.remoteShowUpdatedMetadata = true
            model.remoteShowStatusMetadata = true
            model.rebuildRemoteWorkspaceGroups()
        }
        if arguments.contains("--timeline-preview") {
            model.configureTimelinePreview()
        }
        if arguments.contains("--plan-preview") {
            model.configureConnectedPreview()
            let plan = MobileTimelineTool(
                id: "preview-plan", name: "CreatePlan", phase: "COMPLETED", kind: "DOCUMENT",
                operation: "WRITE_FILE", target: "parity.plan.md", filePath: "/workspace/parity.plan.md",
                fileLabel: "parity.plan.md", input: "", output: "", question: nil, questions: [], actions: [],
                planPath: "/workspace/parity.plan.md", planName: "Mobile parity", planOverview: "Review the three native clients."
            )
            model.timelineRows = [MobileConversationRow(
                id: "preview-plan-row", kind: "ASSISTANT", text: "", thinking: nil, images: [], tools: [plan],
                blocks: [.tools(id: "preview-plan-tools", tools: [plan])], streaming: false, typing: false,
                pending: false, showRetry: false, error: nil
            )]
        }
        if arguments.contains("--file-preview") {
            model.filePreview = MobileFilePreview(
                id: "src/main.rs",
                name: "main.rs",
                content: "// Remote workspace preview\nfn main() {\n    println!(\"Hello from OpenBitFun\");\n}\n",
                mimeType: "text/x-rust",
                imageData: nil,
                truncated: false,
                lineStart: 2,
                lineEnd: 3,
                failure: nil
            )
        }
        if arguments.contains("--download-preview") {
            let previewURL = FileManager.default.temporaryDirectory.appendingPathComponent("openbitfun-download-preview.rs")
            try? Data("fn main() {}\n".utf8).write(to: previewURL)
            model.pendingDownload = MobilePendingDownload(
                reference: "computer://src/main.rs",
                remotePath: "src/main.rs",
                name: "main.rs",
                mimeType: "text/x-rust",
                localURL: previewURL
            )
            model.downloadTargetPath = "src/main.rs"
            model.downloadPhase = .saving
            model.downloadStatusText = model.localized("正在保存")
            model.downloadExporterOpen = true
        }
        if arguments.contains("--drawer") {
            model.drawerOpen = true
        }
        if arguments.contains("--settings") {
            model.settingsOpen = true
        }
        if arguments.contains("--remote-settings") {
            model.surface = .remote
            model.remoteControlSettingsOpen = true
        }
        if arguments.contains("--composer-model-picker") ||
            ProcessInfo.processInfo.environment["OPENBITFUN_COMPOSER_MODEL_PICKER"] == "1" {
            model.composerModelPickerPreview = true
            model.localSessionSelected = true
            model.draft = "\n"
            model.modelOptions = [
                ComposerModelOption(
                    id: "preview-codex",
                    primaryLabel: "GPT-5.6 Codex",
                    secondaryLabel: "OpenBitFun 账号",
                    source: "ACCOUNT",
                    selected: true
                ),
                ComposerModelOption(
                    id: "preview-local",
                    primaryLabel: "本机自定义模型",
                    secondaryLabel: "OpenAI 兼容服务",
                    source: "LOCAL",
                    selected: false
                ),
            ]
        }
        if arguments.contains("--pairing") || arguments.contains("--pairing-manual") ||
            arguments.contains("--pairing-account") {
            model.pairingSheetOpen = true
        }
        if arguments.contains("--remote-create") || arguments.contains("--remote-create-workspace-picker") ||
            arguments.contains("--remote-create-session-loading") {
            model.remoteCreatePreview = true
            if !model.remoteConnected { model.configureConnectedPreview() }
            if arguments.contains("--remote-create-session-loading") {
                // Reproduces the real-device race: workspace authority is ready
                // while the independent session directory still reports busy.
                model.busy = true
            }
            model.remoteCreateOpen = true
        }
        if arguments.contains("--remote-home-preview") {
            model.remoteSessionSelected = false
            model.selectedSessionID = ""
            model.timelineRows = []
            model.messages = []
        }
        if arguments.contains("--local-actions") {
            model.localActionPreview = true
            model.surface = .local
            model.localSessionSelected = true
            model.remoteSessionSelected = false
            if let localSession = model.sessions.first {
                model.selectedSessionID = localSession.id
            }
        }
        if arguments.contains("--account-login") {
            model.accountLoginPreview = true
            model.accountUser = nil
            model.accountDeviceName = nil
            model.accountSelectedDeviceID = nil
            model.accountDevices = []
            model.accountDeviceCount = 0
            model.coreErrorMessage = nil
            model.settingsOpen = false
            model.accountSheetOpen = true
        }
        if arguments.contains("--account-profile") {
            model.accountLoginPreview = true
            model.accountUser = "openbitfun-user"
            model.accountUserID = "user-preview-7A31"
            model.accountDevices = [
                MobileAccountDevice(
                    id: "desktop-preview",
                    name: "Studio Mac",
                    online: true,
                    selected: true
                ),
                MobileAccountDevice(
                    id: "desktop-offline-preview",
                    name: "Office PC",
                    online: false,
                    selected: false
                ),
            ]
            model.accountDeviceName = "Studio Mac"
            model.accountSelectedDeviceID = "desktop-preview"
            model.accountDeviceCount = model.accountDevices.count
            model.coreErrorMessage = nil
            model.settingsOpen = false
            model.accountSheetOpen = true
        }
        return model
    }

    static func designPreviewScenario() -> MobilePreviewScenario? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let marker = arguments.firstIndex(of: "--design-preview") else { return nil }
        let scenarioID = arguments.indices.contains(marker + 1) ? arguments[marker + 1] : "connected-conversation"
        switch scenarioID {
        case MobilePreviewScenarios.streamingDark.id:
            return MobilePreviewScenarios.streamingDark
        case MobilePreviewScenarios.narrowMultiline.id: return MobilePreviewScenarios.narrowMultiline
        case MobilePreviewScenarios.foldContext.id: return MobilePreviewScenarios.foldContext
        case MobilePreviewScenarios.longReading.id: return MobilePreviewScenarios.longReading
        case MobilePreviewScenarios.reconnectingWide.id:
            return MobilePreviewScenarios.reconnectingWide
        default:
            return MobilePreviewScenarios.connectedConversation
        }
    }
}

private extension MobileAppModel {
    func configureConnectedPreview() {
        accountUser = "preview"
        accountSelectedDeviceID = "preview-desktop"
        surface = .remote
        remoteConnected = true
        remoteExpectedDeviceKey = "account:preview-desktop"
        remoteInitialSessionReady = true
        remoteInitialWorkspaceReady = true
        remoteCreateWorkspacePhase = .ready
        workspaceLoading = false
        workspaceLoadFailed = false
        workspaceSelectionBusy = false
        connectionPhase = .connected
        remoteSessionSelected = true
        accountUser = "preview@openbitfun"
        accountDeviceName = "DESKTOP-KM3L4UI"
        accountSelectedDeviceID = "preview-desktop"
        directoryFixturePreview = true
        accountDevices = [
            MobileAccountDevice(id: "preview-desktop", name: "DESKTOP-KM3L4UI", online: true, selected: true),
            MobileAccountDevice(id: "preview-mac", name: "Studio Mac", online: true, selected: false),
            MobileAccountDevice(id: "preview-offline", name: "Office PC", online: false, selected: false)
        ]
        accountDeviceCount = accountDevices.count
        let session = ChatSession(
            id: UUID().uuidString,
            title: "你好",
            updatedLabel: "刚刚",
            agentType: "code",
            workspacePath: "/workspace/OpenBitFun",
            workspaceName: "OpenBitFun"
        )
        remoteSessions = [session]
        let extraSessions = (1...5).map { index in
            ChatSession(
                id: "preview-session-\(index)", title: "Review session \(index)", updatedLabel: "2026-01-01T00:00:00Z",
                status: index == 1 ? "running" : "idle", agentType: "code",
                workspacePath: "/workspace/OpenBitFun", workspaceName: "OpenBitFun", deviceKey: "preview-desktop"
            )
        }
        remoteSessions.append(contentsOf: extraSessions)
        let cachedSession = ChatSession(
            id: "preview-offline-session", title: "Cached offline session", updatedLabel: "2026-01-01T00:00:00Z",
            status: "idle", agentType: "code", workspacePath: "/office/project", workspaceName: "Office project", deviceKey: "preview-offline"
        )
        let failedSession = ChatSession(
            id: "preview-failed-session", title: "Cached failed session", updatedLabel: "2026-01-01T00:00:00Z",
            status: "idle", agentType: "code", workspacePath: "/staging/project", workspaceName: "Staging", deviceKey: "preview-mac"
        )
        remoteSessions.append(contentsOf: [cachedSession, failedSession])
        let previewWorkspace = MobileWorkspaceGroup(path: "/workspace/OpenBitFun", name: "OpenBitFun", selected: true, sessions: remoteSessions.filter { $0.deviceKey == "preview-desktop" }, deviceKey: "preview-desktop")
        let offlineWorkspace = MobileWorkspaceGroup(path: "/office/project", name: "Office project", selected: false, sessions: [cachedSession], deviceKey: "preview-offline")
        let failedWorkspace = MobileWorkspaceGroup(path: "/staging/project", name: "Staging", selected: false, sessions: [failedSession], deviceKey: "preview-mac")
        deviceDirectory = [
            MobileDeviceDirectoryEntry(id: "preview-desktop", name: "DESKTOP-KM3L4UI", online: true, status: "READY", error: nil, workspaces: [previewWorkspace], sessions: previewWorkspace.sessions),
            MobileDeviceDirectoryEntry(id: "preview-mac", name: "Studio Mac", online: true, status: "FAILED", error: "REMOTE_UNAVAILABLE", workspaces: [failedWorkspace], sessions: [failedSession]),
            MobileDeviceDirectoryEntry(id: "preview-offline", name: "Office PC", online: false, status: "READY", error: nil, workspaces: [offlineWorkspace], sessions: [cachedSession])
        ]
        workspaceCatalog = [(path: "/workspace/OpenBitFun", name: "OpenBitFun", selected: true, remoteConnectionId: nil, remoteSshHost: nil, workspaceId: nil)]
        remoteAssistants = [
            MobileAssistantOption(path: "/workspace/OpenBitFun/.openbitfun/assistants/review", name: "代码审查助手")
        ]
        remoteHasMore = true
        rebuildRemoteWorkspaceGroups()
        selectedSessionID = session.id
        messages = [
            ChatMessage(id: UUID(), role: .user, text: "你好"),
            ChatMessage(id: UUID(), role: .assistant, text: "这是 OpenBitFun 的远程会话预览。"),
        ]
        timelineRows = messages.map(Self.simpleTimelineRow)
    }

    func configureTimelinePreview() {
        configureConnectedPreview()
        let userID = UUID().uuidString
        let assistantID = UUID().uuidString
        let readOne = MobileTimelineTool(
            id: "preview-read-1", name: "Read", phase: "COMPLETED", kind: "DOCUMENT",
            operation: "READ_FILE", target: "main.rs", filePath: "computer://src/main.rs",
            fileLabel: "main.rs", input: "src/main.rs", output: "读取完成", question: nil, questions: [], actions: []
        )
        let readTwo = MobileTimelineTool(
            id: "preview-read-2", name: "Search", phase: "COMPLETED", kind: "SEARCH",
            operation: "SEARCH_CODE", target: "MobileShellView", filePath: "", fileLabel: "",
            input: "MobileShellView", output: "找到 4 处结果", question: nil, questions: [], actions: []
        )
        let approval = MobileTimelineTool(
            id: "preview-approval", name: "Bash", phase: "PENDING_CONFIRMATION", kind: "COMMAND",
            operation: "RUN_COMMAND", target: "pnpm test", filePath: "", fileLabel: "",
            input: "pnpm test", output: "", question: nil, questions: [], actions: ["APPROVE", "REJECT"]
        )
        let question = MobileTimelineTool(
            id: "preview-question", name: "AskUserQuestion", phase: "PENDING_CONFIRMATION", kind: "QUESTION",
            operation: "ASK_CONFIRMATION", target: "", filePath: "", fileLabel: "", input: "", output: "",
            question: "要同时运行远程场景回归吗？", questions: [], actions: ["ANSWER"]
        )
        timelineRows = [
            MobileConversationRow(
                id: userID, kind: "USER", text: "介绍本项目", thinking: nil,
                images: [], tools: [], blocks: [], streaming: false, typing: false, pending: false,
                showRetry: false, error: nil
            ),
            MobileConversationRow(
                id: assistantID, kind: "ASSISTANT", text: "", thinking: nil, images: [], tools: [],
                blocks: [
                    .thinking(id: "preview-thinking", text: "先对照 HarmonyOS 的消息顺序与工具状态，再核对 Android 的交互策略。", streaming: false),
                    .text(
                        id: "preview-text",
                        text: "## 检查结果\n\n消息按共享投影顺序显示，文件可直接打开：[main.rs](computer://src/main.rs)。\n\n- [x] Markdown 与代码块\n- [x] 思考过程与子任务\n- [ ] 完成真机回归\n\n| 平台 | 状态 |\n| :--- | ---: |\n| HarmonyOS | 已对照 |\n| iOS | 已对齐 |\n\n```swift\nlet parity = true\n```",
                        streaming: false
                    ),
                    .tools(id: "preview-tools", tools: [readOne, readTwo, approval, question]),
                ],
                streaming: false, typing: false, pending: false, showRetry: true,
                error: "桌面端进程意外退出。"
            ),
        ]
        messages = [
            ChatMessage(id: UUID(), role: .user, text: "介绍本项目"),
            ChatMessage(id: UUID(), role: .assistant, text: "检查结果"),
        ]
    }
}

private extension Array where Element == String {
    func value(after flag: String) -> String? {
        guard let position = firstIndex(of: flag), position < index(before: endIndex) else { return nil }
        return self[index(after: position)]
    }
}
