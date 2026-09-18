import Foundation

enum ConnectionPhase {
    case connected
    case reconnecting
    case disconnected
}

enum MobileSurface: String {
    case local
    case remote
}

struct ChatMessage: Identifiable, Equatable {
    let id: UUID
    let role: Role
    let text: String

    enum Role { case user, assistant }
}

struct MobileTimelineImage: Identifiable, Equatable {
    var id: String { dataURL }
    let name: String
    let dataURL: String
}

struct MobileTimelineOption: Identifiable, Equatable {
    let label: String
    let description: String?
    var id: String { label }
}

struct MobileTimelineQuestion: Identifiable, Equatable {
    let index: Int
    let header: String
    let question: String
    let options: [MobileTimelineOption]
    let multiSelect: Bool
    var id: Int { index }
}

struct MobileTimelineTool: Identifiable, Equatable {
    let id: String
    let name: String
    let phase: String
    let kind: String
    let operation: String
    let target: String
    let filePath: String
    let fileLabel: String
    let input: String
    let output: String
    let question: String?
    let questions: [MobileTimelineQuestion]
    let actions: Set<String>
    var foldIntoSummary: Bool = false
    var planPath: String? = nil
    var planName: String = ""
    var planOverview: String = ""
}

indirect enum MobileTimelineBlock: Identifiable, Equatable {
    case text(id: String, text: String, streaming: Bool)
    case thinking(id: String, text: String, streaming: Bool)
    case tools(id: String, tools: [MobileTimelineTool])
    case subagent(
        id: String,
        title: String,
        running: Bool,
        text: String,
        children: [MobileTimelineBlock],
        status: String = ""
    )

    var id: String {
        switch self {
        case let .text(id, _, _), let .thinking(id, _, _), let .tools(id, _),
             let .subagent(id, _, _, _, _, _):
            return id
        }
    }
}

// Subtask details have their own compact presentation, not a nested main transcript.
// Match Harmony SubagentTaskCard: only the last visible child can be thinking live.
struct MobileSubagentPresentation {
    static func failed(_ status: String) -> Bool {
        ["failed", "error", "timeout", "cancelled", "canceled", "rejected"].contains(status.lowercased())
    }

    static func blocks(_ children: [MobileTimelineBlock], running: Bool) -> [MobileTimelineBlock] {
        let visible = children.flatMap { block -> [MobileTimelineBlock] in
            switch block {
            case let .text(_, text, _), let .thinking(_, text, _):
                return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [block]
            case let .tools(_, tools):
                return tools.map { .tools(id: "subtask-tool-\($0.id)", tools: [$0]) }
            default: return [block]
            }
        }
        return visible.enumerated().map { index, block in
            if case let .thinking(id, text, _) = block {
                return .thinking(id: id, text: text, streaming: running && index == visible.count - 1)
            }
            return block
        }
    }

