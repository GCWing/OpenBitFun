import Foundation
import UIKit
import ImageIO
import OpenBitFunMobileCore

extension MobileAppModel {
    @discardableResult
    func send() -> Bool { sendRemote() }

    func select(_ session: ChatSession) {
        pendingDirectoryRemoteDraft = nil
        selectedSessionID = session.id
        guard remoteConversationOpeningSessionID != session.id else {
            drawerOpen = false
            return
        }
        remoteSessionSelected = true
        beginRemoteConversationOpen(sessionID: session.id)
        coreAdapter?.openRemoteSession(sessionID: session.id)
        drawerOpen = false
    }

    func addComposerImage(data: Data, mimeType: String) {
        guard composerImages.count < 4, data.count <= 10 * 1024 * 1024 else {
            showToast(localized("最多添加 4 张且每张不超过 10 MB 的图片"))
            return
        }
        composerImages.append(ComposerAttachment(id: UUID().uuidString, data: data, mimeType: mimeType))
    }

    nonisolated static func prepareComposerImage(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        var dimension = 1920
        while dimension >= 64 {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: dimension
            ]
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
            let image = UIImage(cgImage: cgImage)
            for quality in [0.85, 0.75, 0.65, 0.5] {
                if let encoded = image.jpegData(compressionQuality: quality), encoded.count <= 1024 * 1024 {
                    return encoded
                }
            }
            dimension = dimension * 3 / 4
        }
        return nil
    }

    func removeComposerImage(id: String) {
        composerImages.removeAll { $0.id == id }
    }

    func selectModel(_ modelID: String) {
        #if DEBUG
        if composerModelPickerPreview {
            modelOptions = modelOptions.map { option in
                ComposerModelOption(id: option.id, primaryLabel: option.primaryLabel,
                    secondaryLabel: option.secondaryLabel, source: option.source,
                    selected: option.id == modelID, role: option.role, roles: option.roles,
                    fallsBackToPrimary: option.fallsBackToPrimary)
            }
            return
        }
        #endif
        guard surface == .remote, remoteSessionSelected,
              let sessionID = RemoteAuthorityGate.sendSessionID(
                selectedSessionID: selectedSessionID, openedSessionID: remoteOpenedSessionID,
                connected: remoteConnected && connectionPhase == .connected,
                busy: busy, sending: isSending
              ) else { return }
        coreAdapter?.selectRemoteModel(sessionID: sessionID, modelID: modelID)
    }

    static func simpleTimelineRow(_ message: ChatMessage) -> MobileConversationRow {
        simpleTimelineRow(message, images: [])
    }

    static func simpleTimelineRow(
        _ message: ChatMessage,
        images: [ComposerAttachment]
    ) -> MobileConversationRow {
        MobileConversationRow(
            id: message.id.uuidString,
            kind: message.role == .user ? "USER" : "ASSISTANT",
            text: message.text,
            thinking: nil,
            images: images.map {
                MobileTimelineImage(name: "image", dataURL: $0.dataURL)
            },
            tools: [],
            blocks: [],
            streaming: false,
            typing: false,
            showRetry: false,
            error: nil
        )
    }

    static func mapConversationRow(_ row: ConversationRow) -> MobileConversationRow {
        MobileConversationRow(
            id: row.id,
            kind: row.kind.name,
            text: row.text,
            thinking: row.thinking,
            images: row.images.map {
                MobileTimelineImage(name: $0.name, dataURL: $0.dataUrl)
            },
            tools: row.tools.map(mapTool),
            blocks: row.blocks.map(mapBlock),
            streaming: row.streaming,
            typing: row.typing,
            showRetry: row.showRetry,
            error: row.error,
            live: row.live
        )
    }

    static func mapTool(_ tool: ToolCard) -> MobileTimelineTool {
        MobileTimelineTool(
            id: tool.id,
            name: tool.name,
            phase: tool.phase.name,
            kind: tool.kind.name,
            operation: tool.operation.name,
            target: tool.target,
            filePath: tool.filePath,
            fileLabel: tool.fileLabel,
            input: tool.input,
            output: tool.output,
            question: tool.question,
            questions: tool.questions.map { question in
                MobileTimelineQuestion(
                    index: Int(question.index),
                    header: question.header,
                    question: question.question,
                    options: question.options.map {
                        MobileTimelineOption(label: $0.label, description: $0.description_)
                    },
                    multiSelect: question.multiSelect
                )
            },
            actions: Set(tool.actions.map(\.name)),
            foldIntoSummary: tool.foldIntoSummary,
            planPath: tool.plan?.path, planName: tool.plan?.name ?? "", planOverview: tool.plan?.overview ?? ""
        )
    }

    static func mapBlock(_ block: MessageBlock) -> MobileTimelineBlock {
        if let text = block as? MessageBlockText {
            return .text(id: text.id, text: text.text, streaming: text.streaming)
        }
        if let thinking = block as? MessageBlockThinking {
            return .thinking(id: thinking.id, text: thinking.text, streaming: thinking.streaming)
        }
        if let tools = block as? MessageBlockTools {
            return .tools(id: tools.id, tools: tools.tools.map(mapTool))
        }
        if let subagent = block as? MessageBlockSubagent {
            return .subagent(
                id: subagent.id,
                title: subagent.title,
                running: subagent.running,
                text: subagent.text,
                children: subagent.children.map(mapBlock),
                status: subagent.status
            )
        }
        return .text(id: block.id, text: "", streaming: false)
    }
}
