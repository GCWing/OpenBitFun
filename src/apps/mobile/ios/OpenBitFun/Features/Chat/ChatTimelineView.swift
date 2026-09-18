import Foundation
import OSLog
import OpenBitFunMobileCore
import SwiftUI
import UIKit

struct ChatTimelineView: View {
    @ObservedObject var model: MobileAppModel
    var onLoadOlderMessages: (() -> Void)? = nil
    /// Height of the floating bottom layer, so the jump-to-bottom button rides
    /// above the composer instead of hiding behind it. The transcript's own
    /// padding comes from `safeAreaInset`; an overlay does not get that, which
    /// is why this one number still has to be passed in.
    var bottomOverlayInset: CGFloat = 0
    @StateObject private var scrollController = TimelineScrollController()
    @State private var historyAnchor: (id: String, top: CGFloat, firstID: String)?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                VStack(spacing: MobileDesignGeometry.messageSpacing) {
                    // History is already paged by the session store. Measure the
                    // loaded page exactly: an estimated lazy history above a growing
                    // eager tail can repeatedly invalidate its own placement phases
                    // during keyboard dismissal and long streamed replies.
                    VStack(spacing: MobileDesignGeometry.messageSpacing) {
                        if model.surface == .remote && model.remoteHasMoreMessages {
                            Button {
                                #if DEBUG
                                Logger(subsystem: "com.openbitfun.mobile.ios", category: "timeline-scroll").info("History capture frames=\(scrollController.rowFrames.count)")
                                #endif
                                if let row = scrollController.rowFrames.filter({ $0.value.maxY > 0 })
                                    .min(by: { $0.value.minY < $1.value.minY })
                                {
                                    historyAnchor = (row.key, row.value.minY, model.timelineRows.first?.id ?? "")
                                    #if DEBUG
                                    Logger(subsystem: "com.openbitfun.mobile.ios", category: "timeline-scroll").info("History capture top=\(row.value.minY) height=\(row.value.height)")
                                    #endif
                                }
                                scrollController.stopFollowing()
                                if let onLoadOlderMessages {
                                    onLoadOlderMessages()
                                } else {
                                    model.loadOlderRemoteMessages()
                                }
                            } label: {
                                HStack(spacing: 7) {
                                    if model.remoteHistoryLoading { ProgressView().controlSize(.small) }
                                    Text(model.localized(model.remoteHistoryLoading ? "正在加载" : (model.remoteHistoryFailed ? "Could not load earlier messages. Tap to retry." : "加载更早消息")))
                                        .font(MobileDesignTypography.labelSmall.font)
                                }
                                .foregroundStyle(OpenBitFunTheme.muted)
                                .frame(maxWidth: .infinity, minHeight: 38)
                            }
                            .buttonStyle(.plain)
                            .disabled(model.busy || model.remoteHistoryLoading)
                            .accessibilityIdentifier("timeline.loadOlder")
                        }
                        ForEach(historyRows) { row in timelineRow(row) }
                    }
                    // Keep the user's message and its reply in the same measured
                    // tail, including acknowledgement and completion transitions.
                    ForEach(currentTurnItems) { item in
                        timelineRow(item.row, identity: item.id)
                    }
                    if model.timelineRows.isEmpty && model.isSending {
                        TypingIndicator().frame(maxWidth: .infinity, alignment: .leading)
                    }
                    OpenBitFunTheme.transparent.frame(height: 1).id("timeline-bottom")
                }
                .padding(.horizontal, MobileDesignGeometry.contentGutter)
                .padding(.top, MobileDesignGeometry.timelineTopPadding)
                .padding(.bottom, 14)
                .background(TimelineScrollProbe(controller: scrollController))
            }
            .coordinateSpace(name: "chat-timeline")
            .onPreferenceChange(TimelineRowFramesKey.self) { frames in
                scrollController.rowFrames = frames
                // Apply corrections from this measurement directly. Publishing
                // frames into State adds a second, potentially stale layout pass.
                guard let anchor = historyAnchor else { return }
                if scrollController.isUserScrolling {
                    historyAnchor = nil
                } else if historyRestoreRequest != nil, model.timelineRows.first?.id != anchor.firstID,
                    let frame = frames[anchor.id]
                {
                    // Preserve the actual visible row, including its partial offset,
                    // rather than guessing from a lazy stack's total height.
                    scrollController.preserveAnchor(displacement: frame.minY - anchor.top)
                }
            }
            .task(id: historyRestoreRequest) {
                #if DEBUG
                Logger(subsystem: "com.openbitfun.mobile.ios", category: "timeline-scroll").info("History task available=\(historyRestoreRequest != nil)")
                #endif
                guard let request = historyRestoreRequest else { return }
                await Task.yield()
                guard !Task.isCancelled, !scrollController.isUserScrolling,
                    historyRestoreRequest == request
                else { return }
                // Explicitly key restoration by both the captured anchor and the
                // new transcript. State used only inside callbacks may otherwise
                // arrive after the list's first layout notification.
                proxy.scrollTo(scrollTargetID(request.id), anchor: .top)
                await Task.yield()
                guard !Task.isCancelled, historyRestoreRequest == request else { return }
                if let frame = scrollController.rowFrames[request.id] {
                    scrollController.preserveAnchor(displacement: frame.minY - request.top)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .onAppear { scrollController.open(session: model.selectedSessionID) }
            .onChange(of: model.selectedSessionID) { session in
                historyAnchor = nil
                scrollController.open(session: session)
            }
            .onChange(of: model.composerSendGeneration) { _ in
                historyAnchor = nil
                scrollController.followBottom()
            }
            .overlay(alignment: .bottomTrailing) {
                if !scrollController.followsBottom {
                    Button {
                        historyAnchor = nil
                        scrollController.followBottom()
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(OpenBitFunTheme.ink)
                            .frame(width: 36, height: 36)
                            .background(OpenBitFunTheme.card)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(OpenBitFunTheme.line, lineWidth: 1))
                            .shadow(color: OpenBitFunTheme.shadowMedium, radius: 8, y: 3)
                    }
                    .buttonStyle(.plain)
                    .padding(18)
                    .padding(.bottom, bottomOverlayInset)
                    .accessibilityIdentifier("timeline.scrollToBottom")
                    .accessibilityLabel(Text(model.localized("滚动到底部")))
                }
            }
            .background(OpenBitFunTheme.page)
        }
    }

    private struct HistoryRestoreRequest: Equatable {
        let session: String
        let firstID: String
        let id: String
        let top: CGFloat
    }

    private var historyRestoreRequest: HistoryRestoreRequest? {
        guard let anchor = historyAnchor, let first = model.timelineRows.first?.id,
            first != anchor.firstID
        else { return nil }
        return HistoryRestoreRequest(
            session: model.selectedSessionID, firstID: first,
            id: anchor.id, top: anchor.top)
    }

    private var currentTurnStart: Int {
        if let userIndex = model.timelineRows.lastIndex(where: { $0.kind == "USER" }) {
            return userIndex
        }
        return model.timelineRows.last?.live == true
            ? max(0, model.timelineRows.count - 1) : model.timelineRows.count
    }

    private var currentTurnRows: ArraySlice<MobileConversationRow> {
        model.timelineRows.dropFirst(currentTurnStart)
    }

    private struct CurrentTurnItem: Identifiable {
        let id: String
        let row: MobileConversationRow
    }

    private var currentTurnItems: [CurrentTurnItem] {
        currentTurnRows.map { CurrentTurnItem(id: scrollTargetID($0.id), row: $0) }
    }

    private func scrollTargetID(_ rowID: String) -> String {
        // Acknowledgement replaces the transport ID, not the visible message.
        // Retain the current user leaf across that replacement; historical rows
        // and assistant blocks continue to use their transcript identities.
        if model.timelineRows.last(where: { $0.kind == "USER" })?.id == rowID {
            return "current-user:\(model.selectedSessionID)"
        }
        return rowID
    }

    private var historyRows: ArraySlice<MobileConversationRow> {
        model.timelineRows.prefix(currentTurnStart)
    }

    private func timelineRow(_ row: MobileConversationRow, identity: String? = nil) -> some View {
        ConversationRowView(row: row, model: model, language: model.appLanguage.rawValue)
            .equatable().id(identity ?? row.id)
            .environment(\.streamingRowIdentity, row.id)
            .background(TimelineRowProbe(controller: scrollController, rowID: row.id))
            .background {
                GeometryReader { geometry in
                    OpenBitFunTheme.transparent.preference(
                        key: TimelineRowFramesKey.self,
                        value: [row.id: geometry.frame(in: .named("chat-timeline"))])
                }
            }
    }
}