    static func preview(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count <= 320 ? text : String(text.prefix(320)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}

// Native rendering groups consume the shared core's foldability decision.
// Thinking stays at its transcript position inside a completed activity summary.
struct MobileProcessGroup: Identifiable {
    let id: String
    let blocks: [MobileTimelineBlock]
    var tools: [MobileTimelineTool] {
        blocks.flatMap { if case let .tools(_, tools) = $0 { return tools }; return [] }
    }
    var toolsOnly: Bool { !blocks.isEmpty && blocks.allSatisfy { if case .tools = $0 { return true }; return false } }
    var hasSummary: Bool { tools.count >= 2 && tools.allSatisfy(\.foldIntoSummary) }

    static func project(_ blocks: [MobileTimelineBlock]) -> [MobileProcessGroup] {
        var result: [MobileProcessGroup] = []
        var pending: [MobileTimelineBlock] = []
        var toolRun: [MobileTimelineTool] = []
        func flushTools() {
            if let first = toolRun.first {
                result.append(Self(id: "tool-\(first.id)", blocks: [.tools(id: "tool-\(first.id)", tools: toolRun)]))
            }
            toolRun.removeAll()
        }
        func flush() {
            guard let first = pending.first else { return }
            if pending.contains(where: { if case .thinking = $0 { return true }; return false }) {
                flushTools()
                result.append(Self(id: first.id, blocks: pending))
            } else {
                toolRun.append(contentsOf: pending.flatMap { if case let .tools(_, tools) = $0 { return tools }; return [] })
            }
            pending.removeAll()
        }
        for block in blocks {
            switch block {
            case let .thinking(id, text, streaming):
                // Adjacent reasoning fragments share one header, but never merge across a tool.
                if case let .thinking(previousID, previousText, previousStreaming)? = pending.last {
                    pending[pending.count - 1] = .thinking(id: previousID,
                        text: [previousText, text].filter { !$0.isEmpty }.joined(separator: "\n\n"),
                        streaming: previousStreaming || streaming)
                } else { pending.append(.thinking(id: id, text: text, streaming: streaming)) }
            case let .tools(_, tools):
                for tool in tools {
                    let leaf = MobileTimelineBlock.tools(id: "tool-\(tool.id)", tools: [tool])
                    if tool.foldIntoSummary { pending.append(leaf) }
                    else { flush(); toolRun.append(tool) }
                }
            default:
                flush()
                flushTools()
                result.append(Self(id: block.id, blocks: [block]))
            }
        }
        flush()
        flushTools()
        return result
    }
}

/// An immutable render snapshot. SwiftUI compares snapshot identity in O(1),
/// never recursively compares the transcript on focus/sheet/layout transactions.
/// Content reconciliation happens once at the incoming-data boundary.
final class MobileConversationRow: Identifiable, Equatable {
    let id: String
    let kind: String
    let text: String
    let thinking: String?
    let images: [MobileTimelineImage]
    let tools: [MobileTimelineTool]
    let blocks: [MobileTimelineBlock]
    let streaming: Bool
    let typing: Bool
    let pending: Bool
    let showRetry: Bool
    let error: String?
    let live: Bool

    init(id: String, kind: String, text: String, thinking: String?, images: [MobileTimelineImage],
         tools: [MobileTimelineTool], blocks: [MobileTimelineBlock], streaming: Bool, typing: Bool,
         pending: Bool, showRetry: Bool, error: String?, live: Bool = false) {
        self.id = nativeTimelineString(id)
        self.kind = nativeTimelineString(kind)
        self.text = nativeTimelineString(text)
        self.thinking = thinking.map(nativeTimelineString)
        self.images = images.map { MobileTimelineImage(name: nativeTimelineString($0.name), dataURL: nativeTimelineString($0.dataURL)) }
        self.tools = tools.map(nativeTimelineTool)
        self.blocks = blocks.map(nativeTimelineBlock)
        self.streaming = streaming
        self.typing = typing
        self.pending = pending
        self.showRetry = showRetry
        self.error = error.map(nativeTimelineString)
        self.live = live
    }

    static func == (lhs: MobileConversationRow, rhs: MobileConversationRow) -> Bool { lhs === rhs }

    private func matchesContent(of other: MobileConversationRow) -> Bool {
        if self === other { return true }
        return id == other.id && kind == other.kind && text == other.text && thinking == other.thinking &&
        images == other.images && tools == other.tools && blocks == other.blocks &&
        streaming == other.streaming && typing == other.typing && pending == other.pending &&
        showRetry == other.showRetry && error == other.error && live == other.live
    }

    static func reconcile(_ incoming: [MobileConversationRow], with current: [MobileConversationRow]) -> [MobileConversationRow] {
        var previous: [String: MobileConversationRow] = [:]
        for row in current { previous[row.id] = row }
        return incoming.map { row in
            guard let old = previous[row.id], old.matchesContent(of: row) else { return row }
            return old
        }
    }
}

// Kotlin strings arrive as NSString-backed Swift strings. Materialize native UTF-8
// once, so reconciliation cannot repeatedly enter foreign Unicode scalar access.
private func nativeTimelineString(_ value: String) -> String {
    var value = value
    value.makeContiguousUTF8()
    return value
}

private func nativeTimelineTool(_ tool: MobileTimelineTool) -> MobileTimelineTool {
    MobileTimelineTool(id: nativeTimelineString(tool.id), name: nativeTimelineString(tool.name),
        phase: nativeTimelineString(tool.phase), kind: nativeTimelineString(tool.kind),
        operation: nativeTimelineString(tool.operation), target: nativeTimelineString(tool.target),
        filePath: nativeTimelineString(tool.filePath), fileLabel: nativeTimelineString(tool.fileLabel),
        input: nativeTimelineString(tool.input), output: nativeTimelineString(tool.output),
        question: tool.question.map(nativeTimelineString), questions: tool.questions.map { question in
            MobileTimelineQuestion(index: question.index, header: nativeTimelineString(question.header),
                question: nativeTimelineString(question.question), options: question.options.map {
                    MobileTimelineOption(label: nativeTimelineString($0.label), description: $0.description.map(nativeTimelineString))
                }, multiSelect: question.multiSelect)
        }, actions: Set(tool.actions.map(nativeTimelineString)), foldIntoSummary: tool.foldIntoSummary,
        planPath: tool.planPath.map(nativeTimelineString), planName: nativeTimelineString(tool.planName),
        planOverview: nativeTimelineString(tool.planOverview))
}

private func nativeTimelineBlock(_ block: MobileTimelineBlock) -> MobileTimelineBlock {
    switch block {
    case let .text(id, text, streaming):
        return .text(id: nativeTimelineString(id), text: nativeTimelineString(text), streaming: streaming)
    case let .thinking(id, text, streaming):
        return .thinking(id: nativeTimelineString(id), text: nativeTimelineString(text), streaming: streaming)
    case let .tools(id, tools):
        return .tools(id: nativeTimelineString(id), tools: tools.map(nativeTimelineTool))
    case let .subagent(id, title, running, text, children, status):
        return .subagent(id: nativeTimelineString(id), title: nativeTimelineString(title), running: running,
            text: nativeTimelineString(text), children: children.map(nativeTimelineBlock), status: nativeTimelineString(status))
    }
}

enum MobileFilePreviewFailureKind: String {
    case notFound, unavailable, accessDenied, tooLarge, connection, loadFailed
}

struct MobileFilePreview: Identifiable, Equatable {
    let id: String
    let sessionID: String
    let controlTargetEpoch: Int32
    let name: String
    let content: String
    let mimeType: String
    let imageData: Data?
    let truncated: Bool
    let loadedBytes: Int64
    let sizeBytes: Int64
    let markdown: Bool
    let lineStart: Int32
    let lineEnd: Int32
    let failure: String?
    let failureKind: MobileFilePreviewFailureKind?
    let retryable: Bool
    let unsupported: Bool

    init(
        id: String,
        sessionID: String = "",
        controlTargetEpoch: Int32 = 0,
        name: String,
        content: String,
        mimeType: String,
        imageData: Data?,
        truncated: Bool,
        loadedBytes: Int64 = 0,
        sizeBytes: Int64 = 0,
        markdown: Bool = false,
        lineStart: Int32 = 0,
        lineEnd: Int32 = 0,
        failure: String?,
        failureKind: MobileFilePreviewFailureKind? = nil,
        retryable: Bool = false,
        unsupported: Bool = false
    ) {
        self.id = id
        self.sessionID = sessionID
        self.controlTargetEpoch = controlTargetEpoch
        self.name = name
        self.content = content
        self.mimeType = mimeType
        self.imageData = imageData
        self.truncated = truncated
        self.loadedBytes = loadedBytes
        self.sizeBytes = sizeBytes
        self.markdown = markdown
        self.lineStart = lineStart
        self.lineEnd = lineEnd
        self.failure = failure
        self.failureKind = failureKind
        self.retryable = retryable
        self.unsupported = unsupported
    }
}

struct MobilePendingDownload: Identifiable, Equatable {
    var id: String { reference }
    let reference: String
    let remotePath: String
    let name: String
    let mimeType: String
    let localURL: URL
    let sessionID: String
    let controlTargetEpoch: Int32

    init(reference: String, remotePath: String, name: String, mimeType: String, localURL: URL,
         sessionID: String = "", controlTargetEpoch: Int32 = 0) {
        self.reference = reference
        self.remotePath = remotePath
        self.name = name
        self.mimeType = mimeType
        self.localURL = localURL
        self.sessionID = sessionID
        self.controlTargetEpoch = controlTargetEpoch
    }
}

/// A workspace reference as the phone holds it: the stable `workspaceId` when the
/// host assigned one, otherwise the legacy `(connection, ssh host, path)` triple
/// from pre-ID hosts and caches. The path is display text and an IO operand only.
struct MobileWorkspaceScope: Equatable {
    let path: String
    let remoteConnectionId: String?
    let remoteSshHost: String?
    var workspaceId: String? = nil

    private var normalizedWorkspaceId: String? {
        let value = (workspaceId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    /// Stable key: `workspaceId ?: legacy triple`, matching `RemoteWorkspaceIdentity.key`.
    var key: String {
        if let id = normalizedWorkspaceId { return "workspace:\(id.utf8.count):\(id)" }
        return [remoteConnectionId ?? "", remoteSshHost ?? "", Self.normalizedPath(path)]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }

    /// ID-first equality: when both sides carry a workspace ID only the IDs are
    /// compared; when either side predates IDs the legacy triple decides.
    func refersTo(_ other: MobileWorkspaceScope) -> Bool {
        if let own = normalizedWorkspaceId, let theirs = other.normalizedWorkspaceId { return own == theirs }
        return Self.normalizedPath(path) == Self.normalizedPath(other.path) &&
            (remoteConnectionId ?? "") == (other.remoteConnectionId ?? "") &&
            (remoteSshHost ?? "") == (other.remoteSshHost ?? "")
    }

    static func normalizedPath(_ path: String) -> String {
        var value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.count > 1 && (value.hasSuffix("/") || value.hasSuffix("\\")) { value.removeLast() }
        return value
    }
}

struct ChatSession: Identifiable, Equatable {
    let id: String
    var title: String
    var updatedLabel: String
    var pinned: Bool = false
    var status: String = "active"
    var agentType: String = "general_chat"
    var workspacePath: String?
    var workspaceName: String?
    var workspaceScope: MobileWorkspaceScope? = nil
    var deviceKey: String? = nil
    var createdAt: String = ""
    var messageCount: Int = 0
}

struct CommittedRemoteCreate {
    let targetKey: String
    let epoch: UInt64
    let session: ChatSession
    /// First authoritative Ready revision guaranteed to contain this commit.
    let minimumAuthorityRevision: Int64
}

struct PendingDirectoryRemoteDraft {
    let targetKey: String
    let rawDeviceKey: String
    let workspacePath: String
    let normalizedWorkspacePath: String
    var remoteConnectionId: String? = nil
    var remoteSshHost: String? = nil
    var workspaceId: String? = nil
    var agentType: String = "code"
    let epoch: UInt64
    var selectionRequested: Bool

    var scope: MobileWorkspaceScope {
        MobileWorkspaceScope(path: workspacePath, remoteConnectionId: remoteConnectionId, remoteSshHost: remoteSshHost, workspaceId: workspaceId)
    }
}

struct MobileAccountDevice: Identifiable, Equatable {
    let id: String
    let name: String
    let online: Bool
    let selected: Bool
}

struct MobileDeviceDirectoryEntry: Identifiable, Equatable {
    let id: String
    let name: String
    let online: Bool
    let status: String
    let error: String?
    let workspaces: [MobileWorkspaceGroup]
    let sessions: [ChatSession]
    var catalogSource: String? = nil
    var recentWorkspaces: [MobileWorkspaceGroup]? = nil
}

struct MobileWorkspaceGroup: Identifiable, Equatable {
    var workspaceId: String? = nil
    var id: String { if let workspaceId { return [deviceKey ?? "", workspaceId].map { "\($0.utf8.count):\($0)" }.joined() }; return [deviceKey ?? "", remoteConnectionId ?? "", remoteSshHost ?? "", path].map { "\($0.utf8.count):\($0)" }.joined() }
    let path: String
    let name: String
    let selected: Bool
    let sessions: [ChatSession]
    var deviceKey: String? = nil
    var directoryExpanded = false
    var directoryStatus = "IDLE"
    var remoteConnectionId: String? = nil
    var remoteSshHost: String? = nil

    var scope: MobileWorkspaceScope {
        MobileWorkspaceScope(path: path, remoteConnectionId: remoteConnectionId, remoteSshHost: remoteSshHost, workspaceId: workspaceId)
    }

    /// ID-first identity comparison that ignores the device the row is filed under.
    func refersTo(_ other: MobileWorkspaceGroup) -> Bool { scope.refersTo(other.scope) }

    /// Device-independent key for per-workspace UI state (create menu anchors, expansion).
    var scopeKey: String { scope.key }
}

enum MobileSessionListSectionKind: Equatable {
    case chat
    case project
    case today
    case yesterday
    case earlier
}

struct MobileSessionListSectionProjection: Identifiable {
    let id: String
    let kind: MobileSessionListSectionKind
    let path: String
    let name: String
    let sessions: [ChatSession]
    /// Project sections only: the workspace the section stands for, ID-first.
    var workspaceScope: MobileWorkspaceScope? = nil
}

struct MobileSessionWorkspaceOption: Identifiable {
    /// `workspaceId ?: legacy triple`; two same-path workspaces are two options.
    var id: String { key }
    let path: String
    let name: String
    let workspaceId: String?
    let remoteConnectionId: String?
    let remoteSshHost: String?
    let key: String

    init(path: String, name: String, workspaceId: String? = nil, remoteConnectionId: String? = nil, remoteSshHost: String? = nil, key: String? = nil) {
        self.path = path
        self.name = name
        self.workspaceId = workspaceId
        self.remoteConnectionId = remoteConnectionId
        self.remoteSshHost = remoteSshHost
        self.key = key ?? MobileWorkspaceScope(path: path, remoteConnectionId: remoteConnectionId, remoteSshHost: remoteSshHost, workspaceId: workspaceId).key
    }
}

struct MobileAssistantOption: Identifiable, Equatable {
    /// The workspace ID when the host assigned one; the path only for pre-ID hosts.
    var id: String { workspaceId ?? path }
    let path: String
    let name: String
    var workspaceId: String? = nil
}

struct ComposerAttachment: Identifiable, Equatable {
    let id: String
    let data: Data
    let mimeType: String

    var dataURL: String {
        "data:\(mimeType);base64,\(data.base64EncodedString())"
    }
}

struct ComposerModelOption: Identifiable, Equatable {
    let id: String
    let primaryLabel: String
    let secondaryLabel: String
    let source: String
    let selected: Bool
}

enum MobileDownloadPhase {
    case idle
    case preparing
    case downloading
    case saving
    case saved
    case failed
}

struct PendingComposerSend {
    let sessionID: String
    let text: String
    let images: [ComposerAttachment]
    let previousAckID: String?
}
