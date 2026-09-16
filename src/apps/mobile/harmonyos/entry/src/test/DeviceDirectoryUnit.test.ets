import { WorkspaceCatalog, mergeLegacyWorkspaces } from '../main/ets/services/WorkspaceCatalog';
import { describe, it, expect } from '@ohos/hypium';
import { AssistantEntry, RecentWorkspaceEntry, RemoteSession, SessionListResult } from '../main/ets/model/RemoteModels';
import { AccountDeviceDirectorySource } from '../main/ets/services/AccountDeviceDirectory';
import { CloudAccountDevice } from '../main/ets/services/CloudAccountClient';
import {
  mapInConcurrentBatches,
  mergeUniqueSessions
} from '../main/ets/services/ConcurrentWorkspaceListing';
import { DeviceDirectoryCoordinator } from '../main/ets/services/DeviceDirectoryCoordinator';
import { DeviceDirectoryViewModel } from '../main/ets/pages/viewmodel/DeviceDirectoryViewModel';
import { DeviceDirectoryState } from '../main/ets/pages/state/DeviceDirectoryState';
import { remoteSessionIdentity, stampRemoteSessionsDevice } from '../main/ets/services/RemoteSessionIdentity';
import { RemoteUiState } from '../main/ets/services/RemoteUiState';
import { FakeRemoteSessionListStore, remoteSession } from './LocalTestFixtures';

class FakeAccountDeviceDirectory implements AccountDeviceDirectorySource {
  listedDeviceIds: string[] = [];
  listedWorkspacePaths: string[] = [];
  workspacesByDevice: Map<string, RecentWorkspaceEntry[]> = new Map<string, RecentWorkspaceEntry[]>();
  assistantsByDevice: Map<string, AssistantEntry[]> = new Map<string, AssistantEntry[]>();
  sessionsByDevicePath: Map<string, RemoteSession[]> = new Map<string, RemoteSession[]>();
  failingDevices: string[] = [];
  failingPaths: string[] = [];

  async listWorkspaceCatalog(deviceId: string): Promise<WorkspaceCatalog> {
    const recent = await this.listRecentWorkspaces(deviceId);
    return { workspaces: mergeLegacyWorkspaces(recent, await this.listAssistants(deviceId)), recentWorkspaces: recent, source: 'recent' };
  }

  async listRecentWorkspaces(deviceId: string): Promise<RecentWorkspaceEntry[]> {
    this.listedDeviceIds.push(deviceId);
    if (this.failingDevices.includes(deviceId)) {
      throw new Error(`device unavailable: ${deviceId}`);
    }
    return this.workspacesByDevice.get(deviceId) || [];
  }

  async listAssistants(deviceId: string): Promise<AssistantEntry[]> {
    return this.assistantsByDevice.get(deviceId) || [];
  }

  async listSessions(deviceId: string, workspacePath: string): Promise<RemoteSession[]> {
    this.listedWorkspacePaths.push(`${deviceId}:${workspacePath}`);
    if (this.failingPaths.includes(`${deviceId}:${workspacePath}`)) {
      throw new Error(`workspace unavailable: ${workspacePath}`);
    }
    return this.sessionsByDevicePath.get(`${deviceId}:${workspacePath}`) || [];
  }
}

class GatedAccountDeviceDirectory extends FakeAccountDeviceDirectory {
  private releaseWorkspaceHold: () => void = () => {};
  private releaseSessionHold: () => void = () => {};
  private notifyWorkspacesListed: () => void = () => {};
  private readonly workspaceHold: Promise<void>;
  private readonly sessionHold: Promise<void>;
  readonly workspacesListed: Promise<void>;

  constructor() {
    super();
    this.workspaceHold = new Promise<void>((resolve: () => void) => {
      this.releaseWorkspaceHold = resolve;
    });
    this.sessionHold = new Promise<void>((resolve: () => void) => {
      this.releaseSessionHold = resolve;
    });
    this.workspacesListed = new Promise<void>((resolve: () => void) => {
      this.notifyWorkspacesListed = resolve;
    });
  }

  releaseWorkspaces(): void {
    this.releaseWorkspaceHold();
  }

  releaseSessions(): void {
    this.releaseSessionHold();
  }

  async listRecentWorkspaces(deviceId: string): Promise<RecentWorkspaceEntry[]> {
    await this.workspaceHold;
    return super.listRecentWorkspaces(deviceId);
  }