private struct TimelineRowFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

struct ConversationLoadingState: View {
    var body: some View {
        GeometryReader { proxy in
            let contentWidth = max(0, min(proxy.size.width - 44, 760))
            VStack(spacing: 18) {
                assistantSkeleton(width: contentWidth * 0.72, height: 78)
                userSkeleton(width: contentWidth * 0.46, height: 42)
                assistantSkeleton(width: contentWidth * 0.84, height: 112)
            }
            .frame(width: contentWidth)
            .padding(.top, 28)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(OpenBitFunTheme.page)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(MobileLocalization.text("正在加载")))
        .accessibilityIdentifier("conversation.loading")
    }

    private func assistantSkeleton(width: CGFloat, height: CGFloat) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                skeletonLine(fraction: 0.74)
                skeletonLine(fraction: 0.92)
                skeletonLine(fraction: 0.58)
            }
            .padding(14)
            .frame(width: width, height: height, alignment: .leading)
            .background(OpenBitFunTheme.soft)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    private func userSkeleton(width: CGFloat, height: CGFloat) -> some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            RoundedRectangle(cornerRadius: 10)
                .fill(OpenBitFunTheme.soft)
                .frame(width: width, height: height)
        }
        .frame(maxWidth: .infinity)
    }

    private func skeletonLine(fraction: CGFloat) -> some View {
        GeometryReader { proxy in
            RoundedRectangle(cornerRadius: 5)
                .fill(OpenBitFunTheme.line)
                .frame(width: proxy.size.width * fraction, height: 10)
        }
        .frame(height: 10)
    }
}

private struct ConversationRowView: View, Equatable {
    @State private var expandedToolID: String? = nil
    let row: MobileConversationRow
    let model: MobileAppModel
    let language: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.language == rhs.language && lhs.model === rhs.model
    }

    @ViewBuilder
    var body: some View {
        switch row.kind {
        case "EMPTY":
            EmptyConversationRow()
        case "USER":
            userRow
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("message.user.\(row.id)")
        default:
            assistantRow
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("message.assistant.\(row.id)")
        }
    }

    private var userRow: some View {
        VStack(alignment: .trailing, spacing: 6) {
            IntrinsicWidthCapLayout(maxWidth: MobileDesignGeometry.messageBubbleMaxWidth) {
                VStack(alignment: .leading, spacing: 8) {
                    if !row.images.isEmpty { TimelineImageGrid(images: row.images) }
                    if !row.text.isEmpty {
                        Text(row.text)
                            .font(MobileDesignTypography.bodyLarge.font)
                            .foregroundStyle(OpenBitFunTheme.ink)
                            .lineSpacing(MobileDesignTypography.bodyLarge.lineSpacing)
                            .padding(.vertical, MobileDesignTypography.bodyLarge.lineSpacing / 2)
                            .textSelection(.enabled)
                    }
                }
                .padding(.horizontal, MobileDesignGeometry.messageBubbleHorizontalPadding)
                .padding(.vertical, MobileDesignGeometry.messageBubbleVerticalPadding)
                .background(OpenBitFunTheme.soft)
                .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.messageBubbleRadius))
            }
            if row.pending {
                Text(model.localized("正在发送"))
                    .font(MobileDesignTypography.labelSmall.font)
                    .foregroundStyle(OpenBitFunTheme.muted)
            }
            if row.showRetry {
                Button { model.retryMessage(row.text, images: row.images) } label: {
                    Label(model.localized("重新发送"), systemImage: "arrow.clockwise")
                        .font(MobileDesignTypography.labelSmall.font)
                        .foregroundStyle(OpenBitFunTheme.statusDanger)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.vertical, 2)
    }

    private var assistantRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            if row.typing {
                TypingIndicator()
            } else if !row.blocks.isEmpty {
                MessageBlockList(blocks: row.blocks, model: model)
            } else {
                if let thinking = row.thinking, !thinking.isEmpty {
                    ThinkingBlock(text: thinking, streaming: row.streaming && row.text.isEmpty && row.tools.isEmpty)
                }
                if !row.text.isEmpty { StreamingMarkdownMessageView(text: row.text, active: row.streaming, model: model) }
                if !row.tools.isEmpty { ToolStatusList(tools: row.tools, model: model, expandedToolID: $expandedToolID) }
            }
            if !row.images.isEmpty { TimelineImageGrid(images: row.images) }
            if let error = row.error, !error.isEmpty {
                assistantFailure(error)
            } else if row.showRetry {
                Button { model.retryMessage(row.text, images: row.images) } label: {
                    Label(model.localized("重试"), systemImage: "arrow.clockwise")
                        .font(MobileDesignTypography.labelSmall.font)
                        .foregroundStyle(OpenBitFunTheme.statusDanger)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func assistantFailure(_ error: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.localized("本次回复失败"))
                .font(MobileDesignTypography.labelSmall.font.weight(.medium))
                .foregroundStyle(OpenBitFunTheme.statusDanger)
            Text(error)
                .font(MobileDesignTypography.bodySmall.font)
                .foregroundStyle(OpenBitFunTheme.ink)
                .lineSpacing(MobileDesignTypography.bodySmall.lineSpacing)
                .textSelection(.enabled)
            if row.showRetry {
                Button(model.localized("重试")) { model.retryMessage(row.text, images: row.images) }
                    .font(MobileDesignTypography.bodySmall.font.weight(.medium))
                    .foregroundStyle(MobileDesignColors.fileLink)
                    .buttonStyle(.plain)
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
            Rectangle().fill(OpenBitFunTheme.statusDanger).frame(width: 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct IntrinsicWidthCapLayout: Layout {
    let maxWidth: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache _: inout ()
    ) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let availableWidth = min(proposal.width ?? maxWidth, maxWidth)
        let size = subview.sizeThatFits(
            ProposedViewSize(width: availableWidth, height: proposal.height)
        )
        return CGSize(width: min(size.width, availableWidth), height: size.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal _: ProposedViewSize,
        subviews: Subviews,
        cache _: inout ()
    ) {
        guard let subview = subviews.first else { return }
        subview.place(
            at: bounds.origin,
            anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}

private struct EmptyConversationRow: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "sparkles").font(.system(size: 23, weight: .medium))
            Text(MobileLocalization.text("从这里开始新的对话"))
                .font(MobileDesignTypography.bodyLarge.font)
        }
        .foregroundStyle(OpenBitFunTheme.muted)
        .frame(maxWidth: .infinity, minHeight: 180)
    }
}

private struct MessageBlockList: View {
    let blocks: [MobileTimelineBlock]
    let model: MobileAppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(MobileProcessGroup.project(blocks)) { group in
                ProcessGroupView(group: group, model: model)
            }
        }
    }
}

