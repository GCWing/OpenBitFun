import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RecentWorkspaceEntry, RemoteSession } from '../../model/RemoteModels';
import { RemoteLogger } from '../../services/RemoteLogger';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { ConversationSessionFilterPolicy } from '../policy/ConversationSessionFilterPolicy';
import {
  CARD,
  INK,
  LINE,
  MUTED,
  PAGE_BG,
  TRANSPARENT,
} from './Theme';

@ComponentV2
struct WorkspaceFilterSection {
  @Param options: RecentWorkspaceEntry[] = [];
  @Param selectedValue: string = '';
  @Event onSelect: (value: string) => void = (_value: string) => {};
  @Local currentValue: string = '';

  aboutToAppear(): void {
    this.currentValue = this.selectedValue;
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        SymbolGlyph(this.currentValue.length === 0 ? $r('sys.symbol.checkmark_circle_fill') : $r('sys.symbol.circle'))
          .fontSize(20)
          .fontColor([this.currentValue.length === 0 ? INK : MUTED])
          .width(22)
        Text(RemoteI18n.t('viewSettings.allWorkspaces'))
          .layoutWeight(1)
          .fontSize(MobileDesignTypography.titleSmall.size)
          .fontColor(INK)
      }
      .width('100%')
      .height(46)
      .padding({ left: 10, right: 10 })
      .backgroundColor(this.currentValue.length === 0 ? CARD : TRANSPARENT)
      .border({ width: { bottom: 1 }, color: LINE })
      .onClick(() => this.selectWorkspace(''))
      ForEach(this.options, (item: RecentWorkspaceEntry) => {
        Row({ space: 12 }) {
          SymbolGlyph(ConversationSessionFilterPolicy.workspacePathsEqual(this.currentValue, item.path)
            ? $r('sys.symbol.checkmark_circle_fill') : $r('sys.symbol.circle'))
            .fontSize(20)
            .fontColor([ConversationSessionFilterPolicy.workspacePathsEqual(this.currentValue, item.path) ? INK : MUTED])
            .width(22)
          Text(item.name || this.basename(item.path))
            .layoutWeight(1)
            .fontSize(MobileDesignTypography.titleSmall.size)
            .fontColor(INK)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .height(46)
        .padding({ left: 10, right: 10 })
        .backgroundColor(ConversationSessionFilterPolicy.workspacePathsEqual(this.currentValue, item.path)
          ? CARD : TRANSPARENT)
        .border({ width: { bottom: 1 }, color: LINE })
        .onClick(() => this.selectWorkspace(item.path))
      }, (item: RecentWorkspaceEntry): string => item.path)
    }
    .width('100%')
  }

  private selectWorkspace(value: string): void {
    this.currentValue = value;
    setTimeout(() => this.onSelect(value), 0);
  }

  private basename(path: string): string {
    const parts = path.split('/');
    return parts.length > 0 ? parts[parts.length - 1] : path;
  }
}

@ComponentV2
export struct ConversationViewSettings {
  @Param sessions: RemoteSession[] = [];
  @Param workspaceName: string = '';
  @Param workspacePath: string = '';
  @Param workspaceKind: string = 'normal';
  @Param recentWorkspaces: RecentWorkspaceEntry[] = [];
  @Param sortMode: string = 'project';
  @Param workspaceFilter: string = '';
  @Param agentFilter: string = '';
  @Param statusFilter: string = '';
  @Param showWorkspaceMetadata: boolean = false;
  @Param showUpdatedMetadata: boolean = false;
  @Param showStatusMetadata: boolean = false;
  @Local selectedSortMode: string = '';
  @Local selectedWorkspaceFilter: string = '';
  @Local selectedAgentFilter: string = '';
  @Local selectedStatusFilter: string = '';
  @Local selectionRevision: number = 0;
  @Event onSortModeChange: (mode: string) => void = (_mode: string) => {};
  @Event onWorkspaceFilterChange: (value: string) => void = (_value: string) => {};
  @Event onAgentFilterChange: (value: string) => void = (_value: string) => {};
  @Event onStatusFilterChange: (value: string) => void = (_value: string) => {};
  @Event onWorkspaceMetadataChange: (value: boolean) => void = (_value: boolean) => {};
  @Event onUpdatedMetadataChange: (value: boolean) => void = (_value: boolean) => {};
  @Event onStatusMetadataChange: (value: boolean) => void = (_value: boolean) => {};
  @Event onClose: () => void = () => {};
  // In its compact placement this surface is a bottom sheet under the immersive
  // shell: the scrolling column runs to the screen edge and ends in a tail that
  // rests the last control above the navigation bar.
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();

  aboutToAppear(): void {
    this.syncSelectionState();
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.insets.unbind();
  }

