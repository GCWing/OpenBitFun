import SwiftUI
import UIKit
import OpenBitFunMobileCore

private let conversationHeaderActionSurfaceSize: CGFloat = 42

struct ConversationHeader: View {
    @ObservedObject var model: MobileAppModel
    @Binding var actionsOpen: Bool
    var contextTitle: String? = nil
    var sidebarAction: (() -> Void)? = nil
    var sidebarActionLabel: String = "打开侧栏"
    @State private var editing = false
    @State private var renameDraft = ""

    private var resolvedTitle: String {
        if let title = model.selectedSession?.title, !title.isEmpty { return title }
        return "OpenBitFun"
    }

    private var resolvedSubtitle: String? {
        if let contextTitle, !contextTitle.isEmpty { return contextTitle }
        if model.surface == .local && model.localSessionSelected { return model.localized("本地会话") }
        if model.remoteConnected {
            return model.accountDeviceName

                ?? model.localized("已连接桌面端")
        }
        return nil
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let sidebarAction {
                    Button(action: sidebarAction) {
                        ReferenceGlyph(assetName: "MenuGlyph", width: 23, height: 18)
                            .frame(
                                width: conversationHeaderActionSurfaceSize,
                                height: conversationHeaderActionSurfaceSize
                            )
                            .background(OpenBitFunTheme.card)
                            .clipShape(Circle())
                            .shadow(color: OpenBitFunTheme.shadowSubtle, radius: 15, y: 4)
                            .frame(
                                width: MobileDesignGeometry.controlTouchSize,
                                height: MobileDesignGeometry.controlTouchSize
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(MobileLocalization.text(sidebarActionLabel))
                } else {
                    OpenBitFunTheme.transparent
                        .frame(
                            width: MobileDesignGeometry.controlTouchSize,
                            height: MobileDesignGeometry.controlTouchSize
                        )
                }

                VStack(spacing: 3) {
                    Text(resolvedTitle)
                        .font(
                            (resolvedSubtitle == nil
                                ? MobileDesignTypography.titleMedium
                                : MobileDesignTypography.conversationHeaderTitle).font
                        )
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .lineLimit(1)
                    if let resolvedSubtitle {
                        Text(resolvedSubtitle)
                            .font(MobileDesignTypography.labelMedium.font)
                            .foregroundStyle(OpenBitFunTheme.muted)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onTapGesture {
                    guard let session = model.selectedSession, !model.busy else { return }
                    renameDraft = session.title
                    editing = true
                }

                if model.selectedSession != nil {
                    actionsMenu
                } else {
                    OpenBitFunTheme.transparent
                        .frame(
                            width: MobileDesignGeometry.controlTouchSize,
                            height: MobileDesignGeometry.controlTouchSize
                        )
                }
            }
            .frame(
                height: MobileDesignGeometry.conversationHeaderHeight
            )
            .padding(.horizontal, MobileDesignGeometry.contentGutter)

            if editing {
                renameEditor
            }
        }
        .background(OpenBitFunTheme.page)
        .onChange(of: model.selectedSession?.title) { _ in
            editing = false
        }
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--session-actions") {
                actionsOpen = true
            }
        }
    }