private struct ProcessGroupView: View {
    let group: MobileProcessGroup
    let model: MobileAppModel
    @State private var expandedToolID: String? = nil
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if group.toolsOnly {
                ToolStatusList(tools: group.tools, model: model, expandedToolID: $expandedToolID)
            } else {
                if group.hasSummary {
                    ToolSummaryButton(tools: group.tools, model: model, expanded: $expanded)
                }
                if !group.hasSummary || expanded {
                    ForEach(group.blocks) { block in
                        switch block {
                        case let .text(id, text, streaming):
                            if !text.isEmpty { StreamingMarkdownMessageView(text: text, active: streaming, model: model, partID: id) }
                        case let .thinking(id, text, streaming):
                            ThinkingBlock(text: text, streaming: streaming, partID: id)
                        case let .tools(_, tools):
                            ToolStatusList(tools: tools, model: model, expandedToolID: $expandedToolID)
                        case let .subagent(id, title, running, text, children, status):
                            SubagentBlock(id: id, title: title, running: running, text: text, children: children, model: model, status: status)
                        }
                    }
                }
            }
        }
    }
}

private struct SubagentBlock: View {
    let id: String
    let title: String
    let running: Bool
    let text: String
    let children: [MobileTimelineBlock]
    let model: MobileAppModel
    var status: String = ""
    @State private var expanded = false
    private var failed: Bool { MobileSubagentPresentation.failed(status) }
    private var processBlocks: [MobileTimelineBlock] { MobileSubagentPresentation.blocks(children, running: running) }
    private var hasDetails: Bool { !processBlocks.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: "person.2.fill").font(.system(size: 12, weight: .medium))
                    Text(title.isEmpty ? model.localized("子任务") : title)
                        .font(MobileDesignTypography.labelMedium.font).lineLimit(1)
                    Spacer()
                    if running { ProgressView().controlSize(.mini) }
                    Text(model.localized(running ? "运行中" : (failed ? "失败" : "已完成")))
                        .font(MobileDesignTypography.labelSmall.font)
                    if hasDetails {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(MobileDesignTypography.labelSmall.font)
                    }
                }
                .foregroundStyle(failed ? OpenBitFunTheme.statusDanger : OpenBitFunTheme.muted)
                .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("subagent.toggle.\(id)")
            .disabled(!hasDetails)
            if expanded && hasDetails {
                // The parent content is often the Task summary, not another output.
                // Keep it only as a fallback for older hosts without child items.
                let blocks = processBlocks
                if blocks.isEmpty && !text.isEmpty { outputPreview(text, key: id) }
                ForEach(blocks) { block in
                    switch block {
                    case let .text(key, value, _):
                        outputPreview(value, key: key)
                    case let .thinking(key, value, streaming):
                        ThinkingBlock(text: value, streaming: streaming, partID: key)
                    case let .tools(_, tools):
                        SubagentToolRow(tools: tools, model: model)
                    case let .subagent(key, title, live, value, nested, status):
                        SubagentBlock(id: key, title: title, running: live,
                            text: value, children: nested, model: model, status: status)
                    }
                }
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) { Rectangle().fill(OpenBitFunTheme.line).frame(width: 2) }
    }

    private func outputPreview(_ raw: String, key: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(model.localized("子任务输出"))
                .font(MobileDesignTypography.labelSmall.font)
                .foregroundStyle(OpenBitFunTheme.muted)
            Text(MobileSubagentPresentation.preview(raw))
                .font(MobileDesignTypography.bodySmall.font)
                .lineSpacing(MobileDesignTypography.bodySmall.lineSpacing)
                .lineLimit(4)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("subagent.output.\(key)")
        }
    }
}

private struct SubagentToolRow: View {
    let tools: [MobileTimelineTool]
    let model: MobileAppModel
    @State private var expandedToolID: String?

    var body: some View {
        ToolStatusList(tools: tools, model: model, expandedToolID: $expandedToolID)
    }
}

private struct ThinkingBlock: View {
    let text: String
    let streaming: Bool
    let partID: String
    @Environment(\.streamingRowIdentity) private var rowID
    @State private var expanded: Bool

    init(text: String, streaming: Bool, partID: String = "thinking") {
        self.text = text
        self.streaming = streaming
        self.partID = partID
        _expanded = State(initialValue: streaming)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button { withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    if streaming { ProgressView().controlSize(.mini) }
                    Image(systemName: "sparkles").font(.system(size: 12, weight: .medium))
                    Text(MobileLocalization.text(streaming ? "正在思考" : "思考过程"))
                        .font(MobileDesignTypography.labelMedium.font)
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(MobileDesignTypography.labelSmall.font)
                }
                .foregroundStyle(OpenBitFunTheme.muted)
                .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("thinking.toggle.\(partID)")
            if expanded {
                Text(text)
                    .font(MobileDesignTypography.bodyLarge.font)
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .lineSpacing(MobileDesignTypography.bodyLarge.lineSpacing)
                    .textSelection(.enabled)
            }
        }
        // Match Harmony: preserve manual toggles during one thinking phase,
        // then fold when later output starts and expand for a new phase.
        .onChange(of: streaming) { running in expanded = running }
        .background {
            #if DEBUG
            ThinkingLayoutProbe(rowID: rowID, partID: partID, characters: text.count,
                                streaming: streaming, expanded: expanded)
            #endif
        }
    }
}

private struct TypingIndicator: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.35)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate / 0.35) % 3
            HStack(spacing: 5) {
                ForEach(0..<3) { index in
                    Circle().fill(OpenBitFunTheme.muted).frame(width: 5, height: 5)
                        .opacity(index == phase ? 1 : 0.32)
                }
            }
            .frame(height: 32)
        }
        .accessibilityLabel(Text(MobileLocalization.text("正在回复")))
    }
}

private struct StreamingRowIdentityKey: EnvironmentKey {
    static let defaultValue = ""
}

private extension EnvironmentValues {
    var streamingRowIdentity: String {
        get { self[StreamingRowIdentityKey.self] }
        set { self[StreamingRowIdentityKey.self] = newValue }
    }
}

private struct StreamingMarkdownMessageView: View {
    let text: String
    let active: Bool
    let model: MobileAppModel
    var partID = "body"
    @Environment(\.streamingRowIdentity) private var rowID

    var body: some View {
        let key = "\(model.remoteTargetEpoch)|\(model.selectedSessionID)|\(rowID)|\(partID)"
        StreamingMarkdownRevealView(text: text, active: active, model: model, key: key)
            .id(key)
    }
}

private struct StreamingMarkdownRevealView: View {
    let text: String
    let active: Bool
    let model: MobileAppModel
    let key: String
    @State private var reveal: StreamingTextState

    init(text: String, active: Bool, model: MobileAppModel, key: String) {
        self.text = text
        self.active = active
        self.model = model
        self.key = key
        var state = StreamingTextState(text: active ? StreamingRevealCache.shared.text(for: key) : text)
        state.update(text, active: active)
        _reveal = State(initialValue: state)
    }