  async listSessions(deviceId: string, workspacePath: string): Promise<RemoteSession[]> {
    this.notifyWorkspacesListed();
    await this.sessionHold;
    return super.listSessions(deviceId, workspacePath);
  }
}

function workspace(path: string, name: string): RecentWorkspaceEntry {
  return { path, name, lastOpened: '', workspaceKind: 'normal' };
}

function sessionOn(deviceId: string, id: string, title: string): RemoteSession {
  const item = remoteSession(id, title);
  item.deviceId = deviceId;
  return item;
}

function sessionIn(deviceId: string, path: string, id: string, title: string): RemoteSession {
  const item = sessionOn(deviceId, id, title);
  item.workspacePath = path;
  return item;
}

export default function deviceDirectoryUnitTest() {
  describe('ConcurrentWorkspaceListing', () => {
    it('keeps merge order independent of batch width', 0, async () => {
      const paths: string[] = [];
      for (let index = 0; index < 9; index++) {
        paths.push(`/workspace-${index}`);
      }
      const wide = await mapInConcurrentBatches(paths, async (path: string): Promise<RemoteSession[]> => {
        return [remoteSession(`session-${path}`, path)];
      }, 4);
      const narrow = await mapInConcurrentBatches(paths, async (path: string): Promise<RemoteSession[]> => {
        return [remoteSession(`session-${path}`, path)];
      }, 2);
      const wideMerged = mergeUniqueSessions(wide);
      const narrowMerged = mergeUniqueSessions(narrow);
      expect(wideMerged.length).assertEqual(9);
      expect(narrowMerged.length).assertEqual(9);
      expect(wideMerged[0].id).assertEqual(narrowMerged[0].id);
      expect(wideMerged[4].id).assertEqual(narrowMerged[4].id);
      expect(wideMerged[8].id).assertEqual(narrowMerged[8].id);
    });

    it('keeps same-id sessions from two devices', 0, () => {
      const merged = mergeUniqueSessions([
        [sessionOn('desktop-a', 'shared', 'A')],
        [sessionOn('desktop-b', 'shared', 'B')]
      ]);
      expect(merged.length).assertEqual(2);
      expect(remoteSessionIdentity(merged[0])).assertEqual('desktop-a\u0001shared');
      expect(remoteSessionIdentity(merged[1])).assertEqual('desktop-b\u0001shared');
    });
  });

  describe('DeviceDirectoryCoordinator', () => {
    it('returns the other devices when one device cannot be listed', 0, async () => {
      const source = new FakeAccountDeviceDirectory();
      source.workspacesByDevice.set('desk-a', [workspace('/a', 'A')]);
      source.workspacesByDevice.set('desk-b', [workspace('/b', 'B')]);
      source.workspacesByDevice.set('desk-c', [workspace('/c', 'C')]);
      source.sessionsByDevicePath.set('desk-a:/a', [sessionOn('desk-a', 'a-1', 'A1')]);
      source.sessionsByDevicePath.set('desk-c:/c', [sessionOn('desk-c', 'c-1', 'C1')]);
      source.failingDevices = ['desk-b'];
      const results: RemoteSession[][] = [];
      const failures: string[] = [];
      const ids = ['desk-a', 'desk-b', 'desk-c'];
      for (let index = 0; index < ids.length; index++) {
        const deviceId = ids[index];
        try {
          const catalog = await new DeviceDirectoryCoordinator(source).loadDeviceCatalog(deviceId);
          results.push(catalog.sessions);
        } catch (_err) {
          failures.push(deviceId);
        }
      }
      expect(failures.length).assertEqual(1);
      expect(failures[0]).assertEqual('desk-b');
      expect(results.length).assertEqual(2);
      expect(results[0][0].id).assertEqual('a-1');
      expect(results[1][0].id).assertEqual('c-1');
    });

    it('keeps other workspaces when one workspace cannot be listed', 0, async () => {
      const source = new FakeAccountDeviceDirectory();
      source.workspacesByDevice.set('desk-a', [
        workspace('/one', 'One'),
        workspace('/two', 'Two'),
        workspace('/three', 'Three')
      ]);
      source.sessionsByDevicePath.set('desk-a:/one', [sessionOn('desk-a', 'one-session', 'One')]);
      source.sessionsByDevicePath.set('desk-a:/three', [sessionOn('desk-a', 'three-session', 'Three')]);
      source.failingPaths = ['desk-a:/two'];
      const catalog = await new DeviceDirectoryCoordinator(source).loadDeviceCatalog('desk-a');
      expect(catalog.sessions.length).assertEqual(2);
      expect(catalog.sessions[0].id).assertEqual('one-session');
      expect(catalog.sessions[1].id).assertEqual('three-session');
    });
  });

  describe('DeviceDirectoryState', () => {
    it('collapses only the device that is currently disclosed', 0, () => {
      const state = new DeviceDirectoryState();
      state.select('desk-a');
      expect(state.collapseIfSelected('desk-b')).assertFalse();
      expect(state.selectedDeviceId).assertEqual('desk-a');
      expect(state.collapseIfSelected('desk-a')).assertTrue();
      expect(state.selectedDeviceId).assertEqual('');
    });
  });

  describe('DeviceDirectoryViewModel', () => {
    it('selects a live QR device projected outside the account directory', 0, async () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'qr-desktop',
        activeDeviceConnected: () => true
      });

      await viewModel.selectDevice('qr-desktop');
      expect(state.selectedDeviceId).assertEqual('qr-desktop');

      // An account-directory refresh has no row for a scan-only target, but it
      // must not collapse the disclosure while that target is still connected.
      viewModel.syncDevices([]);
      expect(state.selectedDeviceId).assertEqual('qr-desktop');
    });

    it('does not issue RPC for an offline device', 0, async () => {
      let credentialCalls = 0;
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => {
          credentialCalls += 1;
          throw new Error('offline devices must not build a directory');
        },
        activeDeviceId: () => 'desk-active',
        activeDeviceConnected: () => false
      });
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-offline', deviceName: 'Offline', online: false }
      ]);
      await viewModel.selectDevice('desk-offline');
      expect(credentialCalls).assertEqual(0);
      expect(state.selectedDeviceId).assertEqual('desk-offline');
      expect(state.find('desk-offline')?.status).assertEqual('idle');
    });

    it('selects an offline control target without fetching it', 0, async () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-offline',
        activeDeviceConnected: () => false
      });
      viewModel.syncDevices([
        { deviceId: 'desk-offline', deviceName: 'Studio', online: false }
      ]);
      await viewModel.selectDevice('desk-offline');
      expect(state.find('desk-offline')?.deviceName).assertEqual('Studio');
      expect(state.selectedDeviceId).assertEqual('desk-offline');
      expect(state.find('desk-offline')?.status).assertEqual('idle');
    });

    it('keeps the selected device and its last known name when it goes offline', 0, () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-studio',
        activeDeviceConnected: () => false
      });
      viewModel.syncDevices([
        { deviceId: 'desk-studio', deviceName: 'Studio', online: true }
      ]);
      state.select('desk-studio');
      expect(state.selectedDeviceId).assertEqual('desk-studio');
      viewModel.syncDevices([
        { deviceId: 'desk-studio', deviceName: '', online: false }
      ]);
      expect(state.find('desk-studio')?.deviceName).assertEqual('Studio');
      expect(state.selectedDeviceId).assertEqual('desk-studio');
    });

    it('keeps the live conversation device online when the relay says otherwise', 0, () => {
      const state = new DeviceDirectoryState();
      let connected = true;
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-live',
        activeDeviceConnected: () => connected
      });
      // The relay's registry can lag or lose an entry while the desktop answers
      // every RPC we send it. First-hand evidence outranks that projection.
      viewModel.syncDevices([
        { deviceId: 'desk-live', deviceName: 'Studio', online: false },
        { deviceId: 'desk-other', deviceName: 'Other', online: false }
      ]);
      expect(state.find('desk-live')?.online).assertTrue();
      expect(state.selectedDeviceId).assertEqual('');
      // The override must not outlive the link it is based on, or a device that
      // really did go away keeps a lit row forever.
      expect(state.find('desk-other')?.online).assertFalse();
      connected = false;
      viewModel.syncDevices([
        { deviceId: 'desk-live', deviceName: 'Studio', online: false }
      ]);
      expect(state.find('desk-live')?.online).assertFalse();
      expect(state.selectedDeviceId).assertEqual('');
    });

    it('keeps an explicit device selection across syncDevices', 0, async () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-active',
        activeDeviceConnected: () => false
      });
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: true }
      ]);
      state.setWorkspaceExpanded('desk-other', '/workspace/project/', true);
      state.setWorkspaceStatus('desk-other', '/workspace/project', 'loading');
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: true }
      ]);
      expect(state.workspaceExpanded('desk-other', '/workspace/project')).assertTrue();
      expect(state.workspaceStatus('desk-other', '/workspace/project/')).assertEqual('loading');
      expect(state.selectedDeviceId).assertEqual('');
      await viewModel.selectDevice('desk-other');
      expect(state.selectedDeviceId).assertEqual('desk-other');
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: true }
      ]);
      expect(state.selectedDeviceId).assertEqual('desk-other');
      viewModel.refreshActive();
      expect(state.selectedDeviceId).assertEqual('desk-other');
    });

    it('selects a directory row without replacing its entry instance', 0, async () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-active',
        activeDeviceConnected: () => false
      });
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: false }
      ]);
      const before = state.find('desk-other');
      await viewModel.selectDevice('desk-other');
      expect(state.find('desk-other') === before).assertTrue();
      expect(state.selectedDeviceId).assertEqual('desk-other');
    });

    it('marks an online device loading before its catalog returns', 0, async () => {
      const source = new GatedAccountDeviceDirectory();
      source.workspacesByDevice.set('desk-other', [workspace('/other', 'Other')]);
      source.sessionsByDevicePath.set('desk-other:/other', [sessionOn('desk-other', 's1', 'S1')]);
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-active',
        activeDeviceConnected: () => false
      }, undefined, source);
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: true }
      ]);
      const pending = viewModel.selectDevice('desk-other');
      expect(state.selectedDeviceId).assertEqual('desk-other');
      expect(state.find('desk-other')?.status).assertEqual('loading');
      expect(state.find('desk-other')?.workspaces.length).assertEqual(0);
      source.releaseWorkspaces();
      source.releaseSessions();
      await pending;
      expect(state.find('desk-other')?.status).assertEqual('ready');
      expect(state.find('desk-other')?.workspaces.length).assertEqual(1);
      expect(state.find('desk-other')?.sessions.length).assertEqual(0);
      expect(source.listedWorkspacePaths.length).assertEqual(0);
    });

    it('loads only the workspace whose disclosure was opened', 0, async () => {
      const source = new GatedAccountDeviceDirectory();
      source.workspacesByDevice.set('desk-other', [
        workspace('/other', 'Other'),
        workspace('/sibling', 'Sibling')
      ]);
      source.sessionsByDevicePath.set('desk-other:/other', [sessionOn('desk-other', 's1', 'S1')]);
      source.sessionsByDevicePath.set('desk-other:/sibling', [sessionOn('desk-other', 's2', 'S2')]);
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-active',
        activeDeviceConnected: () => false
      }, undefined, source);
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: true }
      ]);
      const catalogPending = viewModel.selectDevice('desk-other');
      source.releaseWorkspaces();
      await catalogPending;
      expect(state.find('desk-other')?.status).assertEqual('ready');
      expect(state.find('desk-other')?.workspaces.length).assertEqual(2);
      expect(state.find('desk-other')?.sessions.length).assertEqual(0);

      const sessionPending = viewModel.loadWorkspaceSessions('desk-other', '/other');
      await source.workspacesListed;
      expect(source.listedWorkspacePaths.length).assertEqual(0);
      source.releaseSessions();
      await sessionPending;
      expect(source.listedWorkspacePaths.length).assertEqual(1);
      expect(source.listedWorkspacePaths[0]).assertEqual('desk-other:/other');
      expect(state.find('desk-other')?.sessions[0].id).assertEqual('s1');
      expect(state.find('desk-other')?.sessions[0].workspacePath || '').assertEqual('/other');
    });

    it('does not move the cold-start last-device pointer when persisting an observed catalog', 0, async () => {
      const store = new FakeRemoteSessionListStore();
      await store.saveList('desk-active', [sessionOn('desk-active', 'live', 'Live')], false);
      const source = new FakeAccountDeviceDirectory();
      source.workspacesByDevice.set('desk-other', [workspace('/other', 'Other')]);
      source.sessionsByDevicePath.set('desk-other:/other', [sessionOn('desk-other', 's1', 'S1')]);
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-active',
        activeDeviceConnected: () => false
      }, store, source);
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: true }
      ]);
      await viewModel.selectDevice('desk-other');
      await viewModel.loadWorkspaceSessions('desk-other', '/other');
      expect(state.find('desk-other')?.status).assertEqual('ready');
      expect(store.lists.get('desk-other')?.sessions.length).assertEqual(1);
      expect(store.lastDeviceKey).assertEqual('desk-active');
    });

    it('treats a hydrated catalog as cached and still fetches on selection', 0, async () => {
      const store = new FakeRemoteSessionListStore();
      await store.saveWorkspaces('desk-other', [workspace('/cached', 'Cached')]);
      await store.saveObservedList('desk-other', [sessionOn('desk-other', 'cached', 'Cached')], false);
      const source = new FakeAccountDeviceDirectory();
      source.workspacesByDevice.set('desk-other', [workspace('/live', 'Live')]);
      source.sessionsByDevicePath.set('desk-other:/live', [sessionOn('desk-other', 'live', 'Live')]);
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-active',
        activeDeviceConnected: () => false
      }, store, source);
      viewModel.syncDevices([
        { deviceId: 'desk-active', deviceName: 'Active', online: true },
        { deviceId: 'desk-other', deviceName: 'Other', online: true }
      ]);
      await viewModel.hydrateKnownDevices();
      expect(state.find('desk-other')?.status).assertEqual('cached');
      expect(state.find('desk-other')?.workspaces[0].path).assertEqual('/cached');
      expect(source.listedDeviceIds.length).assertEqual(0);
      await viewModel.selectDevice('desk-other');
      expect(source.listedDeviceIds.length).assertEqual(1);
      expect(source.listedDeviceIds[0]).assertEqual('desk-other');
      expect(state.find('desk-other')?.status).assertEqual('ready');
      expect(state.find('desk-other')?.workspaces[0].path).assertEqual('/live');
      await viewModel.loadWorkspaceSessions('desk-other', '/live');
      expect(state.find('desk-other')?.sessions[0].id).assertEqual('live');
    });

    it('keeps a captured live catalog after the device is no longer the control target', 0, async () => {
      let activeId = 'desk-a';
      const source = new FakeAccountDeviceDirectory();
      source.workspacesByDevice.set('desk-a', [workspace('/gone', 'Gone')]);
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => activeId,
        activeDeviceConnected: () => false
      }, undefined, source);
      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'Alpha', online: true },
        { deviceId: 'desk-b', deviceName: 'Beta', online: true }
      ]);
      expect(state.find('desk-a')?.status).assertEqual('idle');
      viewModel.captureLive(
        'desk-a',
        [workspace('/a', 'A')],
        [sessionOn('desk-a', 'a-1', 'A1')]
      );
      activeId = 'desk-b';
      viewModel.refreshActive();
      expect(state.find('desk-a')?.status).assertEqual('ready');
      expect(state.find('desk-a')?.sessions[0].id).assertEqual('a-1');
      expect(state.find('desk-a')?.workspaces[0].path).assertEqual('/a');
      await viewModel.selectDevice('desk-a');
      expect(state.selectedDeviceId).assertEqual('desk-a');
      expect(source.listedDeviceIds.length).assertEqual(0);
      expect(state.find('desk-a')?.sessions[0].id).assertEqual('a-1');
    });

    it('does not overwrite a captured catalog with an empty teardown snapshot', 0, () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-a',
        activeDeviceConnected: () => false
      });
      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'Alpha', online: true }
      ]);
      viewModel.captureLive('desk-a', [workspace('/a', 'A')], [sessionOn('desk-a', 'a-1', 'A1')]);
      viewModel.captureLive('desk-a', [], []);
      expect(state.find('desk-a')?.sessions.length).assertEqual(1);
      expect(state.find('desk-a')?.workspaces.length).assertEqual(1);
    });

    it('replaces a stale catalog when a device becomes the live target', 0, () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-b',
        activeDeviceConnected: () => true
      });
      viewModel.syncDevices([
        { deviceId: 'desk-b', deviceName: 'Beta', online: true }
      ]);
      viewModel.captureLive('desk-b', [workspace('/wrong', 'Wrong')], [
        sessionOn('desk-b', 'cached', 'Cached')
      ]);

      viewModel.activateLive('desk-b', [], [sessionOn('desk-b', 'fresh', 'Fresh')]);

      expect(state.find('desk-b')?.workspaces.length).assertEqual(0);
      expect(state.find('desk-b')?.sessions.some((item: RemoteSession): boolean => item.id === 'fresh')).assertTrue();
      expect(state.find('desk-b')?.sessions.some((item: RemoteSession): boolean => item.id === 'cached')).assertFalse();
      expect(state.find('desk-b')?.status).assertEqual('loading');
    });

    it('invalidates workspace load state when the same device gets a fresh connection', 0, () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-a',
        activeDeviceConnected: () => true
      });
      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'Alpha', online: true },
        { deviceId: 'desk-b', deviceName: 'Beta', online: true }
      ]);
      state.setWorkspaceExpanded('desk-a', '/stale', true);
      state.setWorkspaceStatus('desk-a', '/stale', 'ready');
      state.setWorkspaceExpanded('desk-b', '/independent', true);
      state.setWorkspaceStatus('desk-b', '/independent', 'ready');
      viewModel.captureLive('desk-a', [workspace('/stale', 'Stale')], [
        sessionIn('desk-a', '/stale', 'stale', 'Stale')
      ]);

      // Models the scan-room -> account-device transition: the physical
      // desktop id is unchanged, while the new handshake only carries the
      // current workspace snapshot.
      viewModel.activateLive('desk-a', [workspace('/current', 'Current')], [
        sessionIn('desk-a', '/current', 'fresh', 'Fresh')
      ]);

      expect(state.workspaceExpanded('desk-a', '/stale')).assertFalse();
      expect(state.workspaceStatus('desk-a', '/stale')).assertEqual('idle');
      expect(state.workspaceExpanded('desk-b', '/independent')).assertTrue();
      expect(state.workspaceStatus('desk-b', '/independent')).assertEqual('ready');
      expect(state.find('desk-a')?.sessions.length).assertEqual(1);
      expect(state.find('desk-a')?.sessions[0].id).assertEqual('fresh');
    });

    it('keeps an empty incoming catalog loading until the live request completes', 0, async () => {
      const source = new FakeAccountDeviceDirectory();
      const state = new DeviceDirectoryState();
      let activeId = 'desk-a';
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => activeId,
        activeDeviceConnected: () => true
      }, undefined, source);
      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'Alpha', online: true },
        { deviceId: 'desk-b', deviceName: 'Beta', online: true }
      ]);

      // A completed side-channel lookup may legitimately be empty, but it is
      // not the authoritative catalog of the target that is about to connect.
      await viewModel.selectDevice('desk-b');
      expect(state.find('desk-b')?.status).assertEqual('ready');
      expect(state.find('desk-b')?.workspaces.length).assertEqual(0);

      viewModel.beginLiveCatalog('desk-b');
      activeId = 'desk-b';
      viewModel.activateLive('desk-b', [], [sessionOn('desk-b', 'fresh', 'Fresh')]);
      expect(state.find('desk-b')?.status).assertEqual('loading');

      viewModel.completeLiveCatalog('desk-b', [workspace('/mac/OpenBitFun', 'OpenBitFun')]);
      expect(state.find('desk-b')?.status).assertEqual('ready');
      expect(state.find('desk-b')?.workspaces[0].path).assertEqual('/mac/OpenBitFun');
    });

    it('releases the abandoned loading owner during rapid target switches', 0, () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => '',
        activeDeviceConnected: () => false
      });
      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'Alpha', online: true },
        { deviceId: 'desk-b', deviceName: 'Beta', online: true }
      ]);
      viewModel.captureLive('desk-a', [workspace('/a', 'A')], []);

      viewModel.beginLiveCatalog('desk-a');
      expect(state.find('desk-a')?.status).assertEqual('loading');
      viewModel.beginLiveCatalog('desk-b');

      expect(state.find('desk-a')?.status).assertEqual('cached');
      expect(state.find('desk-b')?.status).assertEqual('loading');
    });

    it('refreshes one live workspace without dropping cached siblings', 0, () => {
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-a',
        activeDeviceConnected: () => true
      });
      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'Alpha', online: true }
      ]);
      viewModel.captureLive('desk-a', [workspace('/a', 'A'), workspace('/b', 'B')], [
        sessionIn('desk-a', '/a', 'a-old', 'Old A'),
        sessionIn('desk-a', '/b', 'b-cached', 'Cached B')
      ]);
      viewModel.captureWorkspaceSessions('desk-a', '/a', [
        sessionIn('desk-a', '/a', 'a-new', 'New A')
      ]);
      const sessions = state.find('desk-a')?.sessions || [];
      expect(sessions.length).assertEqual(2);
      expect(sessions.some((item: RemoteSession): boolean => item.id === 'a-old')).assertFalse();
      expect(sessions.some((item: RemoteSession): boolean => item.id === 'a-new')).assertTrue();
      expect(sessions.some((item: RemoteSession): boolean => item.id === 'b-cached')).assertTrue();
    });

    it('refreshes ready cached branches only on the selected online device', 0, async () => {
      const source = new FakeAccountDeviceDirectory();
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => '',
        activeDeviceConnected: () => false
      }, undefined, source);
      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'A', online: true },
        { deviceId: 'desk-b', deviceName: 'B', online: true }
      ]);
      state.select('desk-a');
      state.setWorkspaceExpanded('desk-a', '/open', true);
      state.setWorkspaceExpanded('desk-a', '/closed', false);
      state.setWorkspaceExpanded('desk-b', '/open', true);
      state.setWorkspaceStatus('desk-a', '/open', 'ready');
      viewModel.captureWorkspaceSessions('desk-a', '/open', [sessionIn('desk-a', '/open', 'old', 'Old')]);
      viewModel.captureWorkspaceSessions('desk-a', '/closed', [sessionIn('desk-a', '/closed', 'sibling', 'Sibling')]);
      source.sessionsByDevicePath.set('desk-a:/open', [
        sessionIn('desk-a', '/open', 'new', 'New'), sessionIn('desk-a', '/open', 'old', 'Old')
      ]);
      await viewModel.refreshExpandedWorkspaceSessions();
      expect(source.listedWorkspacePaths.length).assertEqual(1);
      expect(source.listedWorkspacePaths[0]).assertEqual('desk-a:/open');
      expect(state.find('desk-a')?.sessions.length).assertEqual(3);
      expect(state.find('desk-a')?.sessions[0].id).assertEqual('new');
      expect(state.workspaceExpanded('desk-a', '/open')).assertTrue();
      expect(state.workspaceStatus('desk-a', '/open')).assertEqual('ready');

      viewModel.syncDevices([
        { deviceId: 'desk-a', deviceName: 'A', online: false },
        { deviceId: 'desk-b', deviceName: 'B', online: true }
      ]);
      await viewModel.refreshExpandedWorkspaceSessions();
      expect(source.listedWorkspacePaths.length).assertEqual(1);
    });

    it('preserves cached rows on failure and replaces them with a successful empty list', 0, async () => {
      const source = new FakeAccountDeviceDirectory();
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined, activeDeviceId: () => '', activeDeviceConnected: () => false
      }, undefined, source);
      viewModel.syncDevices([{ deviceId: 'desk-a', deviceName: 'A', online: true }]);
      state.select('desk-a');
      state.setWorkspaceExpanded('desk-a', '/a', true);
      viewModel.captureWorkspaceSessions('desk-a', '/a', [sessionIn('desk-a', '/a', 'old', 'Old')]);
      source.failingPaths = ['desk-a:/a'];
      await viewModel.refreshExpandedWorkspaceSessions();
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('failed');
      expect(state.workspaceHasLoadedSessions('desk-a', '/a')).assertFalse();
      expect(state.find('desk-a')?.sessions[0].id).assertEqual('old');
      source.failingPaths = [];
      await viewModel.loadWorkspaceSessions('desk-a', '/a');
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('ready');
      expect(state.find('desk-a')?.sessions.length).assertEqual(0);
      expect(state.workspaceHasLoadedSessions('desk-a', '/a')).assertTrue();
    });

    it('joins simultaneous refreshes without clearing the visible cache', 0, async () => {
      const source = new GatedAccountDeviceDirectory();
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined, activeDeviceId: () => '', activeDeviceConnected: () => false
      }, undefined, source);
      viewModel.syncDevices([{ deviceId: 'desk-a', deviceName: 'A', online: true }]);
      viewModel.captureWorkspaceSessions('desk-a', '/a', [sessionIn('desk-a', '/a', 'old', 'Old')]);
      const first = viewModel.loadWorkspaceSessions('desk-a', '/a');
      await source.workspacesListed;
      const second = viewModel.loadWorkspaceSessions('desk-a', '/a');
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('loading');
      expect(state.find('desk-a')?.sessions[0].id).assertEqual('old');
      source.releaseSessions();
      await Promise.all([first, second]);
      expect(source.listedWorkspacePaths.length).assertEqual(1);
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('ready');
      expect(state.workspaceHasLoadedSessions('desk-a', '/a')).assertTrue();
    });

    it('discards an old directory request after account state is replaced', 0, async () => {
      const source = new GatedAccountDeviceDirectory();
      const state = new DeviceDirectoryState();
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined, activeDeviceId: () => '', activeDeviceConnected: () => false
      }, undefined, source);
      const devices: CloudAccountDevice[] = [{ deviceId: 'desk-a', deviceName: 'A', online: true }];
      viewModel.syncDevices(devices);
      source.sessionsByDevicePath.set('desk-a:/a', [sessionIn('desk-a', '/a', 'late', 'Late')]);
      const pending = viewModel.loadWorkspaceSessions('desk-a', '/a');
      await source.workspacesListed;
      state.clear();
      viewModel.syncDevices(devices);
      source.releaseSessions();
      await pending;
      expect(state.find('desk-a')?.sessions.length).assertEqual(0);
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('idle');
    });

    it('publishes the live workspace page with its pagination state', 0, async () => {
      const state = new DeviceDirectoryState();
      const published: SessionListResult[] = [];
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-a',
        activeDeviceConnected: () => true,
        loadActiveWorkspaceSessions: async (path: string): Promise<SessionListResult> => {
          return { sessions: [sessionIn('desk-a', path, 'new', 'New')], hasMore: true };
        },
        onActiveWorkspaceSessions: (_path: string, page: SessionListResult): void => { published.push(page); }
      });
      // A live target may be visible without an account-directory row.
      state.select('desk-a');
      state.setWorkspaceExpanded('desk-a', '/a', true);
      await viewModel.refreshExpandedWorkspaceSessions();
      expect(published.length).assertEqual(1);
      expect(published[0].sessions[0].id).assertEqual('new');
      expect(published[0].hasMore).assertTrue();
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('ready');
    });

    it('does not publish live results after switching the control target', 0, async () => {
      const state = new DeviceDirectoryState();
      let activeId = 'desk-a';
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve: () => void) => { release = resolve; });
      let published = 0;
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => activeId,
        activeDeviceConnected: () => true,
        loadActiveWorkspaceSessions: async (): Promise<SessionListResult> => {
          await hold;
          return { sessions: [sessionIn('desk-a', '/a', 'late', 'Late')], hasMore: false };
        },
        onActiveWorkspaceSessions: (): void => { published++; }
      });
      const pending = viewModel.loadWorkspaceSessions('desk-a', '/a');
      activeId = 'desk-b';
      release();
      await pending;
      expect(published).assertEqual(0);
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('idle');
    });

    it('keeps a late previous-connection response out of the new workspace generation', 0, async () => {
      const state = new DeviceDirectoryState();
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve: () => void) => { release = resolve; });
      let requests = 0;
      const published: string[] = [];
      const viewModel = new DeviceDirectoryViewModel(state, {
        credentials: () => undefined,
        activeDeviceId: () => 'desk-a',
        activeDeviceConnected: () => true,
        loadActiveWorkspaceSessions: async (): Promise<SessionListResult> => {
          const index = ++requests;
          if (index === 1) await hold;
          return { sessions: [sessionIn('desk-a', '/a', `${index}`, 'Page')], hasMore: false };
        },
        onActiveWorkspaceSessions: (_path: string, result: SessionListResult): void => {
          published.push(result.sessions[0].id);
        }
      });
      const old = viewModel.loadWorkspaceSessions('desk-a', '/a');
      state.resetWorkspaceDirectory('desk-a');
      await viewModel.loadWorkspaceSessions('desk-a', '/a');
      release();
      await old;
      expect(published.length).assertEqual(1);
      expect(published[0]).assertEqual('2');
      expect(state.workspaceStatus('desk-a', '/a')).assertEqual('ready');
    });
  });

  describe('RemoteSessionIdentity', () => {
    it('keeps same-id sessions from two devices when merging UI lists', 0, () => {
      const merged = RemoteUiState.mergeSessions(
        [sessionOn('desk-a', 'shared', 'A')],
        [sessionOn('desk-b', 'shared', 'B')]
      );
      expect(merged.length).assertEqual(2);
      expect(merged[0].deviceId || '').assertEqual('desk-a');
      expect(merged[1].deviceId || '').assertEqual('desk-b');
    });

    it('collapses a stamped current session with an unstamped extra of the same id', 0, () => {
      const current = [sessionOn('desk-a', 'shared', 'Live')];
      const extras = [remoteSession('shared', 'Discovered')];
      expect(RemoteUiState.mergeSessions(current, extras).length).assertEqual(2);
      const merged = RemoteUiState.mergeSessions(current, stampRemoteSessionsDevice(extras, 'desk-a'));
      expect(merged.length).assertEqual(1);
      expect(merged[0].deviceId || '').assertEqual('desk-a');
    });
  });
}
