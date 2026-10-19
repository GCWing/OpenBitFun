import { RecentWorkspaceEntry, RemoteSession } from '../../model/RemoteModels';
import { RecentRemoteHome } from '../components/RecentRemoteHome';
import { RemoteSessionList } from '../components/RemoteSessionList';
import { SidebarDeviceGroup } from '../components/SidebarDeviceGroup';
import { SidebarWorkspacePicker } from '../components/SidebarWorkspacePicker';
import { INK, PAGE_BG } from '../components/Theme';
import { DeviceDirectoryState, emptyDeviceDirectoryEntry } from '../state/DeviceDirectoryState';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { AdaptiveLayoutInput } from '../policy/AdaptiveLayoutInput';
import { ConversationLayoutPolicy } from '../policy/ConversationLayoutPolicy';
import { WideLayoutGeometry } from '../layout/WideLayoutGeometry';

/** Same-ID replacement fixture. No account, persistence, or remote requests. */
@ComponentV2
export struct CatalogRefreshPreview {
  @Local directory: DeviceDirectoryState = this.makeDirectory();
  @Local sessions: RemoteSession[] = this.makeSessions(false);
  @Local mode: number = 0;
  @Local selected: string = '';
  /**
   * The session list's own sheet — the row actions menu — is placed by the window
   * it opens in, exactly as the app root places it: a bottom sheet on a phone, a
   * short centered dialog on a tablet. The fixture pins no placement of its own,
   * so it resolves the same answer its production host would for this window.
   */
  @Local sessionDetailsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.SessionDetails);

  private workspaces(updated: boolean): RecentWorkspaceEntry[] {
    return [{ workspaceId: 'preview-workspace', path: updated ? '/preview-after' : '/preview', name: updated ? 'Workspace after' : 'Workspace before',
      lastOpened: '', workspaceKind: 'normal' }];
  }

  private makeSessions(updated: boolean): RemoteSession[] {
    return [{ id: 'preview-session', deviceId: 'preview-device', title: updated ? 'Session after' : 'Session before',
      agentType: 'code', status: updated ? 'completed' : 'idle', messageCount: updated ? 2 : 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspacePath: updated ? '/preview-after' : '/preview',
      workspaceName: updated ? 'Workspace after' : 'Workspace before',
      workspaceIdentity: { workspaceId: 'preview-workspace', path: updated ? '/preview-after' : '/preview' } }];
  }

  private makeDirectory(): DeviceDirectoryState {
    const state = new DeviceDirectoryState();
    const device = emptyDeviceDirectoryEntry('preview-device', 'Preview host', true);
    device.workspaces = this.workspaces(false);
    device.sessions = this.makeSessions(false);
    device.status = 'ready';
    state.replace([device]);
    state.setWorkspaceExpanded(device.deviceId, '/preview', true, undefined, undefined, 'preview-workspace');
    state.workspaceLoadState(device.deviceId, '/preview', undefined, undefined, 'preview-workspace').hasLoadedSessions = true;
    return state;
  }

  /** The app root's own placement input for this window; the fixture has no creases. */
  private refreshPlacements(width: number, height: number): void {
    const input = new AdaptiveLayoutInput(
      width,
      height,
      0,
      false,
      false,
      false,
      width >= ConversationLayoutPolicy.MD_MIN_WIDTH,
      [],
      []
    );
    this.sessionDetailsPlacement = SettingsPlacementPolicy.resolve(
      input,
      SettingsSheetKind.SessionDetails
    );
  }

  build() {
    Column() {
      Row() {
        Button('Sidebar').id('catalog-sidebar').onClick(() => { this.mode = 0; })
        Button('Recent').id('catalog-recent').onClick(() => { this.mode = 1; })
        Button('All').id('catalog-all').onClick(() => { this.mode = 2; })
      }
      Row() {
        Button('Projects').id('catalog-projects').onClick(() => { this.mode = 3; })
        Button('Picker').id('catalog-picker').onClick(() => { this.mode = 4; })
      }
      Button('Replace same IDs').id('catalog-replace').onClick(() => {
        this.directory.devices[0].workspaces = this.workspaces(true);
        this.sessions = this.makeSessions(true);
        this.directory.devices[0].sessions = this.sessions;
      })
      Text(`Source: ${this.sessions[0].title}`).id('catalog-source').fontColor(INK)
      Text(this.selected).id('catalog-selected').fontColor(INK)
      if (this.mode === 0) {
        SidebarDeviceGroup({ device: this.directory.devices[0], directoryState: this.directory, sessions: this.sessions,
          onOpenSession: (session: RemoteSession): void => { this.selected = session.title; } })
      } else if (this.mode === 1) {
        RecentRemoteHome({ connected: true, sessions: this.sessions,
          onOpen: (session: RemoteSession): void => { this.selected = session.title; } })
          .layoutWeight(1)
      } else if (this.mode === 2) {
        RemoteSessionList({ sessions: this.sessions, sortMode: 'time', showStatusMetadata: true,
          sessionDetailsPlacement: this.sessionDetailsPlacement,
          onOpenSession: (session: RemoteSession): void => { this.selected = session.title; } })
          .layoutWeight(1)
      } else if (this.mode === 3) {
        RemoteSessionList({ sessions: this.sessions, recentWorkspaces: this.directory.devices[0].workspaces,
          sessionDetailsPlacement: this.sessionDetailsPlacement,
          onOpenSession: (session: RemoteSession): void => { this.selected = session.title; } })
          .layoutWeight(1)
      } else {
        SidebarWorkspacePicker({ workspaces: this.directory.devices[0].workspaces,
          onSelectWorkspace: (path: string): void => { this.selected = path; } })
          .layoutWeight(1)
      }
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      this.refreshPlacements(
        WideLayoutGeometry.areaLength(newArea.width),
        WideLayoutGeometry.areaLength(newArea.height)
      );
    })
  }
}