    var body: some View {
        MarkdownMessageView(text: reveal.visible, model: model)
            .onChange(of: text) { value in reveal.update(value, active: active) }
            .onChange(of: active) { value in reveal.update(text, active: value) }
            .onChange(of: reveal.visible) { value in StreamingRevealCache.shared.save(value, for: key) }
            .onDisappear { StreamingRevealCache.shared.save(reveal.visible, for: key) }
            .task(id: active && reveal.ticksRemaining > 0) {
                guard active && reveal.ticksRemaining > 0 else { return }
                while !Task.isCancelled && reveal.ticksRemaining > 0 {
                    do { try await Task.sleep(nanoseconds: 40_000_000) }
                    catch { return }
                    reveal.advance()
                }
            }
    }
}

struct MarkdownMessageView: View {
    let text: String
    let model: MobileAppModel

    var body: some View {
        let projection = MarkdownProjectionCache.shared.projection(for: text)
        VStack(alignment: .leading, spacing: 9) {
            ForEach(projection.blocks, id: \.id) { MarkdownBlockView(block: $0) }
            ForEach(projection.references, id: \.id) { FileReferenceCard(reference: $0, model: model) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == nil || ["computer", "file", "openbitfun"].contains(url.scheme?.lowercased() ?? "") {
                model.openRemoteFile(reference: url.absoluteString, label: url.lastPathComponent)
                return .handled
            }
            return .systemAction
        })
    }
}

@MainActor
private final class MarkdownProjectionCache {
    struct Projection {
        let blocks: [MarkdownBlock]
        let references: [MessageFileReference]
    }

    private final class Entry: NSObject {
        let projection: Projection

        init(_ projection: Projection) {
            self.projection = projection
        }
    }

    static let shared = MarkdownProjectionCache()
    private let entries = NSCache<NSString, Entry>()

    private init() {
        entries.countLimit = 48
        entries.totalCostLimit = 4 * 1_024 * 1_024
    }

    func projection(for text: String) -> Projection {
        let key = text as NSString
        if let cached = entries.object(forKey: key) {
            return cached.projection
        }
        let projection = Projection(
            blocks: MarkdownParser.shared.parse(text: text),
            references: MessageFileReferenceProjector.shared.project(source: text)
        )
        entries.setObject(Entry(projection), forKey: key, cost: text.utf8.count)
        return projection
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block.type {
        case "heading":
            Text(inlineString(block.inlines))
                .font(headingFont)
                .foregroundStyle(OpenBitFunTheme.ink).textSelection(.enabled)
        case "quote":
            Text(inlineString(block.inlines))
                .font(MobileDesignTypography.bodyLarge.font).foregroundStyle(OpenBitFunTheme.muted)
                .lineSpacing(MobileDesignTypography.bodyLarge.lineSpacing).padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(OpenBitFunTheme.line).frame(width: 2) }
                .textSelection(.enabled)
        case "list":
            let markerWidth = listMarkerWidth
            VStack(alignment: .leading, spacing: 5) {
                ForEach(block.items, id: \.id) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        if let checked = taskListState(item.text) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 4)
                                    .stroke(OpenBitFunTheme.line, lineWidth: 1)
                                if checked {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundStyle(OpenBitFunTheme.muted)
                                }
                            }
                            .frame(width: 16, height: 16)
                            .padding(.horizontal, 2)
                        } else {
                            Text(item.marker).foregroundStyle(OpenBitFunTheme.muted)
                                .fixedSize(horizontal: true, vertical: false)
                                .frame(width: markerWidth, alignment: .trailing)
                        }
                        Text(listItemInlineString(item)).foregroundStyle(OpenBitFunTheme.ink)
                            .lineSpacing(MobileDesignTypography.bodyLarge.lineSpacing)
                            .textSelection(.enabled)
                    }
                    .font(MobileDesignTypography.bodyLarge.font)
                }
            }
        case "code": CodeBlock(language: block.language, code: block.text)
        case "table": MarkdownTableView(source: block.text)
        case "divider": Rectangle().fill(OpenBitFunTheme.line).frame(height: 1).padding(.vertical, 3)
        default:
            Text(inlineString(block.inlines))
                .font(MobileDesignTypography.bodyLarge.font).foregroundStyle(OpenBitFunTheme.ink)
                .lineSpacing(MobileDesignTypography.bodyLarge.lineSpacing).textSelection(.enabled)
        }
    }

    private var headingFont: Font {
        switch block.level {
        case 1: MobileDesignTypography.headlineSmall.font
        case 2: MobileDesignTypography.titleMedium.font.bold()
        default: MobileDesignTypography.bodyLarge.font.bold()
        }
    }

    private func inlineString(_ inlines: [MarkdownInline]) -> AttributedString {
        markdownInlineString(inlines, fallback: block.text)
    }

    private func taskListState(_ text: String) -> Bool? {
        let prefix = text.prefix(3).lowercased()
        if prefix == "[x]" { return true }
        if prefix == "[ ]" { return false }
        return nil
    }

    private var listMarkerWidth: CGFloat {
        let token = MobileDesignTypography.bodyLarge
        let font = UIFontMetrics(forTextStyle: token.textStyle).scaledFont(
            for: UIFont.systemFont(ofSize: token.size, weight: token.weight)
        )
        return block.items.reduce(CGFloat(20)) { width, item in
            max(width, ceil((item.marker as NSString).size(withAttributes: [.font: font]).width))
        }
    }

    private func listItemInlineString(_ item: MarkdownListItem) -> AttributedString {
        guard taskListState(item.text) != nil else {
            return markdownInlineString(item.inlines, fallback: item.text)
        }
        let text = String(item.text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        return markdownInlineString(
            MarkdownParser.shared.parseInlineText(value: text),
            fallback: text
        )
    }
}

private struct MarkdownTableView: View {
    let source: String

    private var table: MarkdownTableData { MarkdownTableData(source: source) }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            tableGrid(flexibleColumns: true)
            ScrollView(.horizontal, showsIndicators: false) {
                tableGrid(flexibleColumns: false)
            }
        }
        .background(OpenBitFunTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(OpenBitFunTheme.line, lineWidth: 1))
    }

    private func tableGrid(flexibleColumns: Bool) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                GridRow(alignment: .top) {
                    ForEach(Array(row.cells.enumerated()), id: \.offset) { columnIndex, cell in
                        Text(markdownInlineString(
                            MarkdownParser.shared.parseInlineText(value: cell.text),
                            fallback: cell.text
                        ))
                        .font(MobileDesignTypography.bodySmall.font)
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .multilineTextAlignment(cell.textAlignment)
                        .textSelection(.enabled)
                        .frame(
                            minWidth: 132,
                            maxWidth: flexibleColumns ? .infinity : 180,
                            minHeight: 42,
                            alignment: cell.frameAlignment
                        )
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(rowIndex == 0 || rowIndex.isMultiple(of: 2)
                            ? OpenBitFunTheme.soft
                            : OpenBitFunTheme.card)
                        .overlay(alignment: .trailing) {
                            if columnIndex < row.cells.count - 1 {
                                Rectangle().fill(OpenBitFunTheme.line).frame(width: 1)
                            }
                        }
                    }
                }
                .overlay(alignment: .bottom) {
                    if rowIndex < table.rows.count - 1 {
                        Rectangle().fill(OpenBitFunTheme.line).frame(height: 1)
                    }
                }
            }
        }
        .frame(maxWidth: flexibleColumns ? .infinity : nil)
    }
}

private struct MarkdownTableData {
    struct Row { let cells: [Cell] }
    struct Cell {
        let text: String
        let alignment: Alignment

        var textAlignment: TextAlignment {
            if alignment == .center { return .center }
            if alignment == .trailing { return .trailing }
            return .leading
        }

        var frameAlignment: Alignment { alignment }
    }

    let rows: [Row]

