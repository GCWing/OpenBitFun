import { RecentWorkspaceEntry, WorkspaceInfo } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RemoteLogger } from '../../services/RemoteLogger';
import { RemoteWorkspaceCoordinator } from '../../services/RemoteWorkspaceCoordinator';
import { RemotePageState } from '../state/RemotePageState';

export interface RemoteWorkspaceViewModelHooks {
  readonly isRemoteAvailable: () => boolean;
  /** Stable owner of the current remote catalog; empty while no target owns it. */
  readonly remoteTargetId: () => string;
  readonly isBusy: () => boolean;
  readonly onBusy: (isBusy: boolean) => void;
  readonly onStatus: (statusText: string) => void;
  readonly onWorkspaceSelected: (workspace: WorkspaceInfo) => void;
  readonly onCatalogLoading: (targetId: string) => void;
  readonly onCatalogLoaded: (targetId: string, workspaces: RecentWorkspaceEntry[], source?: string, recentWorkspaces?: RecentWorkspaceEntry[]) => void;
  readonly onCatalogFailed: (targetId: string) => void;
  readonly onRefreshSessions: () => Promise<void>;
  readonly onConnectionFailure: (error: Object) => void;
}

/** Owns the workspace/assistant picker workflows and their presentation state. */
export class RemoteWorkspaceViewModel {
  private readonly pageState: RemotePageState;
  private readonly coordinator: RemoteWorkspaceCoordinator;
  private readonly hooks: RemoteWorkspaceViewModelHooks;
  private catalogLoadVersion: number = 0;
  // Background catalog invalidation must not cancel a foreground picker's
  // result/finally, and opening a picker must not abandon sidebar loading.
  private pickerLoadVersion: number = 0;

  constructor(
    pageState: RemotePageState,
    coordinator: RemoteWorkspaceCoordinator,
    hooks: RemoteWorkspaceViewModelHooks
  ) {
    this.pageState = pageState;
    this.coordinator = coordinator;
    this.hooks = hooks;
  }

  async toggleRecentWorkspaces(): Promise<void> {
    if (this.pageState.showWorkspacePicker) {
      this.pageState.setWorkspacePickerVisible(false);
      return;
    }
    this.pageState.setWorkspacePickerVisible(true);
    this.pageState.setAssistantPickerVisible(false);
    await this.loadRecentWorkspaces();
  }

  async toggleAssistants(): Promise<void> {
    if (this.pageState.showAssistantPicker) {
      this.pageState.setAssistantPickerVisible(false);
      return;
    }
    this.pageState.setAssistantPickerVisible(true);
    this.pageState.setWorkspacePickerVisible(false);
    await this.loadAssistants();
  }

  async selectWorkspace(path: string, connectionId?: string, sshHost?: string, workspaceId?: string): Promise<boolean> {
    return await this.select(path, false, connectionId, sshHost, workspaceId);
  }

  async selectAssistant(path: string, workspaceId?: string): Promise<boolean> {
    return await this.select(path, true, undefined, undefined, workspaceId);
  }

  async loadRecentWorkspacesInBackground(propagateFailure: boolean = false): Promise<void> {
    const loadVersion = ++this.catalogLoadVersion;
    const targetId = this.hooks.remoteTargetId();
    if (targetId.length === 0) {
      return;
    }
    this.hooks.onCatalogLoading(targetId);
    try {
      if (this.pageState.savedConnectionsTargetId !== targetId) {
        this.pageState.savedConnections = [];
        this.pageState.savedConnectionsTargetId = '';
      }
      try {
        const saved = await this.coordinator.savedConnections();
        if (this.isCurrentCatalogLoad(loadVersion, targetId)) {
          this.pageState.savedConnections = saved;
          this.pageState.savedConnectionsTargetId = targetId;
        }
      } catch (error) {
        if (this.isCurrentCatalogLoad(loadVersion, targetId)) this.hooks.onConnectionFailure(error);
      }
      // The coordinator follows the selected runtime. A superseded request
      // must not issue its next operation against a newly selected device.
      if (!this.isCurrentCatalogLoad(loadVersion, targetId)) return;
      const catalog = await this.coordinator.workspaceCatalog();
      if (!this.isCurrentCatalogLoad(loadVersion, targetId)) return;
      const allWorkspaces = catalog.workspaces;
      this.pageState.setRecentWorkspaces(catalog.recentWorkspaces);
      this.hooks.onCatalogLoaded(targetId, allWorkspaces, catalog.source, catalog.recentWorkspaces);
      RemoteLogger.info(
        `workspace catalog loaded target=${targetId} count=${allWorkspaces.length} first=${allWorkspaces.length > 0 ? allWorkspaces[0].path : ''}`
      );
    } catch (err) {
      if (this.isCurrentCatalogLoad(loadVersion, targetId)) {
        this.hooks.onCatalogFailed(targetId);
      }
      RemoteLogger.warn(`background recent workspace load failed: ${String(err)}`);
      if (propagateFailure && this.isCurrentCatalogLoad(loadVersion, targetId)) throw new Error(String(err));
    }
  }

