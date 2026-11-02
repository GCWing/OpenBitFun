import SwiftUI

struct MobileDesignGallery: View {
    let scenario: MobilePreviewScenario
    @StateObject private var model: MobileAppModel

    init(scenario: MobilePreviewScenario) {
        self.scenario = scenario
        let session = ChatSession(id: UUID().uuidString, title: scenario.headerTitle, updatedLabel: "刚刚")
        let previewMessages = scenario.messages.map { message in
            ChatMessage(
                id: UUID(),
                role: message.role == "user" ? .user : .assistant,
                text: message.text
            )
        }
        let previewModel = MobileAppModel(
            sessions: [session],
            selectedSessionID: session.id,
            messages: previewMessages,
            connectCore: false
        )
        previewModel.coreAdapter = nil
        previewModel.surface = .remote
        previewModel.remoteConnected = true
        previewModel.remoteSessionSelected = true
        previewModel.remoteSessions = [session]
        previewModel.messages = previewMessages
        previewModel.timelineRows = previewMessages.map(MobileAppModel.simpleTimelineRow)
        previewModel.designGalleryPreview = true
        previewModel.draft = scenario.composerDraft
        previewModel.isSending = scenario.streaming
        _model = StateObject(wrappedValue: previewModel)
    }

    var body: some View {
        VStack(spacing: 0) {
            platformLabel
            ConversationHeader(
                model: model,
                actionsOpen: .constant(false),
                contextTitle: scenario.headerSubtitle,
                sidebarAction: {}
            )
            ChatTimelineView(model: model)
            ComposerBar(model: model)
        }
        .background(OpenBitFunTheme.page)
    }

    private var platformLabel: some View {
        HStack(spacing: 8) {
            Text(verbatim: "iOS")
                .font(MobileDesignTypography.labelMedium.font)
                .fontWeight(.medium)
            Text(verbatim: "NATIVE")
                .font(MobileDesignTypography.labelSmall.font)
                .foregroundStyle(OpenBitFunTheme.muted)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(OpenBitFunTheme.soft)
                .clipShape(Capsule())
            Spacer()
            Text(verbatim: "\(Int(scenario.viewportWidth)) × \(Int(scenario.viewportHeight))")
                .font(MobileDesignTypography.labelSmall.font)
                .foregroundStyle(OpenBitFunTheme.muted)
        }
        .frame(height: MobileDesignGeometry.connectionStripHeight)
        .padding(.horizontal, MobileDesignGeometry.contentGutter)
        .overlay(alignment: .bottom) {
            Rectangle().fill(OpenBitFunTheme.line).frame(height: 1)
        }
    }
}

#Preview("OpenBitFun Mobile · Compact") {
    MobileDesignGallery(scenario: MobilePreviewScenarios.connectedConversation)
        .preferredColorScheme(.light)
}

#Preview("OpenBitFun Mobile · Dark") {
    MobileDesignGallery(scenario: MobilePreviewScenarios.streamingDark)
        .preferredColorScheme(.dark)
}