    init(source: String) {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard lines.count >= 2 else {
            rows = [Row(cells: [Cell(text: source, alignment: .leading)])]
            return
        }
        let header = Self.splitRow(lines[0])
        let separators = Self.splitRow(lines[1])
        let alignments = separators.map(Self.alignment)
        let values = [header] + lines.dropFirst(2).map(Self.splitRow)
        let columnCount = max(header.count, alignments.count)
        rows = values.map { row in
            Row(cells: (0..<columnCount).map { index in
                Cell(
                    text: index < row.count ? row[index] : "",
                    alignment: index < alignments.count ? alignments[index] : .leading
                )
            })
        }
    }

    private static func splitRow(_ line: String) -> [String] {
        var source = line.trimmingCharacters(in: .whitespaces)
        if source.first == "|" { source.removeFirst() }
        if source.last == "|" { source.removeLast() }
        var cells: [String] = []
        var current = ""
        var inCode = false
        var escaped = false
        for character in source {
            if escaped {
                current.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "`" {
                inCode.toggle()
                current.append(character)
            } else if character == "|" && !inCode {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func alignment(_ separator: String) -> Alignment {
        let value = separator.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix(":") && value.hasSuffix(":") { return .center }
        if value.hasSuffix(":") { return .trailing }
        return .leading
    }
}

private func markdownInlineString(
    _ inlines: [MarkdownInline],
    fallback: String
) -> AttributedString {
    var result = AttributedString()
    for inline in inlines {
        var part = AttributedString(inline.text)
        switch inline.type {
        case "strong": part.font = .system(size: 14, weight: .semibold)
        case "emphasis": part.font = .system(size: 14).italic()
        case "code":
            part.font = .system(size: 13, design: .monospaced)
            part.backgroundColor = OpenBitFunTheme.soft
        case "link":
            part.foregroundColor = MobileDesignColors.fileLink
            part.underlineStyle = .single
            part.link = URL(string: inline.url)
        default: break
        }
        result.append(part)
    }
    return result.characters.isEmpty ? AttributedString(fallback) : result
}

private struct CodeBlock: View {
    let language: String
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? MobileLocalization.text("代码") : language)
                    .font(MobileDesignTypography.labelSmall.font).foregroundStyle(OpenBitFunTheme.muted)
                Spacer()
                Button { UIPasteboard.general.string = code } label: {
                    Label(MobileLocalization.text("复制"), systemImage: "doc.on.doc")
                        .font(MobileDesignTypography.labelSmall.font).foregroundStyle(OpenBitFunTheme.muted)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12).frame(height: 34)
            Rectangle().fill(OpenBitFunTheme.line).frame(height: 1)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(OpenBitFunTheme.ink).padding(12).textSelection(.enabled)
            }
        }
        .background(OpenBitFunTheme.soft).clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(OpenBitFunTheme.line, lineWidth: 1))
    }
}

private struct FileReferenceCard: View {
    let reference: MessageFileReference
    @ObservedObject var model: MobileAppModel

    var body: some View {
        HStack(spacing: 10) {
            Button { model.openRemoteFile(reference: reference.reference, label: reference.label) } label: {
                HStack(spacing: 10) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 16, weight: .medium)).foregroundStyle(MobileDesignColors.fileLink)
                        .frame(width: 34, height: 34).background(MobileDesignColors.fileLink.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reference.label).font(MobileDesignTypography.labelMedium.font)
                            .foregroundStyle(OpenBitFunTheme.ink).lineLimit(1)
                        Text(reference.remotePath).font(MobileDesignTypography.labelSmall.font)
                            .foregroundStyle(OpenBitFunTheme.muted).lineLimit(1)
                        if let status = model.downloadStatus(for: reference.remotePath) {
                            Text(status).font(MobileDesignTypography.labelSmall.font)
                                .foregroundStyle(model.downloadPhase == .failed ? OpenBitFunTheme.statusDanger : OpenBitFunTheme.muted)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            Button { model.downloadRemoteFile(reference: reference.reference, label: reference.label) } label: {
                Group {
                    if model.downloadStatus(for: reference.remotePath) != nil,
                       [.preparing, .downloading, .saving].contains(model.downloadPhase) {
                        ProgressView().controlSize(.small)
                    } else if model.downloadStatus(for: reference.remotePath) != nil,
                              model.downloadPhase == .saved {
                        Image(systemName: "checkmark.circle")
                    } else {
                        Image(systemName: "arrow.down.circle")
                    }
                }
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(OpenBitFunTheme.muted).frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.localizedFormat("下载 %@", reference.label))
        }
        .padding(.leading, 10).padding(.trailing, 4).padding(.vertical, 7)
        .background(OpenBitFunTheme.card).clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(OpenBitFunTheme.line, lineWidth: 1))
    }
}

private struct TimelineImageGrid: View {
    let images: [MobileTimelineImage]
    @State private var selected: MobileTimelineImage?

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 7) {
            ForEach(images) { image in
                Button { selected = image } label: {
                    if let uiImage = image.uiImage {
                        Image(uiImage: uiImage).resizable().scaledToFill()
                            .frame(height: images.count == 1 ? 180 : 112).frame(maxWidth: .infinity)
                            .clipped().clipShape(RoundedRectangle(cornerRadius: 14))
                    } else {
                        Image(systemName: "photo").foregroundStyle(OpenBitFunTheme.muted)
                            .frame(maxWidth: .infinity, minHeight: 112).background(OpenBitFunTheme.soft)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .fullScreenCover(item: $selected) { FullScreenTimelineImage(image: $0) }
    }
}

private struct FullScreenTimelineImage: View {
    let image: MobileTimelineImage
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            OpenBitFunTheme.mediaBackground.ignoresSafeArea()
            if let uiImage = image.uiImage { Image(uiImage: uiImage).resizable().scaledToFit().ignoresSafeArea() }
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(OpenBitFunTheme.contentOnAction)
                    .frame(width: 44, height: 44).background(OpenBitFunTheme.mediaControlBackground).clipShape(Circle())
            }
            .buttonStyle(.plain).padding(20)
        }
    }
}

private extension MobileTimelineImage {
    var uiImage: UIImage? {
        guard let marker = dataURL.range(of: "base64,") else { return nil }
        return Data(base64Encoded: String(dataURL[marker.upperBound...])).flatMap(UIImage.init(data:))
    }
}

private enum ToolDisplayRow: Identifiable {
    case tool(MobileTimelineTool)
    case collapsed(id: String, tools: [MobileTimelineTool])
    var id: String {
        switch self { case let .tool(tool): tool.id; case let .collapsed(id, _): id }
    }
}

