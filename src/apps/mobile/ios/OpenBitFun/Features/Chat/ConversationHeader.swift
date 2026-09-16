import SwiftUI

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
                height: resolvedSubtitle == nil
                    ? MobileDesignGeometry.conversationHeaderCompactHeight
                    : MobileDesignGeometry.conversationHeaderHeight
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
            if model.isSending {
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