#if DEBUG
/// Deterministic native rendering fixture. It never opens a remote transport.
struct StreamingRegressionView: View {
    @StateObject private var model = MobileAppModel(sessions: [], selectedSessionID: "fixture", messages: [], connectCore: false)
    @State private var generation = 0
    @State private var finished = false
    @State private var olderCount = 0
    @State private var historyCount = 40
    @State private var historyRequests = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Start stream") {
                    model.draft = ""
                    model.composerSendGeneration &+= 1
                    model.isSending = true
                    finished = false
                    generation += 1
                }.accessibilityIdentifier("fixture.send")
                Button("Reset session") {
                    generation = 0
                    model.selectedSessionID = UUID().uuidString
                    model.timelineRows = history
                    model.isSending = false
                }.accessibilityIdentifier("fixture.reset")
            }
            Button("Short history") {
                generation = 0
                historyCount = 6
                olderCount = 0
                model.timelineRows = history
                model.remoteHasMoreMessages = true
            }.accessibilityIdentifier("fixture.shortHistory")
            if ProcessInfo.processInfo.arguments.contains("--open-loading-regression") {
                HStack {
                    Button("Open delayed session") {
                        model.remoteExpectedDeviceKey = "account:fixture-device"
                        model.remoteInitialSessionReady = false
                        model.remoteInitialWorkspaceReady = false
                        model.selectDirectorySession(ChatSession(id: "delayed", title: "Delayed session",
                            updatedLabel: "", deviceKey: "fixture-device"))
                    }.accessibilityIdentifier("fixture.openDelayed")
                    Button("Bind target") {
                        model.apply(remoteTargetBound: "account:fixture-device", epoch: model.remoteTargetEpoch,
                            accountGeneration: model.accountGeneration)
                    }.accessibilityIdentifier("fixture.bindTarget")
                    Button("Finish loading") {
                        model.timelineRows = [row(id: "loaded", text: "LOADED-SESSION", live: false)]
                        model.finishRemoteConversationOpenIfReady(timelineSessionID: "delayed")
                    }.accessibilityIdentifier("fixture.finishLoading")
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--history-pagination-regression") {
                Text("History requests: \(historyRequests)").accessibilityIdentifier("fixture.historyRequests")
                Button("Deliver history") {
                    Task { @MainActor in
                        for _ in 0..<3 {
                            olderCount += 4
                            model.timelineRows = history
                            try? await Task.sleep(nanoseconds: 150_000_000)
                        }
                        model.remoteHistoryLoading = false
                    }
                }.accessibilityIdentifier("fixture.deliverHistory")
            }
            Text(finished ? "Stream finished" : "Stream fixture")
                .accessibilityIdentifier("fixture.status")
            if ProcessInfo.processInfo.arguments.contains("--fixture-shell") {
                MobileShellView(model: model)
            } else {
            ChatTimelineView(model: model, onLoadOlderMessages: {
                if ProcessInfo.processInfo.arguments.contains("--history-pagination-regression") {
                    historyRequests += 1
                    model.remoteHistoryLoading = true
                } else {
                    olderCount += 10
                    model.timelineRows = history
                    model.remoteHasMoreMessages = false
                }
            })
            ComposerBar(model: model)
            }
        }
        .onAppear {
            model.surface = .remote
            model.remoteSessionSelected = true
            model.remoteConnected = true
            model.connectionPhase = .connected
            if ProcessInfo.processInfo.arguments.contains("--status-regression") {
                model.remoteExpectedDeviceKey = "account:fixture-device"
                model.connectionPhase = .reconnecting
            }
            model.selectedSessionID = "fixture"
            model.timelineRows = ProcessInfo.processInfo.arguments.contains("--card-regression") ? [cardRow] : history
            if ProcessInfo.processInfo.arguments.contains("--message-metadata-regression") {
                let failed = MobileTimelineTool(id: "fetch", name: "WebFetch", phase: "FAILED", kind: "WEB",
                    operation: "FETCH_URL", target: "example.com", filePath: "", fileLabel: "",
                    input: "https://example.com", output: "HTTP 404", question: nil, questions: [], actions: [], foldIntoSummary: true)
                let completed = MobileTimelineTool(id: "read", name: "Read", phase: "COMPLETED", kind: "FILE",
                    operation: "READ_FILE", target: "README.md", filePath: "", fileLabel: "",
                    input: "README.md", output: "Document content", question: nil, questions: [], actions: [], foldIntoSummary: true)
                model.timelineRows = [
                    MobileConversationRow(id: "dated-user", kind: "USER", text: "Check the sources.", thinking: nil,
                        images: [], tools: [], blocks: [], streaming: false, typing: false, showRetry: false, error: nil,
                        timestamp: Date(timeIntervalSince1970: 1700000000)),
                    MobileConversationRow(id: "dated-assistant", kind: "ASSISTANT", text: "The remaining source confirms the result.", thinking: nil,
                        images: [], tools: [completed, failed], blocks: [], streaming: false, typing: false, showRetry: false, error: nil,
                        timestamp: Date(timeIntervalSince1970: 1700000010))
                ]
            }
        }
        .task(id: generation) {
            guard generation > 0 else { return }
            if ProcessInfo.processInfo.arguments.contains("--card-regression") {
                model.timelineRows = [cardRow]
                model.isSending = false
                return
            }
            if ProcessInfo.processInfo.arguments.contains("--user-bubble-regression") {
                func user(_ id: String) -> MobileConversationRow {
                    MobileConversationRow(id: id, kind: "USER", text: "SENT-USER-BUBBLE",
                        thinking: nil, images: [], tools: [], blocks: [], streaming: false,
                        typing: false, showRetry: false, error: nil)
                }
                model.timelineRows = history + [user("optimistic-user"), row(id: "live", text: "", live: true)]
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                model.timelineRows = history + [user("confirmed-user"), row(id: "live", text: "", live: true)]
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                model.timelineRows = history + [user("confirmed-user"), row(id: "live", text: "SHORT-REPLY", live: true)]
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                model.timelineRows = history + [user("confirmed-user"), row(id: "final", text: "SHORT-REPLY", live: false)]
                model.isSending = false
                finished = true
                return
            }
            if ProcessInfo.processInfo.arguments.contains("--thinking-regression") {
                var thought = ""
                for index in 1...12 {
                    thought += "Thinking segment \(index): checking chronology and viewport stability.\nCheck input.\nCheck output.\nCheck viewport.\nCheck ordering.\n\n"
                    model.timelineRows = history + [thinkingRow(thought: thought, answer: "", live: true)]
                    do { try await Task.sleep(nanoseconds: 350_000_000) } catch { return }
                }
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
                model.timelineRows = history + [thinkingRow(thought: thought, answer: "ANSWER-AFTER-THINKING", live: true)]
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                model.timelineRows = history + [thinkingRow(thought: thought, answer: "ANSWER-AFTER-THINKING", live: false)]
                model.isSending = false
                finished = true
                return
            }
            var body = ""
            for index in 1...30 {
                do { try await Task.sleep(nanoseconds: 350_000_000) } catch { return }
                body += "Paragraph \(index): Unicode 中文 👨‍👩‍👧‍👦. **Streaming text** with a [link](https://example.com).\n\n"
                if index % 5 == 0 {
                    body += "```swift\nlet value = \(index)\nprint(value)\n```\n\n| State | Value |\n| --- | --- |\n| Progress | \(index) |\n\n"
                }
                model.timelineRows = history + [row(id: "live", text: body, live: true)]
            }
            guard !Task.isCancelled else { return }
            model.timelineRows = history + [row(id: "final", text: body + "STREAM-END", live: false)]
            model.isSending = false
            finished = true
        }
    }

    private var cardRow: MobileConversationRow {
        func tool(_ id: String, phase: String = "COMPLETED") -> MobileTimelineTool {
            MobileTimelineTool(id: id, name: "Read", phase: phase, kind: "FILE", operation: "READ",
                target: id, filePath: "", fileLabel: "", input: "INPUT-\(id)", output: "OUTPUT-\(id)",
                question: nil, questions: [], actions: [], foldIntoSummary: phase == "COMPLETED" || phase == "FAILED")
        }
        if ProcessInfo.processInfo.arguments.contains("--subagent-detail-regression") {
            return MobileConversationRow(id: "subtask-details", kind: "ASSISTANT", text: "", thinking: nil,
                images: [], tools: [], blocks: [
                    .subagent(id: "details", title: "SUBTASK-DETAILS", running: generation == 0,
                        text: "PARENT-SUMMARY-MUST-NOT-REPEAT", children: [
                            .thinking(id: "child-old", text: "OLD-CHILD-THOUGHT", streaming: true),
                            .tools(id: "child-tools", tools: [tool("child-one"), tool("child-two")]),
                            .text(id: "child-output", text: "OUTPUT-PREVIEW " + String(repeating: "long output ", count: 80) + "HIDDEN-OUTPUT-TAIL", streaming: true),
                            .subagent(id: "nested", title: "NESTED-TASK", running: false, text: "NESTED-OUTPUT", children: []),
                            .thinking(id: "child-live", text: "LIVE-CHILD-THOUGHT", streaming: true)
                        ], status: generation == 0 ? "running" : "failed"),
                    .subagent(id: "empty", title: "EMPTY-TASK", running: false, text: "", children: [], status: "timeout")
                ], streaming: false, typing: false, showRetry: false, error: nil)
        }
        return MobileConversationRow(id: "cards", kind: "ASSISTANT", text: "", thinking: nil,
            images: [], tools: [], blocks: [
                .subagent(id: "task", title: "TASK-CARD", running: generation == 0,
                    text: "TASK-BODY", children: []),
                .thinking(id: "before", text: "REASON-BEFORE", streaming: false),
                .tools(id: "one", tools: [tool("one")]),
                .thinking(id: "between", text: "REASON-BETWEEN", streaming: false),
                .tools(id: "two", tools: generation > 1 ? [tool("two"), tool("three")] : [tool("two")]),
                .tools(id: "running", tools: [tool("running", phase: "RUNNING")]),
                .tools(id: "failed", tools: [tool("failed", phase: "FAILED")]),
                .text(id: "answer", text: "ANSWER-AFTER-ACTIVITY", streaming: false)
            ], streaming: false, typing: false, showRetry: false, error: nil)
    }

    private func thinkingRow(thought: String, answer: String, live: Bool) -> MobileConversationRow {
        var blocks: [MobileTimelineBlock] = [.thinking(id: "thought", text: thought, streaming: answer.isEmpty && live)]
        if !answer.isEmpty { blocks.append(.text(id: "answer", text: answer, streaming: live)) }
        return MobileConversationRow(id: live ? "thinking-live" : "thinking-final", kind: "ASSISTANT", text: answer,
            thinking: thought, images: [], tools: [], blocks: blocks, streaming: live, typing: false,
            showRetry: false, error: nil, live: live)
    }

    private var history: [MobileConversationRow] {
        (-olderCount..<historyCount).map { row(id: "history-\($0)", text: "History row \($0)\n\nStable transcript content." +
            (ProcessInfo.processInfo.arguments.contains("--user-bubble-regression") ? String(repeating: "\n\nEarlier long reply.", count: ($0 % 5 + 1) * 8) : ""), live: false) }
    }

    private func row(id: String, text: String, live: Bool) -> MobileConversationRow {
        MobileConversationRow(id: id, kind: "ASSISTANT", text: text, thinking: nil,
            images: [], tools: [], blocks: [], streaming: live, typing: false,
            showRetry: false, error: nil, live: live)
    }
}
#endif