private struct ToolStatusList: View {
    let tools: [MobileTimelineTool]
    let model: MobileAppModel
    @Binding var expandedToolID: String?
    @State private var summariesExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(displayRows) { row in
                switch row {
                case let .tool(tool):
                    if let path = tool.planPath {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(tool.planName.isEmpty ? model.localized("计划") : tool.planName).font(MobileDesignTypography.titleSmall.font)
                            if !tool.planOverview.isEmpty { Text(tool.planOverview).font(MobileDesignTypography.bodySmall.font) }
                            Button(model.localized("查看计划")) { model.openRemoteFile(reference: path, label: tool.planName) }.disabled(path.isEmpty)
                            Button(model.localized("执行计划")) { model.buildRemotePlan(path: path, name: tool.planName) }
                                .disabled(!model.remoteHostCapabilities.contains("plan_build_v1") || model.busy || model.isSending || !model.remoteConnected || tool.phase != "COMPLETED" || path.isEmpty)
                            if !model.remoteHostCapabilities.contains("plan_build_v1") { Text(model.localized("此电脑暂不支持执行计划")) }
                            else if model.isSending || model.busy { Text(model.localized("请等待当前操作完成")) }
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                            .background(OpenBitFunTheme.soft).clipShape(RoundedRectangle(cornerRadius: 14))
                    } else { ToolStatusRow(tool: tool, model: model, expandedToolID: $expandedToolID) }
                case let .collapsed(_, tools): CollapsedToolsRow(tools: tools, model: model, expanded: $summariesExpanded, expandedToolID: $expandedToolID)
                }
            }
        }
    }

    private var displayRows: [ToolDisplayRow] {
        var result: [ToolDisplayRow] = []
        var pending: [MobileTimelineTool] = []
        func flush() {
            if pending.count < 2 { result.append(contentsOf: pending.map(ToolDisplayRow.tool)) }
            else if let first = pending.first {
                result.append(.collapsed(id: "collapsed-\(first.id)", tools: pending))
            }
            pending.removeAll()
        }
        for tool in tools {
            if tool.foldIntoSummary { pending.append(tool) } else { flush(); result.append(.tool(tool)) }
        }
        flush()
        return result
    }
}

private struct ToolSummaryButton: View {
    let tools: [MobileTimelineTool]
    let model: MobileAppModel
    @Binding var expanded: Bool

    var body: some View {
        Button { withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() } } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc.on.doc").font(.system(size: 12, weight: .medium))
                    .frame(width: 20, height: 20).background(OpenBitFunTheme.soft)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                Text(model.localizedFormat("已完成 %lld 项操作", Int64(tools.count)))
                    .font(MobileDesignTypography.bodySmall.font)
                Spacer()
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(OpenBitFunTheme.muted).frame(minHeight: 32)
                    .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tool.summary.\(tools.first?.id ?? "empty")")
    }
}

private struct CollapsedToolsRow: View {
    let tools: [MobileTimelineTool]
    let model: MobileAppModel
    @Binding var expanded: Bool
    @Binding var expandedToolID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ToolSummaryButton(tools: tools, model: model, expanded: $expanded)
            if expanded {
                ForEach(tools) { ToolStatusRow(tool: $0, model: model, expandedToolID: $expandedToolID) }
            }
        }
    }
}

private struct ToolStatusRow: View {
    let tool: MobileTimelineTool
    @ObservedObject var model: MobileAppModel
    @Binding var expandedToolID: String?
    private var expanded: Bool { expandedToolID == tool.id }
    @State private var answer = ""
    @State private var editingApproval = false
    @State private var approvalInput = ""
    @State private var selectedOptions: [Int: Set<String>] = [:]
    @State private var otherAnswers: [Int: String] = [:]

    private var transcriptActions: Set<String> {
        guard model.permissionMailbox?.ownsToolInteraction(toolId: tool.id) == true else { return tool.actions }
        return tool.actions.subtracting(["ANSWER", "APPROVE", "REJECT"])
            .subtracting(tool.actions.contains("ANSWER") ? ["CANCEL"] : [])
    }

    private var emphasized: Bool { !transcriptActions.isEmpty || expanded || tool.phase == "FAILED" }

    var mailboxQuestion = false

    @ViewBuilder
    var body: some View {
        if mailboxQuestion {
            if tool.questions.isEmpty { legacyAnswerPanel }
            else { structuredAnswerPanel }
        } else {
            toolRow
        }
    }

