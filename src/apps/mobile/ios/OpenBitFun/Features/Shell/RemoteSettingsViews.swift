import SwiftUI

struct RemoteViewSettingsView: View {
    @ObservedObject var model: MobileAppModel

    private var statuses: [String] {
        model.sessionListStatusOptions
    }

    private var workspaces: [MobileSessionWorkspaceOption] {
        model.sessionListWorkspaceOptions
    }

    private var agentGroups: [String] {
        model.sessionListAgentGroups
    }

    var body: some View {
        VStack(spacing: 0) {
            OpenBitFunModalHeader(
                title: "视图设置",
                subtitle: "调整会话列表的分组和信息密度",
                onClose: { model.remoteViewSettingsOpen = false }
            )
            .padding(.horizontal, 20)
            Divider().overlay(OpenBitFunTheme.line)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    sectionTitle("分组方式")
                    choiceRow("按项目", value: "PROJECT", selected: model.remoteGroupMode)
                    choiceRow("按时间倒序排列", value: "TIME", selected: model.remoteGroupMode)
                    choiceRow("聊天优先", value: "CHAT", selected: model.remoteGroupMode)

                    sectionTitle("筛选")
                    filterLabel("工作区")
                    filterRow(
                        "所有工作区",
                        selected: model.remoteWorkspaceFilter.isEmpty,
                        action: { model.remoteWorkspaceFilter = "" }
                    )
                    ForEach(workspaces) { workspace in
                        // The filter is the option key (`workspaceId ?: legacy triple`); a filter
                        // persisted as a bare path before IDs existed still matches by path.
                        filterRow(
                            workspace.name,
                            selected: model.remoteWorkspaceFilter == workspace.key ||
                                normalizedPath(model.remoteWorkspaceFilter) == normalizedPath(workspace.path),
                            action: { model.remoteWorkspaceFilter = workspace.key }
                        )
                    }

                    filterLabel("智能体类型")
                    filterRow(
                        "所有智能体类型",
                        selected: model.remoteViewAgentFilter.isEmpty,
                        action: { model.remoteViewAgentFilter = "" }
                    )
                    ForEach(agentGroups, id: \.self) { group in
                        filterRow(
                            agentLabel(group),
                            selected: model.remoteViewAgentFilter == group,
                            action: { model.remoteViewAgentFilter = group }
                        )
                    }

                    filterLabel("状态")
                    filterRow(
                        "所有状态",
                        selected: model.remoteStatusFilter.isEmpty,
                        action: { model.remoteStatusFilter = "" }
                    )
                    ForEach(statuses, id: \.self) { status in
                        filterRow(
                            statusLabel(status),
                            selected: model.remoteStatusFilter == status,
                            action: { model.remoteStatusFilter = status }
                        )
                    }

                    sectionTitle("显示信息")
                    metadataToggle("工作区", isOn: $model.remoteShowWorkspaceMetadata)
                    metadataToggle("更新时间", isOn: $model.remoteShowUpdatedMetadata)
                    metadataToggle("状态", isOn: $model.remoteShowStatusMetadata)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 34)
            }
        }
        .background(OpenBitFunTheme.page)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(model.localized(title))
            .font(MobileDesignTypography.labelSmall.font.weight(.medium))
            .foregroundStyle(OpenBitFunTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 4)
            .padding(.top, 12)
            .frame(height: 38, alignment: .topLeading)
    }

    private func filterLabel(_ title: String) -> some View {
        Text(model.localized(title))
            .font(MobileDesignTypography.labelSmall.font)
            .foregroundStyle(OpenBitFunTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 10)
            .padding(.top, 10)
            .frame(height: 34, alignment: .topLeading)
    }

    private func choiceRow(_ title: String, value: String, selected: String) -> some View {
        filterRow(title, selected: value == selected) { model.remoteGroupMode = value }
    }

    private func filterRow(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(selected ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
                    .frame(width: 22)
                Text(model.localized(title))
                    .font(MobileDesignTypography.titleSmall.font)
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 46)
            .frame(maxWidth: .infinity)
            .background(selected ? OpenBitFunTheme.card : OpenBitFunTheme.transparent)
            .overlay(alignment: .bottom) {
                Rectangle().fill(OpenBitFunTheme.line).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
    }

    private func metadataToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(model.localized(title))
                .font(MobileDesignTypography.titleSmall.font)
                .foregroundStyle(OpenBitFunTheme.ink)
        }
        .tint(OpenBitFunTheme.ink)
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: 52)
        .overlay(alignment: .bottom) {
            Rectangle().fill(OpenBitFunTheme.line).frame(height: 1)
        }
    }

    private func agentLabel(_ group: String) -> String {
        switch group {
        case "CHAT": return "聊天"
        case "COWORK": return "Cowork"
        default: return "Code"
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "active", "running": return "运行中"
        case "ready", "idle": return "就绪"
        case "archived": return "已归档"
        default: return status
        }
    }

    private func normalizedPath(_ path: String) -> String {
        var result = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while result.count > 1 && (result.hasSuffix("/") || result.hasSuffix("\\")) {
            result.removeLast()
        }
        return result
    }
}
