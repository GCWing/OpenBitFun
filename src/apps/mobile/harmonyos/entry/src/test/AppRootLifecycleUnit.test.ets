import { CloudAccountClient, CloudAccountSession } from '../main/ets/services/CloudAccountClient';
import { CommandStatusResponse, RemoteCommand } from '../main/ets/model/RemoteModels';
import { describe, expect, it } from '@ohos/hypium';
import { RemoteI18n } from '../main/ets/i18n/RemoteI18n';
import { AppRootHostPort } from '../main/ets/pages/host/AppRootHostAdapter';
import { AppRoute } from '../main/ets/pages/navigation/AppRouteContract';
import { AppRootRuntime } from '../main/ets/pages/runtime/AppRootRuntime';
import { FilePreviewRequest, FilePreviewTarget } from '../main/ets/model/FilePreviewTarget';

class FakeAppRootHost implements AppRootHostPort {
  externalLinks: string[] = [];
  externalLinkResult: boolean = true;

  attach(_context: Context, _uiContext: UIContext): void {
  }

  context(): Context {
    return {} as Context;
  }

  animate(_duration: number, callback: () => void): void {
    callback();
  }

  showToast(_message: string, _duration: number): boolean {
    return false;
  }

  async openExternalLink(link: string): Promise<boolean> {
    this.externalLinks.push(link);
    return this.externalLinkResult;
  }
}

class SidebarSessionClient extends CloudAccountClient {
  observePresence(_relay: string, _session: CloudAccountSession, _onPresence: (ids: string[]) => void,
    _onReconnect: () => void): () => void { return () => {}; }

  createCommands: RemoteCommand[] = [];
  createTargets: string[] = [];
  async deviceRpc<T extends CommandStatusResponse>(
    _relayUrl: string, _session: CloudAccountSession, targetDeviceId: string,
    command: RemoteCommand, _timeoutMs: number = 130000
  ): Promise<T> {
    if (command.cmd === 'get_workspace_info') return JSON.parse(
      '{"has_workspace":true,"workspace_path":"/workspace","workspace_name":"Workspace"}') as T;
    if (command.cmd === 'create_session') {
      this.createCommands.push(command);
      this.createTargets.push(targetDeviceId);
      return JSON.parse('{"session_id":"new-session","title":"New session","workspace_path":"/runtime/primary"}') as T;
    }
    if (command.cmd === 'get_session_messages') return JSON.parse('{"messages":[],"has_more":false}') as T;
    return JSON.parse('{"sessions":[],"messages":[],"has_more":false,"is_running":false}') as T;
  }
}

class TestAppRootRuntime extends AppRootRuntime {
  constructor(host: AppRootHostPort = new FakeAppRootHost()) {
    super(host);
  }
}