    private var toolRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if !tool.input.isEmpty || !tool.output.isEmpty || !tool.filePath.isEmpty {
                    withAnimation(.easeOut(duration: 0.18)) { expandedToolID = expanded ? nil : tool.id }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: toolSymbol).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(statusColor).frame(width: 20, height: 20)
                        .background(statusColor.opacity(0.09)).clipShape(RoundedRectangle(cornerRadius: 6))
                    Text(statusLabel).font(MobileDesignTypography.bodySmall.font)
                        .foregroundStyle(OpenBitFunTheme.ink).lineLimit(1)
                    Spacer(minLength: 4)
                    if tool.phase == "RUNNING" { ProgressView().controlSize(.mini) }
                    else { Text(statusMark).font(MobileDesignTypography.labelSmall.font).foregroundStyle(statusColor) }
                }
                .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("tool.toggle.\(tool.id)")

            if expanded {
                if !tool.filePath.isEmpty {
                    Button { model.openRemoteFile(reference: tool.filePath, label: tool.fileLabel) } label: {
                        Label(tool.fileLabel.isEmpty ? tool.filePath : tool.fileLabel, systemImage: "doc.text")
                            .font(MobileDesignTypography.labelSmall.font).foregroundStyle(MobileDesignColors.fileLink)
                    }
                    .buttonStyle(.plain)
                }
                if !tool.input.isEmpty { detailText(model.localized("输入"), tool.input) }
                if !tool.output.isEmpty { detailText(model.localized("输出"), tool.output) }
            }

            if transcriptActions.contains("ANSWER") {
                if tool.questions.isEmpty {
                    legacyAnswerPanel
                } else {
                    structuredAnswerPanel
                }
            } else if transcriptActions.contains("APPROVE") || transcriptActions.contains("REJECT") {
                if transcriptActions.contains("APPROVE") {
                    HStack {
                        Spacer(minLength: 0)
                        Button(model.localized(editingApproval ? "收起参数" : "编辑参数")) {
                            if !editingApproval && approvalInput.isEmpty { approvalInput = tool.input.isEmpty ? "{}" : tool.input }
                            editingApproval.toggle()
                        }
                        .font(MobileDesignTypography.labelSmall.font).foregroundStyle(OpenBitFunTheme.muted)
                        .frame(minHeight: 32)
                    }
                    if editingApproval {
                        TextEditor(text: $approvalInput).font(.system(size: MobileDesignTypography.labelSmall.size, design: .monospaced))
                            .frame(height: 96).scrollContentBackground(.hidden)
                            .padding(8).background(OpenBitFunTheme.card, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
                HStack(spacing: MobileDesignGeometry.approvalCardGap) {
                    Spacer(minLength: 0)
                    if transcriptActions.contains("REJECT") {
                        compactApprovalAction(model.localized("拒绝"), primary: false) { model.rejectTool(tool.id) }
                    }
                    if transcriptActions.contains("APPROVE") {
                        compactApprovalAction(model.localized("批准"), primary: true) {
                            model.approveTool(tool.id, updatedInput: editingApproval ? approvalInput : nil)
                        }.disabled(editingApproval && ((try? JSONSerialization.jsonObject(with: Data(approvalInput.utf8))) as? [String: Any]) == nil)
                    }
                }
            }
            if transcriptActions.contains("CANCEL") {
                Button { model.cancelTool(tool.id) } label: {
                    Text(model.localized("停止执行"))
                        .font(MobileDesignTypography.labelMedium.font).foregroundStyle(OpenBitFunTheme.statusDanger)
                        .frame(maxWidth: .infinity, minHeight: 40).background(OpenBitFunTheme.card).clipShape(Capsule())
                        .overlay(Capsule().stroke(OpenBitFunTheme.statusDanger.opacity(0.5), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(emphasized ? 10 : 0).background(emphasized ? OpenBitFunTheme.soft : OpenBitFunTheme.transparent)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay { if emphasized { RoundedRectangle(cornerRadius: 14).stroke(OpenBitFunTheme.line, lineWidth: 1) } }
    }

    private func compactApprovalAction(_ title: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(MobileDesignTypography.labelMedium.font).padding(.horizontal, 16)
                .frame(height: MobileDesignGeometry.approvalActionHeight)
                .foregroundStyle(primary ? OpenBitFunTheme.contentOnAction : OpenBitFunTheme.ink)
                .background(primary ? MobileDesignColors.primaryAction : OpenBitFunTheme.card,
                    in: RoundedRectangle(cornerRadius: MobileDesignGeometry.approvalActionRadius))
        }.buttonStyle(.plain)
    }

    private var legacyAnswerPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(tool.question ?? model.localized("请输入回复")).font(MobileDesignTypography.bodySmall.font)
                .foregroundStyle(OpenBitFunTheme.ink)
            TextField(model.localized("回复"), text: $answer, axis: .vertical)
                .font(MobileDesignTypography.bodyLarge.font).lineLimit(2...5).padding(10)
                .background(OpenBitFunTheme.card).clipShape(RoundedRectangle(cornerRadius: 11))
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(OpenBitFunTheme.line, lineWidth: 1))
            Button { model.answerTool(tool.id, answer: answer) } label: {
                Text(model.localized("发送回复"))
                    .font(MobileDesignTypography.labelMedium.font).foregroundStyle(OpenBitFunTheme.contentOnAction)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy ? OpenBitFunTheme.muted : OpenBitFunTheme.accent)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain).disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
        }
    }

    private var structuredAnswerPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            ForEach(tool.questions) { question in
                VStack(alignment: .leading, spacing: 7) {
                    if !question.header.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(question.header).font(MobileDesignTypography.labelMedium.font).foregroundStyle(OpenBitFunTheme.muted)
                    }
                    Text(question.question).font(MobileDesignTypography.bodySmall.font).foregroundStyle(OpenBitFunTheme.ink)
                    ForEach(options(for: question)) { option in
                        let selected = selectedOptions[question.index, default: []].contains(option.label)
                        Button { toggle(option.label, for: question) } label: {
                            HStack(alignment: .top, spacing: 9) {
                                Image(systemName: selected ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle") : (question.multiSelect ? "square" : "circle"))
                                    .foregroundStyle(selected ? OpenBitFunTheme.accent : OpenBitFunTheme.muted)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label).font(MobileDesignTypography.bodySmall.font).foregroundStyle(OpenBitFunTheme.ink)
                                    if let description = option.description, !description.isEmpty {
                                        Text(description).font(MobileDesignTypography.labelSmall.font).foregroundStyle(OpenBitFunTheme.muted)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 5)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("question.option.\(tool.id).\(question.index).\(option.label)")
                        .disabled(model.busy)
                        if selected && isOther(option) {
                            TextField(model.localized("请输入回复"), text: Binding(
                                get: { otherAnswers[question.index, default: ""] },
                                set: { otherAnswers[question.index] = $0 }
                            ))
                            .font(MobileDesignTypography.bodySmall.font).padding(9)
                            .disabled(model.busy)
                            .background(OpenBitFunTheme.card).clipShape(RoundedRectangle(cornerRadius: 9))
                            .overlay(RoundedRectangle(cornerRadius: 9).stroke(OpenBitFunTheme.line, lineWidth: 1))
                        }
                    }
                }
            }
            Button { submitStructuredAnswers() } label: {
                HStack {
                    if model.busy { ProgressView().controlSize(.small).tint(OpenBitFunTheme.contentOnAction) }
                    Text(model.localized("发送回复"))
                }
                .font(MobileDesignTypography.labelMedium.font).foregroundStyle(OpenBitFunTheme.contentOnAction)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(structuredAnswersValid && !model.busy ? OpenBitFunTheme.accent : OpenBitFunTheme.muted)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain).accessibilityIdentifier("question.submit.\(tool.id)").disabled(!structuredAnswersValid || model.busy)
        }
    }

    private func options(for question: MobileTimelineQuestion) -> [MobileTimelineOption] {
        question.options.contains(where: isOther) ? question.options : question.options + [MobileTimelineOption(label: model.localized("其他"), description: nil)]
    }

    private func isOther(_ option: MobileTimelineOption) -> Bool {
        let normalized = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let localizedOther = model.localized("其他").trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.lowercased() == "other" || normalized == "其他" || normalized == localizedOther
    }

    private func toggle(_ label: String, for question: MobileTimelineQuestion) {
        guard !model.busy else { return }
        if question.multiSelect {
            if selectedOptions[question.index, default: []].contains(label) {
                selectedOptions[question.index]?.remove(label)
            } else {
                selectedOptions[question.index, default: []].insert(label)
            }
        } else {
            selectedOptions[question.index] = [label]
        }
    }

    private var structuredAnswersValid: Bool {
        tool.questions.allSatisfy { question in
            let selected = selectedOptions[question.index, default: []]
            guard !selected.isEmpty else { return false }
            return !selected.contains(where: { label in
                isOther(MobileTimelineOption(label: label, description: nil)) &&
                    otherAnswers[question.index, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            })
        }
    }

    private func submitStructuredAnswers() {
        let answers = tool.questions.map { question in
            let selected = selectedOptions[question.index, default: []]
            let values = selected.map { label in
                isOther(MobileTimelineOption(label: label, description: nil))
                    ? otherAnswers[question.index, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
                    : label
            }
            let value: QuestionAnswerValue = question.multiSelect
                ? QuestionAnswerValueChoice(values: values)
                : QuestionAnswerValueText(text: values[0])
            return QuestionAnswer(index: Int32(question.index), value: value)
        }
        model.answerTool(tool.id, answers: answers)
    }

    @ViewBuilder
    private func detailText(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(MobileDesignTypography.labelSmall.font).foregroundStyle(OpenBitFunTheme.muted)
            Text(value).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(OpenBitFunTheme.ink)
                .lineLimit(5).textSelection(.enabled)
        }
    }

    private func toolAction(_ label: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(MobileDesignTypography.labelMedium.font)
                .foregroundStyle(primary ? OpenBitFunTheme.contentOnAction : OpenBitFunTheme.ink)
                .frame(maxWidth: .infinity, minHeight: 40).background(primary ? OpenBitFunTheme.accent : OpenBitFunTheme.card)
                .clipShape(Capsule()).overlay { if !primary { Capsule().stroke(OpenBitFunTheme.line, lineWidth: 1) } }
        }
        .buttonStyle(.plain)
    }

    private var operationLabel: String {
        switch tool.operation {
        case "UPDATE_TODOS": model.localized("更新待办")
        case "START_TASK": model.localized("启动子任务")
        case "READ_FILE": model.localized("读取文件")
        case "WRITE_FILE": model.localized("写入文件")
        case "DELETE_FILE": model.localized("删除文件")
        case "VIEW_DIFF": model.localized("查看差异")
        case "EDIT_FILE": model.localized("编辑文件")
        case "RUN_COMMAND": model.localized("运行命令")
        case "SEARCH_WEB": model.localized("搜索网页")
        case "OPEN_WEB": model.localized("打开网页")
        case "SEARCH_CODE": model.localized("搜索代码")
        case "ASK_CONFIRMATION": model.localized("请求确认")
        default: tool.name.isEmpty ? model.localized("工具") : tool.name
        }
    }

    private var statusLabel: String {
        let target = tool.target.isEmpty ? "" : " · \(tool.target)"
        return switch tool.phase {
        case "RUNNING": model.localizedFormat("正在%@%@", operationLabel, target)
        case "FAILED": model.localizedFormat("%@失败%@", operationLabel, target)
        case "PENDING_CONFIRMATION": model.localizedFormat("等待确认 · %@", operationLabel)
        case "WAITING": model.localizedFormat("等待执行 · %@", operationLabel)
        default: "\(operationLabel)\(target)"
        }
    }

    private var toolSymbol: String {
        switch tool.kind {
        case "QUESTION": "questionmark.circle"
        case "TODO": "checklist"
        case "TASK": "person.2"
        case "GIT": "arrow.triangle.branch"
        case "DELETE": "trash"
        case "DIFF": "doc.text.magnifyingglass"
        case "PATCH", "COMMAND": "terminal"
        case "CREATE": "doc.badge.plus"
        case "MUTATE": "square.and.pencil"
        case "FOLDER": "folder"
        case "DOCUMENT": "doc.text"
        case "SEARCH": "magnifyingglass"
        case "WEB": "link"
        default: "wrench.and.screwdriver"
        }
    }

    private var statusColor: Color {
        switch tool.phase { case "FAILED": OpenBitFunTheme.statusDanger; case "COMPLETED": OpenBitFunTheme.statusSuccess; default: OpenBitFunTheme.muted }
    }

    private var statusMark: String {
        switch tool.phase { case "FAILED": "!"; case "PENDING_CONFIRMATION": "?"; case "CANCELLED": "×"; case "COMPLETED": "✓"; default: "•" }
    }
}

