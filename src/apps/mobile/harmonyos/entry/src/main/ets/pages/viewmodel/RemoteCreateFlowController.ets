import { RemoteSession, SessionSummary } from '../../model/RemoteModels';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RemoteLogger } from '../../services/RemoteLogger';
import { RemotePageState } from '../state/RemotePageState';
import {
  RemoteConversationDependencies,
  requireRemoteRuntime,
  routeCreatedRemoteSession,
  routeRemoteSessionInPlace
} from './ConversationRuntime';

/** Creates and opens remote sessions without an intermediate creation page. */
export class RemoteCreateFlowController {
  private readonly remote: RemotePageState;
  private readonly remoteRuntime?: RemoteConversationDependencies;

  constructor(
    remote: RemotePageState,
    remoteRuntime: RemoteConversationDependencies | undefined
  ) {
    this.remote = remote;
    this.remoteRuntime = remoteRuntime;
  }

  private navigateCreated(sessionId: string): void {
    routeCreatedRemoteSession(sessionId, requireRemoteRuntime(this.remoteRuntime), (dismissed: boolean) => {
      this.remote.setConversationDismissed(dismissed);
    });
  }

  private navigateInPlace(sessionId: string): void {
    routeRemoteSessionInPlace(sessionId, requireRemoteRuntime(this.remoteRuntime), (dismissed: boolean) => {
      this.remote.setConversationDismissed(dismissed);
    });
  }

  async createRemoteSession(agentType: string, inPlace: boolean = false): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    runtime.filePreview.close();
    await runtime.sessions.createSession(
      agentType,
      '',
      inPlace ? (sessionId: string): void => this.navigateInPlace(sessionId) :
        (sessionId: string): void => this.navigateCreated(sessionId)
    );
  }

  async ensureRemoteControlTarget(deviceId?: string): Promise<void> {
    const target = (deviceId || '').trim();
    if (target.length === 0) {
      return;
    }
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    const activeId = this.remote.controlTargetDeviceId || this.remote.desktopId;
    if (target === activeId && this.remote.connectionState === 'connected') {
      return;
    }
    this.remote.setStatusText(RemoteI18n.t('remote.settings.deviceConnecting'));
    try {
      let device = runtime.settings.knownAccountDevice(target);
      if (!device) {
        device = (await runtime.settings.listCloudAccountDevices())
          .find((item: CloudAccountDevice): boolean => item.deviceId === target);
      }
      if (!device) {
        throw new Error(RemoteI18n.t('remote.settings.deviceUnavailable'));
      }
      await runtime.settings.selectCloudAccountDevice(device, false);
    } catch (err) {
      this.remote.setLoadingHome(false);
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  async createRemoteSessionInWorkspace(
    path: string,
    agentType: string = 'code',
    inPlace: boolean = false,
    deviceId: string = '',
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    runtime.filePreview.close();
    await this.ensureRemoteControlTarget(deviceId);
    await runtime.sessions.createSessionInWorkspace(
      path,
      '',
      agentType,
      inPlace ? (sessionId: string): void => this.navigateInPlace(sessionId) :
        (sessionId: string): void => this.navigateCreated(sessionId),
      '', true, remoteConnectionId,
      remoteSshHost
    );
  }

  async openRemoteSession(item: RemoteSession, inPlace: boolean = false): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    runtime.filePreview.close();
    this.remote.setPendingSessionId(item.id);
    try {
      await this.ensureRemoteControlTarget(item.deviceId);
      await runtime.sessions.openSession(
        item,
        this.remote.workspacePath,
        inPlace ? (sessionId: string): void => this.navigateInPlace(sessionId) :
          (sessionId: string): void => this.navigateCreated(sessionId)
      );
    } catch (err) {
      this.remote.setPendingSessionId('');
      this.remote.setLoadingHome(false);
      RemoteLogger.warn(`open remote session failed session=${item.id}: ${String(err)}`);
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  applyRemoteActiveSession(session: SessionSummary): void {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    const current = this.remote.activeSession;
    if (runtime.hooks.isFilePreviewVisible() &&
      (current.sessionId !== session.sessionId || current.workspacePath !== session.workspacePath)) {
      runtime.filePreview.close();
    }
    this.remote.setActiveSession(session);
  }

  async deleteRemoteSession(item: RemoteSession): Promise<void> {
    await requireRemoteRuntime(this.remoteRuntime).sessions.deleteSession(item, this.remote.workspacePath);
  }

  routeCreatedRemoteSession(sessionId: string): void {
    this.navigateCreated(sessionId);
  }
}