export default function appRootLifecycleUnitTest() {
  describe('AppRootRuntime page hide lifecycle', () => {
    it('keeps the controller rooted in the device directory across lifecycle changes', 0, () => {
      const runtime = new TestAppRootRuntime();
      expect(runtime.appShellViewModel.currentRoute()).assertEqual(AppRoute.RemoteHome);
      runtime.onPageHide();
      runtime.aboutToDisappear();
      expect(runtime.appShellViewModel.currentRoute()).assertEqual(AppRoute.RemoteHome);
    });

    it('routes HTTP Markdown links through the host without opening file preview', 0, async () => {
      const host = new FakeAppRootHost();
      const runtime = new TestAppRootRuntime(host);

      runtime.filePreviewController.open(
        AppRoute.ChatHome,
        new FilePreviewRequest('https://example.com/docs', 'docs')
      );
      await new Promise<void>((resolve: () => void) => setTimeout(resolve, 0));

      expect(host.externalLinks.length).assertEqual(1);
      expect(host.externalLinks[0]).assertEqual('https://example.com/docs');
      expect(runtime.filePreviewState.visible).assertFalse();
    });

    it('reports external-link failures through the active conversation surface', 0, async () => {
      const host = new FakeAppRootHost();
      host.externalLinkResult = false;
      const runtime = new TestAppRootRuntime(host);

      runtime.filePreviewController.open(
        AppRoute.ChatHome,
        new FilePreviewRequest('https://example.com/failure', 'failure')
      );
      await new Promise<void>((resolve: () => void) => setTimeout(resolve, 0));

      expect(runtime.remotePageState.conversation.statusText)
        .assertEqual(RemoteI18n.t('errors.operationFailed'));
    });

    it('closes preview before applying conversation navigation back', 0, () => {
      const runtime = new TestAppRootRuntime();
      runtime.filePreviewState.begin(new FilePreviewTarget(
        'README.md', 'README.md', 'README.md', 'session-1', '/workspace', 1
      ));

      expect(runtime.handleNavigationBack(AppRoute.RemoteChat)).assertTrue();
      expect(runtime.filePreviewState.visible).assertFalse();
      expect(runtime.handleRootBack()).assertFalse();
    });

    it('dismisses the connect sheet before navigating back', 0, () => {
      const runtime = new TestAppRootRuntime();
      runtime.openConnectSheet();

      expect(runtime.appShellState.showConnectSheet).assertTrue();
      expect(runtime.handleRootBack()).assertTrue();
      expect(runtime.appShellState.showConnectSheet).assertFalse();
    });

    it('creates a new remote session from the sidebar in compact and wide layouts', 0, async () => {
      for (const wide of [false, true]) {
        for (const agentType of ['code', 'minimal', 'agentic', 'Ultra', 'claw']) {
          const runtime = new TestAppRootRuntime();
          const client = new SidebarSessionClient();
          await runtime.sessionManager.connectAccountDevice(client, 'https://relay.example.com',
            { token: 'test-token', userId: '1', masterKey: new Uint8Array(32) }, 'desktop-a');
          runtime.appShellState.wideLayout = wide;
          runtime.remotePageState.connectionState = 'connected';
          runtime.remotePageState.setControlTarget('account_device', 'desktop-a', 'Desktop A');
          runtime.remotePageState.setWorkspace('Workspace', '/workspace', '', '', 'normal');
          runtime.remotePageState.setActiveSession({ sessionId: 'old-session', title: 'Old', workspacePath: '/workspace', agentType: 'code' });
          runtime.appShellViewModel.replaceRouteWithoutAnimation(AppRoute.RemoteChat, 'old-session');
          runtime.appShellState.setSidebarVisible(true);
          try {
            await runtime.presentationActions.onSidebar.newChat(agentType);
            expect(client.createCommands.length).assertEqual(1);
            expect(client.createTargets[0]).assertEqual('desktop-a');
            expect(client.createCommands[0].agent_type).assertEqual(agentType);
            expect(client.createCommands[0].workspace_path).assertUndefined();
            expect(client.createCommands[0].remote_connection_id).assertUndefined();
            expect(runtime.remotePageState.activeSession.workspacePath).assertEqual('/runtime/primary');
            expect(runtime.remotePageState.activeSession.sessionId).assertEqual('new-session');
            expect(runtime.appShellViewModel.currentRoute()).assertEqual(AppRoute.RemoteChat);
            expect(runtime.appShellState.showSidebar).assertFalse();
          } finally { runtime.onPageHide(); runtime.aboutToDisappear(); }
        }
      }
    });

    it('keeps sidebar navigation intact when session creation is unavailable', 0, async () => {
      const runtime = new TestAppRootRuntime();
      runtime.appShellState.setSidebarVisible(true);
      await runtime.presentationActions.onSidebar.newChat();
      expect(runtime.appShellState.showSidebar).assertTrue();
      expect(runtime.appShellViewModel.currentRoute()).assertEqual(AppRoute.RemoteHome);
      runtime.remotePageState.connectionState = 'connected';
      runtime.remotePageState.setBusy(true);
      await runtime.presentationActions.onSidebar.newChat();
      expect(runtime.appShellState.showSidebar).assertTrue();
      runtime.aboutToDisappear();
    });

    it('opens account settings, not a scanner, when adding a desktop', 0, () => {
      const runtime = new TestAppRootRuntime();

      runtime.presentationActions.onSidebar.openAccountDevices();
      expect(runtime.appShellState.showConnectSheet).assertFalse();
      expect(runtime.appShellState.showSettings).assertTrue();
      expect(runtime.appShellState.settingsMode).assertEqual('account');
    });

    it('returns to the single settings page after an account login settles', 0, () => {
      const runtime = new TestAppRootRuntime();

      runtime.presentationActions.onSettings.openAccount();
      runtime.presentationActions.onSettings.accountSettled();
      expect(runtime.appShellState.showSettings).assertTrue();
      expect(runtime.appShellState.settingsMode).assertEqual('general');
    });

    it('invalidates and closes preview when the remote target changes', 0, () => {
      const runtime = new TestAppRootRuntime();
      runtime.filePreviewState.begin(new FilePreviewTarget(
        'README.md', 'README.md', 'README.md', 'session-1', '/workspace', 1
      ));

      runtime.filePreviewController.invalidate();

      expect(runtime.filePreviewState.visible).assertFalse();
    });

    it('closes preview only when the active remote session ownership changes', 0, () => {
      const runtime = new TestAppRootRuntime();
      runtime.remotePageState.setActiveSession({
        sessionId: 'session-1',
        title: 'Session 1',
        workspacePath: '/workspace',
        agentType: 'code'
      });
      runtime.filePreviewState.begin(new FilePreviewTarget(
        'README.md', 'README.md', 'README.md', 'session-1', '/workspace', 1
      ));

      runtime.conversationController.applyRemoteActiveSession({
        sessionId: 'session-1',
        title: 'Renamed session',
        workspacePath: '/workspace',
        agentType: 'code'
      });
      expect(runtime.filePreviewState.visible).assertTrue();

      runtime.conversationController.applyRemoteActiveSession({
        sessionId: 'session-2',
        title: 'Session 2',
        workspacePath: '/workspace',
        agentType: 'code'
      });
      expect(runtime.filePreviewState.visible).assertFalse();
    });
  });
}