private struct PermissionMailboxMaxHeightKey: EnvironmentKey {
    static let defaultValue: CGFloat = 280
}

extension EnvironmentValues {
    var permissionMailboxMaxHeight: CGFloat {
        get { self[PermissionMailboxMaxHeightKey.self] }
        set { self[PermissionMailboxMaxHeightKey.self] = newValue }
    }
}

struct PermissionMailboxPanel: View {
    @ObservedObject var model: MobileAppModel
    @Environment(\.permissionMailboxMaxHeight) private var maxHeight
    @State private var expandedMailboxToolID: String?
    @State private var contentHeight: CGFloat = 1
    var body: some View {
        if model.surface == .remote, let mailbox = model.permissionMailbox,
           mailbox.failed || !mailbox.requests.isEmpty || !mailbox.questions.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: MobileDesignGeometry.approvalCardGap) {
                    if mailbox.failed {
                        HStack {
                            Text(model.localized("Permission request could not be completed. Retry to refresh pending requests."))
                                .foregroundStyle(OpenBitFunTheme.statusDanger)
                            Button(model.localized("重试")) { model.refreshPermissionMailbox() }.disabled(mailbox.busy)
                        }.font(MobileDesignTypography.bodySmall.font)
                    }
                    ForEach(mailbox.questions, id: \.id) { question in
                        ToolStatusRow(tool: MobileAppModel.mapTool(question), model: model, expandedToolID: $expandedMailboxToolID, mailboxQuestion: true)
                            .disabled(mailbox.busy)
                            .simultaneousGesture(TapGesture().onEnded { model.startQuestionInteraction(question.id) })
                    }
                    ForEach(mailbox.requests, id: \.requestId) { request in
                        PermissionMailboxRow(request: request, busy: mailbox.busy, model: model)
                    }
                }
                .padding(.horizontal, MobileDesignGeometry.contentGutter).padding(.vertical, 8)
                .background(GeometryReader { proxy in
                    Color.clear.preference(key: PermissionMailboxHeightKey.self, value: proxy.size.height)
                })
            }
            .frame(height: min(contentHeight, maxHeight))
            .onPreferenceChange(PermissionMailboxHeightKey.self) { height in
                contentHeight = height
                #if DEBUG
                Logger(subsystem: "com.openbitfun.mobile.ios", category: "permission-mailbox").info("Mailbox layout height=\(height) limit=\(maxHeight) requests=\(mailbox.requests.count)")
                #endif
            }
            .id(model.selectedSessionID)
        }
    }
}

private struct PermissionMailboxHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 1
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct PermissionMailboxRow: View {
    let request: PermissionMailboxRequest
    let busy: Bool
    @ObservedObject var model: MobileAppModel
    @State private var editing = false
    @State private var input = "{}"
    private var valid: Bool {
        guard editing else { return true }
        guard let data = input.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) else { return false }
        return object is [String: Any]
    }
    var body: some View {
        VStack(alignment: .leading, spacing: MobileDesignGeometry.approvalCardGap) {
            HStack(spacing: 8) {
                Image("ApprovalShield").resizable().frame(width: 16, height: 16)
                Text(request.source.isEmpty ? request.action : request.source)
                    .font(MobileDesignTypography.bodySmall.font).foregroundStyle(OpenBitFunTheme.ink)
                Spacer(minLength: 8)
                Button(model.localized(editing ? "收起参数" : "编辑参数")) { editing.toggle() }
                    .font(MobileDesignTypography.labelSmall.font).foregroundStyle(OpenBitFunTheme.muted)
                    .frame(minHeight: 32).disabled(busy)
            }
            if !request.source.isEmpty && request.source.lowercased() != request.action.lowercased() {
                Text(request.action).font(MobileDesignTypography.bodySmall.font).foregroundStyle(OpenBitFunTheme.muted)
            }
            if !request.resources.isEmpty {
                Text(request.resources.joined(separator: "\n"))
                    .font(.system(size: MobileDesignTypography.labelSmall.size, design: .monospaced))
                    .foregroundStyle(OpenBitFunTheme.ink).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10).background(OpenBitFunTheme.soft, in: RoundedRectangle(cornerRadius: 8))
                    .textSelection(.enabled)
            }
            if editing {
                TextEditor(text: $input).font(.system(size: MobileDesignTypography.labelSmall.size, design: .monospaced))
                    .frame(height: 96).disabled(busy).scrollContentBackground(.hidden)
                    .padding(8).background(OpenBitFunTheme.soft, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(valid ? OpenBitFunTheme.line : OpenBitFunTheme.statusDanger, lineWidth: 1))
            }
            HStack(spacing: MobileDesignGeometry.approvalCardGap) {
                Spacer(minLength: 0)
                Button { model.respondPermission(request.requestId, approve: false, updatedInput: nil) } label: {
                    Text(model.localized("拒绝")).padding(.horizontal, 16)
                        .frame(height: MobileDesignGeometry.approvalActionHeight)
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .background(OpenBitFunTheme.soft, in: RoundedRectangle(cornerRadius: MobileDesignGeometry.approvalActionRadius))
                }.disabled(busy)
                .accessibilityIdentifier("permission.reject.\(request.requestId)")
                Button { model.respondPermission(request.requestId, approve: true, updatedInput: editing ? input : nil) } label: {
                    Text(model.localized("批准")).padding(.horizontal, 16)
                        .frame(height: MobileDesignGeometry.approvalActionHeight)
                        .foregroundStyle(OpenBitFunTheme.contentOnAction)
                        .background(MobileDesignColors.primaryAction, in: RoundedRectangle(cornerRadius: MobileDesignGeometry.approvalActionRadius))
                }.disabled(busy || !valid).opacity(busy || !valid ? 0.5 : 1)
                .accessibilityIdentifier("permission.approve.\(request.requestId)")
            }.font(MobileDesignTypography.labelMedium.font)
        }
        .buttonStyle(.plain).padding(MobileDesignGeometry.approvalCardPadding)
        .background(OpenBitFunTheme.card, in: RoundedRectangle(cornerRadius: MobileDesignGeometry.approvalCardRadius))
        .overlay(RoundedRectangle(cornerRadius: MobileDesignGeometry.approvalCardRadius).stroke(OpenBitFunTheme.line, lineWidth: 1))
    }
}