  private async loadRecentWorkspaces(): Promise<void> {
    if (!this.hooks.isRemoteAvailable()) {
      return;
    }
    const loadVersion = ++this.pickerLoadVersion;
    const targetId = this.hooks.remoteTargetId();
    try {
      this.hooks.onBusy(true);
      this.hooks.onStatus(RemoteI18n.t('status.loadingRecentWorkspaces'));
      const recent = await this.coordinator.recentWorkspaces();
      if (!this.isCurrentPickerLoad(loadVersion, targetId)) {
        return;
      }
      this.pageState.setRecentWorkspaces(recent);
      this.hooks.onStatus(recent.length > 0 ?
        RemoteI18n.t('status.chooseWorkspace') : RemoteI18n.t('status.noRecentWorkspaces'));
    } catch (err) {
      if (this.isCurrentPickerLoad(loadVersion, targetId)) {
        this.hooks.onConnectionFailure(err);
      }
    } finally {
      if (this.isCurrentPickerLoad(loadVersion, targetId)) {
        this.hooks.onBusy(false);
      }
    }
  }

  private isCurrentCatalogLoad(loadVersion: number, targetId: string): boolean {
    return targetId.length > 0 &&
      loadVersion === this.catalogLoadVersion &&
      targetId === this.hooks.remoteTargetId();
  }

  private isCurrentPickerLoad(loadVersion: number, targetId: string): boolean {
    return targetId.length > 0 && loadVersion === this.pickerLoadVersion && targetId === this.hooks.remoteTargetId();
  }

  private async loadAssistants(): Promise<void> {
    if (!this.hooks.isRemoteAvailable()) {
      return;
    }
    const loadVersion = ++this.pickerLoadVersion;
    const targetId = this.hooks.remoteTargetId();
    try {
      this.hooks.onBusy(true);
      this.hooks.onStatus(RemoteI18n.t('status.loadingAssistants'));
      const assistants = await this.coordinator.assistants();
      if (!this.isCurrentPickerLoad(loadVersion, targetId)) {
        return;
      }
      this.pageState.setAssistants(assistants);
      this.hooks.onStatus(assistants.length > 0 ?
        RemoteI18n.t('status.chooseAssistant') : RemoteI18n.t('status.noAssistants'));
    } catch (err) {
      if (this.isCurrentPickerLoad(loadVersion, targetId)) {
        this.hooks.onConnectionFailure(err);
      }
    } finally {
      if (this.isCurrentPickerLoad(loadVersion, targetId)) {
        this.hooks.onBusy(false);
      }
    }
  }

  private async select(path: string, assistant: boolean, connectionId?: string, sshHost?: string, workspaceId?: string): Promise<boolean> {
    // A reference is complete with either its ID or, for pre-ID rows, its path.
    const id = workspaceId?.trim() || undefined;
    if (this.hooks.isBusy() || (path.trim().length === 0 && id === undefined) || !this.hooks.isRemoteAvailable()) {
      return false;
    }
    try {
      this.hooks.onBusy(true);
      this.hooks.onStatus(RemoteI18n.t(assistant ?
        'status.switchingAssistant' : 'status.switchingWorkspace'));
      const workspace = assistant ?
        await this.coordinator.switchAssistant(path, id) : await this.coordinator.switchWorkspace(path, connectionId, sshHost, id);
      this.hooks.onWorkspaceSelected(workspace);
      this.pageState.closePickers();
      this.pageState.clear();
      this.hooks.onStatus(RemoteI18n.t(assistant ?
        'status.assistantSwitched' : 'status.workspaceSwitched'));
      this.hooks.onBusy(false);
      await this.hooks.onRefreshSessions();
      return true;
    } catch (err) {
      this.hooks.onConnectionFailure(err);
      this.hooks.onBusy(false);
      return false;
    }
  }
}