  build() {
    Column() {
      Row() {
        Column({ space: 3 }) {
          Text(RemoteI18n.t('viewSettings.title'))
            .fontSize(MobileDesignTypography.headlineSmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
          Text(RemoteI18n.t('viewSettings.subtitle'))
            .fontSize(MobileDesignTypography.labelSmall.size)
            .fontColor(MUTED)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(17)
            .fontColor([MUTED])
        }
        .width(44)
        .height(44)
        .accessibilityText(RemoteI18n.t('common.close'))
        .onClick(() => this.onClose())
      }
      .width('100%')
      .height(64)
      .padding({ left: 20, right: 10 })

      Divider().color(LINE)

      Scroll() {
        Column({ space: 0 }) {
          this.SectionTitle(RemoteI18n.t('viewSettings.grouping'))
          this.SortRow('project', RemoteI18n.t('remote.menu.byProject'), this.selectionRevision)
          this.SortRow('time', RemoteI18n.t('remote.menu.byTime'), this.selectionRevision)
          this.SortRow('chat', RemoteI18n.t('remote.menu.chatFirst'), this.selectionRevision)
          this.SectionTitle(RemoteI18n.t('viewSettings.filters'))
          this.FilterLabel(RemoteI18n.t('viewSettings.workspace'))
          WorkspaceFilterSection({
            options: this.workspaceFilterOptions(),
            selectedValue: this.workspaceFilter,
            onSelect: (value: string) => this.selectWorkspaceFilter(value)
          })
          this.FilterLabel(RemoteI18n.t('viewSettings.agentType'))
          this.ChoiceRow('', RemoteI18n.t('viewSettings.allAgentTypes'), this.selectedAgentFilter.length === 0,
            (value: string) => this.selectAgentFilter(value), this.selectionRevision)
          ForEach(this.agentFilterOptions(), (value: string) => {
            this.ChoiceRow(value, this.agentFilterLabel(value), this.selectedAgentFilter === value,
              (nextValue: string) => this.selectAgentFilter(nextValue), this.selectionRevision)
          }, (value: string): string => value)
          this.FilterLabel(RemoteI18n.t('viewSettings.status'))
          this.ChoiceRow('', RemoteI18n.t('viewSettings.allStatuses'), this.selectedStatusFilter.length === 0,
            (value: string) => this.selectStatusFilter(value), this.selectionRevision)
          ForEach(this.statusFilterOptions(), (value: string) => {
            this.ChoiceRow(value, this.statusFilterLabel(value), this.selectedStatusFilter === value,
              (nextValue: string) => this.selectStatusFilter(nextValue), this.selectionRevision)
          }, (value: string): string => value)
          this.SectionTitle(RemoteI18n.t('viewSettings.metadata'))
          this.ToggleRow(RemoteI18n.t('viewSettings.workspace'), this.showWorkspaceMetadata,
            this.onWorkspaceMetadataChange)
          this.ToggleRow(RemoteI18n.t('viewSettings.updated'), this.showUpdatedMetadata,
            this.onUpdatedMetadataChange)
          this.ToggleRow(RemoteI18n.t('viewSettings.status'), this.showStatusMetadata,
            this.onStatusMetadataChange)
        }
        .width('100%')
        .padding({ left: 20, right: 20, bottom: this.insets.tailSpacing(24) })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .borderRadius(16)
  }

  @Builder
  private FilterLabel(label: string) {
    Text(label)
      .width('100%')
      .height(34)
      .padding({ left: 10, top: 10 })
      .fontSize(MobileDesignTypography.labelSmall.size)
      .fontColor(MUTED)
  }

  @Builder
  private SectionTitle(title: string) {
    Text(title)
      .width('100%')
      .height(38)
      .padding({ left: 4, top: 12 })
      .fontSize(MobileDesignTypography.labelSmall.size)
      .fontWeight(FontWeight.Medium)
      .fontColor(MUTED)
  }

  @Builder
  private SortRow(mode: string, label: string, _revision: number) {
    Row({ space: 12 }) {
      SymbolGlyph(this.selectedSortMode === mode ? $r('sys.symbol.checkmark_circle_fill') : $r('sys.symbol.circle'))
        .fontSize(20)
        .fontColor([this.selectedSortMode === mode ? INK : MUTED])
      Text(label)
        .layoutWeight(1)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(INK)
    }
    .width('100%')
    .height(48)
    .padding({ left: 10, right: 10 })
    .backgroundColor(this.selectedSortMode === mode ? CARD : TRANSPARENT)
    .opacity(_revision % 2 === 0 ? 1 : 0.999)
    .border({ width: { bottom: 1 }, color: LINE })
    .onClick(() => this.selectSortMode(mode))
  }

  @Builder
  private ChoiceRow(value: string, label: string, selected: boolean, action: (value: string) => void,
    _revision: number) {
    Row({ space: 12 }) {
      SymbolGlyph(selected ? $r('sys.symbol.checkmark_circle_fill') : $r('sys.symbol.circle'))
        .fontSize(20)
        .fontColor([selected ? INK : MUTED])
        .width(22)
      Text(label)
        .layoutWeight(1)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(INK)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(46)
    .padding({ left: 10, right: 10 })
    .backgroundColor(selected ? CARD : TRANSPARENT)
    .opacity(_revision % 2 === 0 ? 1 : 0.999)
    .border({ width: { bottom: 1 }, color: LINE })
    .onClick(() => action(value))
  }

  @Builder
  private ToggleRow(label: string, value: boolean, action: (value: boolean) => void) {
    Row({ space: 12 }) {
      Text(label)
        .layoutWeight(1)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(INK)
      Toggle({ type: ToggleType.Switch, isOn: value })
        .selectedColor(INK)
        .onChange(action)
    }
    .width('100%')
    .height(52)
    .padding({ left: 10, right: 6 })
    .border({ width: { bottom: 1 }, color: LINE })
  }

  private workspaceFilterOptions(): RecentWorkspaceEntry[] {
    const result: RecentWorkspaceEntry[] = [];
    if (this.workspacePath.length > 0) {
      result.push({ path: this.workspacePath, name: this.workspaceName, lastOpened: '', workspaceKind: 'normal' });
    }
    this.recentWorkspaces.forEach((item: RecentWorkspaceEntry) => {
      if (item.path.length > 0 && !result.some((entry: RecentWorkspaceEntry) => {
        return ConversationSessionFilterPolicy.workspacePathsEqual(entry.path, item.path);
      })) {
        result.push(item);
      }
    });
    this.sessions.forEach((session: RemoteSession) => {
      const path = session.workspacePath || '';
      if (path.length > 0 && !result.some((entry: RecentWorkspaceEntry) => {
        return ConversationSessionFilterPolicy.workspacePathsEqual(entry.path, path);
      })) {
        result.push({
          path,
          name: session.workspaceName || this.basename(path),
          lastOpened: session.updatedAt,
          workspaceKind: 'normal'
        });
      }
    });
    return result;
  }

  private syncSelectionState(): void {
    this.selectedSortMode = this.sortMode;
    this.selectedWorkspaceFilter = this.workspaceFilter;
    this.selectedAgentFilter = this.agentFilter;
    this.selectedStatusFilter = this.statusFilter;
  }

  private selectSortMode(mode: string): void {
    this.selectedSortMode = mode;
    this.selectionRevision += 1;
  }

  private selectWorkspaceFilter(value: string): void {
    RemoteLogger.info(`view-settings select workspace path=${value.length > 0 ? value : '<all>'}`);
    this.selectedWorkspaceFilter = value;
    this.selectionRevision += 1;
    this.onWorkspaceFilterChange(value);
  }

  private selectAgentFilter(value: string): void {
    this.selectedAgentFilter = value;
    this.selectionRevision += 1;
  }

  private selectStatusFilter(value: string): void {
    this.selectedStatusFilter = value;
    this.selectionRevision += 1;
  }

  private applySelectionAndClose(): void {
    RemoteLogger.info(`view-settings apply workspace=${this.selectedWorkspaceFilter.length > 0 ?
      this.selectedWorkspaceFilter : '<all>'}`);
    this.onSortModeChange(this.selectedSortMode);
    this.onWorkspaceFilterChange(this.selectedWorkspaceFilter);
    this.onAgentFilterChange(this.selectedAgentFilter);
    this.onStatusFilterChange(this.selectedStatusFilter);
    this.onClose();
  }

  private agentFilterOptions(): string[] {
    const values: string[] = [];
    this.sessions.forEach((session: RemoteSession) => {
      const value = this.agentGroup(session);
      if (value.length > 0 && values.indexOf(value) < 0) {
        values.push(value);
      }
    });
    return ['chat', 'code', 'cowork'].filter((value: string) => values.indexOf(value) >= 0);
  }

  private statusFilterOptions(): string[] {
    const values: string[] = [];
    this.sessions.forEach((session: RemoteSession) => {
      const value = (session.status || '').trim().toLowerCase();
      if (value.length > 0 && values.indexOf(value) < 0) {
        values.push(value);
      }
    });
    return values.sort();
  }

  private agentGroup(session: RemoteSession): string {
    const value = (session.agentType || '').toLowerCase();
    if (value === 'claw' || value === 'assistant' || value === 'chat' ||
      this.isAssistantWorkspace(session.workspacePath || '')) {
      return 'chat';
    }
    return value === 'cowork' ? 'cowork' : 'code';
  }

  private agentFilterLabel(value: string): string {
    if (value === 'chat') {
      return RemoteI18n.t('remote.newChat');
    }
    return value === 'cowork' ? 'Cowork' : 'Code';
  }

  private statusFilterLabel(value: string): string {
    if (value === 'active' || value === 'running') {
      return RemoteI18n.t('common.running');
    }
    if (value === 'ready' || value === 'idle') {
      return RemoteI18n.t('common.ready');
    }
    if (value === 'archived') {
      return RemoteI18n.t('sidebar.archived');
    }
    return value;
  }

  private basename(path: string): string {
    const parts = path.split('/');
    return parts.length > 0 ? parts[parts.length - 1] : path;
  }

  private isAssistantWorkspace(path: string): boolean {
    if (path.length === 0) {
      return this.workspaceKind.toLowerCase() === 'assistant';
    }
    if (path === this.workspacePath && this.workspaceKind.toLowerCase() === 'assistant') {
      return true;
    }
    return this.recentWorkspaces.some((item: RecentWorkspaceEntry) => {
      return item.path === path && item.workspaceKind.toLowerCase() === 'assistant';
    });
  }
}