    private var actionsMenu: some View {
        Button { actionsOpen.toggle() } label: {
            ReferenceGlyph(assetName: "MoreGlyph", width: 23, height: 7)
                .frame(
                    width: conversationHeaderActionSurfaceSize,
                    height: conversationHeaderActionSurfaceSize
                )
                .background(OpenBitFunTheme.card)
                .clipShape(Circle())
                .shadow(color: OpenBitFunTheme.shadowSubtle, radius: 15, y: 4)
                .frame(
                    width: MobileDesignGeometry.controlTouchSize,
                    height: MobileDesignGeometry.controlTouchSize
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.localized("会话操作"))
        .anchorPreference(key: SessionActionsAnchorKey.self, value: .bounds) { $0 }
    }

    private var renameEditor: some View {
        HStack(spacing: 8) {
            TextField(model.localized("会话标题"), text: $renameDraft)
                .font(.system(size: 14))
                .foregroundStyle(OpenBitFunTheme.ink)
                .padding(.horizontal, 12)
                .frame(height: 42)
                .background(OpenBitFunTheme.card)
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(OpenBitFunTheme.line, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14))

            editorButton("保存", primary: true, enabled: !renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                model.renameSelectedSession(renameDraft)
                editing = false
            }
            editorButton("取消", primary: false, enabled: true) {
                editing = false
            }
        }
        .padding(.leading, MobileDesignGeometry.contentGutter)
        .padding(.trailing, MobileDesignGeometry.contentGutter)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    private func editorButton(
        _ title: String,
        primary: Bool,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(model.localized(title))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(primary && enabled ? OpenBitFunTheme.contentOnAction : OpenBitFunTheme.ink)
                .frame(width: 52, height: 42)
                .background(primary && enabled ? OpenBitFunTheme.accent : OpenBitFunTheme.soft)
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

struct SessionActionsAnchorKey: PreferenceKey {
    static var defaultValue: Anchor<CGRect>?

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

/// The active-conversation popup is rendered by the shell so it can remain an
/// arrowless, anchored, auto-cancelling popup on compact iPhones as well as on
/// iPad. SwiftUI's native popover adapts to a centred page on compact width,
/// which is a different component from Harmony's `bindPopup(mask: false)`.
struct ConversationActionsPopover: View {
    @ObservedObject var model: MobileAppModel
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(model.localized("会话"))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(OpenBitFunTheme.muted)
                .frame(height: 28)
                .padding(.leading, 8)
            action("已上传文件", icon: "cloud", perform: model.showUploadedFiles)
            if model.isSending && model.remoteConnected && model.connectionPhase == .connected {
                Divider().overlay(OpenBitFunTheme.line).padding(.vertical, 8)
                action("停止", icon: "gearshape", perform: model.stopSending)
            }
        }
        .openBitFunPopoverSurface()
        .accessibilityAction(.escape, onDismiss)
    }

    private func action(
        _ title: String,
        icon: String,
        selected: Bool = false,
        perform: @escaping () -> Void
    ) -> some View {
        Button {
            perform()
            onDismiss()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .frame(width: 23, height: 23)
                Text(model.localized(title))
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(OpenBitFunTheme.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(height: MobileDesignGeometry.popoverActionHeight)
            .background(selected ? OpenBitFunTheme.soft : OpenBitFunTheme.transparent)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}


struct ThreadGoalPanel: View {
    @ObservedObject var model: MobileAppModel
    @State private var objective = ""
    @State private var editing = false
    @State private var clearing = false
    @State private var saving = false
    private var current: ThreadGoalUiState? {
        model.threadGoal.flatMap { $0.sessionId == model.selectedSessionID ? $0 : nil }
    }
    private var connected: Bool { model.remoteConnected && model.connectionPhase == .connected }
    private var enabled: Bool { connected && current?.loaded == true && current?.busy == false && current?.failure == nil }
    private var status: String {
        let value = current?.status ?? "unknown"
        return model.localized("goal.\(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].contains(value) ? value : "unknown")")
    }
    var body: some View {
        if model.surface == .remote {
            VStack(spacing: 0) {
                if let text = current?.objective {
                    Button {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                        model.goalAction(.open)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "target").font(.system(size: 17))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(connected ? status : model.localized("goal.offline"))
                                    .font(.caption2).foregroundStyle(OpenBitFunTheme.muted)
                                Text(text).font(.subheadline).lineLimit(1)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right").font(.caption)
                        }.foregroundStyle(OpenBitFunTheme.ink).padding(.horizontal, 12).padding(.vertical, 10)
                            .background(OpenBitFunTheme.soft, in: RoundedRectangle(cornerRadius: 14))
                    }.buttonStyle(.plain).accessibilityLabel(model.localized("goal.manage"))
                }
            }
            .onAppear { refresh() }
            .onChange(of: model.selectedSessionID) { _ in objective = ""; editing = false; clearing = false; saving = false; refresh() }
            .onChange(of: connected) { _ in refresh() }
            .sheet(isPresented: Binding(get: { current?.visible == true }, set: { if !$0 { model.goalAction(.close) } })) {
                panel
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .onDisappear { objective = ""; editing = false; clearing = false; saving = false }
            }
        }
    }
    private func refresh() { if connected && !model.selectedSessionID.isEmpty { model.goalAction(.read) } }
    private func text(_ key: String) -> String { model.localized("goal." + key) }
    private var panel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(text(clearing ? "clearTitle" : editing ? "modify" : current?.objective == nil ? "set" : "title"))
                        .font(.title3.weight(.semibold))
                    Spacer()
                    Button { model.goalAction(.close) } label: {
                        Image(systemName: "xmark").frame(width: 44, height: 44)
                    }.accessibilityLabel(text("close"))
                }
                if !connected { Text(text("offline")).font(.subheadline).foregroundStyle(OpenBitFunTheme.muted) }
                if let goal = current {
                    if goal.busy { ProgressView() }
                    if let failure = goal.failure {
                        Text(text(failure == .unsupported ? "unsupported" : failure == .attachments ? "attachments" : "failed"))
                            .font(.subheadline).foregroundStyle(OpenBitFunTheme.muted)
                        Button(text("retry")) { refresh() }.disabled(!connected || goal.busy)
                    }
                    if goal.loaded {
                        if clearing {
                            Text(text("clearHint")).font(.subheadline)
                            HStack {
                                Button(text("keep")) { clearing = false }.buttonStyle(.bordered)
                                Spacer()
                                Button(text("clear"), role: .destructive) { saving = true; model.goalAction(ThreadGoalAction.clear) }
                                    .buttonStyle(.bordered).disabled(!enabled)
                            }
                        } else if goal.objective == nil || editing {
                            Text(text("hint")).font(.subheadline).foregroundStyle(OpenBitFunTheme.muted)
                            Text(text("description")).font(.caption).foregroundStyle(OpenBitFunTheme.muted)
                            TextField(text("objective"), text: $objective, axis: .vertical)
                                .lineLimit(4...8).padding(12).background(OpenBitFunTheme.soft, in: RoundedRectangle(cornerRadius: 10))
                                .disabled(!connected || saving)
                            HStack {
                                Button(text("cancel")) { if goal.objective != nil { editing = false } else { model.goalAction(.close) } }
                                Spacer()
                                Button(text(goal.objective == nil ? "set" : "save")) {
                                    saving = true
                                    model.goalAction(goal.objective == nil ? .start : .edit, objective: objective.trimmingCharacters(in: .whitespacesAndNewlines))
                                }.buttonStyle(.borderedProminent).tint(OpenBitFunTheme.ink)
                                    .disabled(!enabled || objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        } else {
                            HStack {
                                Text(status).font(.caption).padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(OpenBitFunTheme.soft, in: Capsule())
                                Spacer()
                                Text(MobileLocalization.format("goal.usage", language: model.appLanguage, goal.tokensUsed))
                                    .font(.caption2).foregroundStyle(OpenBitFunTheme.muted)
                            }
                            card(text("description"), goal.objective ?? "")
                            card(text("workflow"), goal.status == "active" ? text("workflowHint") : goal.status == "paused" ? text("pausedHint") : status)
                            Divider()
                            HStack(spacing: 8) {
                                Button(text("modify")) { objective = goal.objective ?? ""; editing = true }
                                Spacer()
                                if goal.status == "active" { Button(text("pause")) { model.goalAction(.pause) } }
                                if goal.canResume { Button(text("resume")) { model.goalAction(.resume) } }
                                Spacer()
                                Button(text("clear"), role: .destructive) { clearing = true }
                            }.buttonStyle(.bordered).disabled(!enabled)
                        }
                    }
                }
            }.padding(20).frame(maxWidth: 420).frame(maxWidth: .infinity)
        }.background(OpenBitFunTheme.page).foregroundStyle(OpenBitFunTheme.ink)
            .onChange(of: current?.busy) { _ in finishSavingIfReady() }
            .onChange(of: saving) { _ in finishSavingIfReady() }
    }
    private func finishSavingIfReady() {
        if saving && current?.busy == false {
            if current?.failure == nil { editing = false; clearing = false; model.goalAction(.close) }
            saving = false
        }
    }
    private func card(_ label: String, _ content: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption).foregroundStyle(OpenBitFunTheme.muted)
            Text(content).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .background(OpenBitFunTheme.soft, in: RoundedRectangle(cornerRadius: 10))
    }
}
