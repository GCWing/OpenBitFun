import SwiftUI
import OpenBitFunMobileCore

private struct QueueRowBounds: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, new in new }) }
}

struct MessageQueuePanel: View {
    @ObservedObject var model: MobileAppModel
    @State private var expanded = true
    @State private var dragging: String?
    @State private var displacement: CGFloat = 0
    @State private var destination: String?
    @State private var dragFrames: [String: CGRect] = [:]
    @State private var dragRevision = ""
    @State private var frames: [String: CGRect] = [:]

    var body: some View {
        if model.surface == .remote, let queue = model.messageQueue, queue.sessionId == model.selectedSessionID,
           !queue.items.isEmpty || queue.failure != nil {
            VStack(alignment: .leading, spacing: 0) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 6) {
                        Text(model.localizedFormat("待发送 · %d", queue.items.count))
                        Image(systemName: expanded ? "chevron.down" : "chevron.up").font(.system(size: 10))
                    }.font(MobileDesignTypography.bodySmall.font).frame(minHeight: 40)
                }.buttonStyle(.plain).foregroundStyle(OpenBitFunTheme.muted)
                if queue.failure != nil {
                    HStack {
                        Text(model.localized(queue.failure == .unsupported ? "升级执行端后可调整消息顺序。" : "队列状态已变化或未能确认，请刷新后再操作。"))
                        Button(model.localized("刷新")) { model.refreshMessageQueue() }.disabled(queue.busy)
                    }.font(MobileDesignTypography.bodySmall.font)
                }
                if expanded {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(queue.items, id: \.id) { item in row(item, queue: queue) }
                        }
                    }.frame(height: min(CGFloat(queue.items.count) * 48.5, 194))
                }
            }
            .coordinateSpace(name: "message-queue")
            .onPreferenceChange(QueueRowBounds.self) { frames = $0 }
            .padding(.horizontal, MobileDesignGeometry.contentGutter)
            .onChange(of: queue.revisionKey) { _ in cancelDrag() }
            .onChange(of: queue.failure) { _ in cancelDrag() }
            .onChange(of: queue.busy) { _ in cancelDrag() }
            .onChange(of: model.selectedSessionID) { _ in cancelDrag(); expanded = true }
            .onDisappear { cancelDrag() }
        }
    }

    private func cancelDrag() { dragging = nil; displacement = 0; destination = nil }
    private func row(_ item: QueuedMessageUiState, queue: MessageQueueUiState) -> some View {
        let ids = queue.items.filter { $0.status == "queued" }.map { $0.id }
        let index = ids.firstIndex(of: item.id)
        let enabled = queue.supportsReorder && !queue.busy && queue.failure == nil && index != nil
        return VStack(spacing: 0) {
            Rectangle().fill(OpenBitFunTheme.line).frame(height: 0.5).padding(.horizontal, 8)
            HStack(alignment: .top, spacing: 4) {
                if queue.supportsReorder {
                    Image(systemName: "line.3.horizontal").font(.system(size: 14)).foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 44, height: 48).contentShape(Rectangle())
                        .accessibilityLabel(model.localized("拖动排序"))
                        .gesture(DragGesture(minimumDistance: 6, coordinateSpace: .named("message-queue"))
                            .onChanged { value in
                                guard enabled, ids.count > 1 else { return }
                                if dragging == nil { dragging = item.id; dragFrames = frames; dragRevision = queue.revisionKey }
                                displacement = value.translation.height
                                let center = (dragFrames[item.id]?.midY ?? value.startLocation.y) + displacement
                                destination = ids.first { $0 != item.id && center < (dragFrames[$0]?.midY ?? .greatestFiniteMagnitude) }
                            }
                            .onEnded { _ in
                                if dragging == item.id, dragRevision == model.messageQueue?.revisionKey, let index, destination != ids.dropFirst(index + 1).first {
                                    model.moveQueuedMessage(item.id, before: destination)
                                }
                                cancelDrag()
                            })
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(item.text).lineLimit(1).truncationMode(.tail)
                        if item.attachmentCount > 0 {
                            Label("\(item.attachmentCount)", systemImage: "paperclip").font(MobileDesignTypography.bodySmall.font)
                                .foregroundStyle(OpenBitFunTheme.muted).fixedSize()
                        }
                    }
                    if item.status != "queued" { Text(model.localized("等待执行端处理")).font(MobileDesignTypography.bodySmall.font).foregroundStyle(OpenBitFunTheme.muted) }
                }.font(MobileDesignTypography.bodyMedium.font).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                Button { model.promoteQueuedMessage(item.id) } label: {
                    Image(systemName: "arrow.turn.down.right").frame(width: 44, height: 48)
                }.disabled(queue.busy || queue.failure != nil || !["queued", "blocked"].contains(item.status))
                    .accessibilityLabel(model.localized("立即发送"))
                Menu {
                    Text(item.text)
                    if !queue.supportsReorder { Text(model.localized("升级执行端后可调整消息顺序。")) }
                    Button(model.localized("上移")) { if let index, index > 0 { model.moveQueuedMessage(item.id, before: ids[index - 1]) } }.disabled(!enabled || index == 0)
                    Button(model.localized("下移")) { if let index { model.moveQueuedMessage(item.id, before: ids.dropFirst(index + 2).first) } }.disabled(!enabled || index == ids.count - 1)
                    Button(model.localized("从队列移除"), role: .destructive) { model.cancelQueuedMessage(item.id) }
                        .disabled(queue.busy || queue.failure != nil || !["queued", "blocked"].contains(item.status))
                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 48) }
                    .accessibilityLabel(model.localized("消息操作"))
            }.buttonStyle(.plain).foregroundStyle(OpenBitFunTheme.ink)
        }
        .overlay(alignment: .top) {
            if dragging != nil && destination == item.id {
                Rectangle().fill(OpenBitFunTheme.accent).frame(height: 1)
            }
        }
        .overlay(alignment: .bottom) {
            if dragging != nil && destination == nil && item.id == ids.last(where: { $0 != dragging }) {
                Rectangle().fill(OpenBitFunTheme.accent).frame(height: 1)
            }
        }
        .background(dragging == item.id ? OpenBitFunTheme.card : Color.clear)
        .background(GeometryReader { proxy in Color.clear.preference(key: QueueRowBounds.self, value: [item.id: proxy.frame(in: .named("message-queue"))]) })
        .offset(y: dragging == item.id ? displacement : 0)
        .zIndex(dragging == item.id ? 1 : 0)
        .accessibilityAction(named: Text(model.localized("上移"))) { if enabled, let index, index > 0 { model.moveQueuedMessage(item.id, before: ids[index - 1]) } }
        .accessibilityAction(named: Text(model.localized("下移"))) { if enabled, let index, index < ids.count - 1 { model.moveQueuedMessage(item.id, before: ids.dropFirst(index + 2).first) } }
    }
}
