import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dialogSource = readFileSync(
  new URL('./RemoteConnectDialog.tsx', import.meta.url),
  'utf8',
);
const dialogStyleSource = readFileSync(
  new URL('./RemoteConnectDialog.scss', import.meta.url),
  'utf8',
);
const disclaimerSource = readFileSync(
  new URL('./RemoteConnectDisclaimer.tsx', import.meta.url),
  'utf8',
);
const disclaimerStyleSource = readFileSync(
  new URL('./RemoteConnectDisclaimer.scss', import.meta.url),
  'utf8',
);
const chatAppBrandIconSource = readFileSync(
  new URL('./ChatAppBrandIcon.tsx', import.meta.url),
  'utf8',
);
const deviceStatusControlSource = readFileSync(
  new URL('../NavPanel/components/DeviceStatusControl.tsx', import.meta.url),
  'utf8',
);
const navPanelStyleSource = readFileSync(
  new URL('../NavPanel/NavPanel.scss', import.meta.url),
  'utf8',
);
const accountPanelSource = readFileSync(
  new URL('./AccountPanel.tsx', import.meta.url),
  'utf8',
);
const remoteConnectApiSource = readFileSync(
  new URL('../../../infrastructure/api/service-api/RemoteConnectAPI.ts', import.meta.url),
  'utf8',
);
const accountLoginStateSource = readFileSync(
  new URL('../../../infrastructure/account/useAccountLoginState.ts', import.meta.url),
  'utf8',
);

describe('Remote Connect safety contracts', () => {
  it('gates the complete dialog surface behind disclaimer agreement', () => {
    expect(dialogSource).toContain('open={isOpen && hasAgreedDisclaimer}');
    expect(dialogSource).toContain('open={isOpen && (disclaimerIsGate || showDisclaimer)}');
  });

  it('composes disclaimer actions through the shared dialog footer spacing', () => {
    const rootStyle = disclaimerStyleSource.slice(
      disclaimerStyleSource.indexOf('.openbitfun-remote-disclaimer {'),
      disclaimerStyleSource.indexOf('.openbitfun-remote-disclaimer__meta'),
    );
    const actionStyle = disclaimerStyleSource.slice(
      disclaimerStyleSource.indexOf('.openbitfun-remote-disclaimer__actions'),
    );

    expect(disclaimerSource).toContain('<DialogBody>');
    expect(disclaimerSource).toContain('<DialogFooter');
    expect(disclaimerSource).toContain('separator');
    expect(disclaimerSource).toContain("variant={canAgree ? 'fill' : 'primary'}");
    expect(rootStyle).toContain('padding-block-start: var(--openbitfun-space-3);');
    expect(rootStyle).not.toContain('padding-block-end');
    expect(actionStyle).not.toContain('border-top');
    expect(actionStyle).not.toContain('padding-top');
  });

  it('presents one overview with account and connection destinations', () => {
    const overview = dialogSource.slice(
      dialogSource.indexOf('const renderOverview ='),
      dialogSource.indexOf('const renderViewHeader'),
    );

    expect(overview).toContain('remote-connect-my-devices-title');
    expect(overview).toContain('remote-connect-access-title');
    expect(overview.match(/renderOverviewAction\(\{/g)).toHaveLength(3);
    expect(overview).toContain("view: 'account'");
    expect(overview).toContain("view: 'network'");
    expect(overview).toContain("view: 'bot'");
    expect(dialogSource).not.toContain('data-openbitfun-part="groupTab"');
    expect(dialogSource).not.toContain('remote-connect-group-');
  });

  it('keeps persistent navigation beside a single task surface', () => {
    expect(dialogSource).toContain('size="2xl"');
    expect(dialogSource).toContain('className="openbitfun-remote-connect-dialog"');
    expect(dialogSource).toContain('className="openbitfun-remote-connect-dialog__header"');
    expect(dialogSource).toContain('className="openbitfun-remote-connect-dialog__body"');
    expect(dialogSource).toContain('data-openbitfun-part="sidebar"');
    expect(dialogSource).toContain('data-openbitfun-part="sidebarBrand"');
    expect(dialogSource).toContain('data-openbitfun-part="main"');
    expect(dialogSource).toContain('className="openbitfun-remote-connect__navigation"');
    expect(dialogSource).toContain("aria-current={activeView === view ? 'page' : undefined}");
  });

  it('gives every view, including the overview, the same page header', () => {
    const viewHeader = dialogSource.slice(
      dialogSource.indexOf('const renderViewHeader'),
      dialogSource.indexOf('const renderConnectedMarker'),
    );
    const viewCopy = dialogSource.slice(
      dialogSource.indexOf('const VIEW_COPY'),
      dialogSource.indexOf('const FEISHU_SETUP_GUIDE_URLS'),
    );

    expect(viewHeader).not.toContain('return null');
    expect(viewHeader).toContain('<PageHeader');
    expect(viewHeader).toContain('id="remote-connect-view-title"');
    expect(viewCopy).toContain("overview: { titleKey: 'remoteConnect.overviewTitle'");
    expect(viewCopy).toContain("account: { titleKey: 'remoteConnect.myDevicesTitle'");
    expect(dialogSource.match(/\{renderViewHeader\(\)\}/g)).toHaveLength(1);
  });

  it('composes every view from the shared section, card, row and action-bar styles', () => {
    const accountStyleSource = readFileSync(new URL('./AccountPanel.scss', import.meta.url), 'utf8');
    const surfaceStyleSource = readFileSync(new URL('./_remote-connect-surface.scss', import.meta.url), 'utf8');
    const networkSource = readFileSync(new URL('./RemoteNetworkConnections.tsx', import.meta.url), 'utf8');

    for (const source of [dialogStyleSource, accountStyleSource]) {
      expect(source).toContain("@use './remote-connect-surface' as surface;");
      expect(source).not.toMatch(/font-size:\s*\d/);
      expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
    expect(surfaceStyleSource).toContain('@mixin action-bar');
    expect(dialogStyleSource).toContain('@include surface.action-bar;');
    expect(dialogSource).toContain('className="openbitfun-remote-connect__card-actions"');
    expect(networkSource).toContain('className="openbitfun-remote-connect__card-actions"');
  });

  it('uses one destructive treatment and real buttons for every link-like action', () => {
    const networkSource = readFileSync(new URL('./RemoteNetworkConnections.tsx', import.meta.url), 'utf8');

    expect(dialogSource).not.toContain('role="link"');
    expect(dialogSource).toContain('className="openbitfun-remote-connect__inline-link" onClick={handleOpenFeishuPlatform}');
    expect(dialogSource).toContain('<Button variant="outline" tone="danger" size="sm" onClick={handleDisconnectBot}>');
    expect(networkSource).toContain('<Button variant="outline" tone="danger" size="sm" onClick={onDisconnect}>');
    expect(accountPanelSource).toContain('leadingIcon={<LogOut size={14} />} onClick={handleLogout}');
  });

  it('labels the chat-app detail switch with what it changes', () => {
    const botContent = dialogSource.slice(
      dialogSource.indexOf('const renderBotContent'),
      dialogSource.indexOf('// ── Layout'),
    );

    expect(botContent).toContain("t('remoteConnect.botExecutionDetailsTitle')");
    expect(botContent).toContain('aria-labelledby="remote-connect-bot-details-title"');
    expect(botContent).toContain('aria-describedby="remote-connect-bot-details-description"');
    expect(dialogSource).not.toContain('botConciseMode');
  });

  it('keeps device-row actions in fixed columns with the open affordance last', () => {
    const deviceRow = accountPanelSource.slice(
      accountPanelSource.indexOf('const DeviceEntry'),
      accountPanelSource.indexOf('export default AccountPanel'),
    );

    expect(deviceRow.indexOf('account-panel__device-actions')).toBeLessThan(
      deviceRow.indexOf('account-panel__device-chevron'),
    );
    expect(deviceRow.indexOf('</DeviceEntry>')).toBeLessThan(
      deviceRow.indexOf('<Icon name="chevron-right"'),
    );
  });

  it('keeps the dialog height stable while selected content scrolls inside it', () => {
    const desktopGeometry = dialogStyleSource.slice(
      dialogStyleSource.indexOf('.openbitfun-remote-connect-dialog {'),
      dialogStyleSource.indexOf('.openbitfun-remote-connect-dialog__header'),
    );

    expect(desktopGeometry).toContain('block-size: min(620px, calc(100vh - 2 * var(--openbitfun-overlay-dialog-viewport-gutter)))');
    expect(desktopGeometry).toContain('min-block-size: min(620px, calc(100vh - 2 * var(--openbitfun-overlay-dialog-viewport-gutter)))');
    expect(desktopGeometry).toContain('max-block-size: min(620px, calc(100vh - 2 * var(--openbitfun-overlay-dialog-viewport-gutter)))');
    expect(dialogStyleSource).toContain(".openbitfun-remote-connect [data-openbitfun-part='panel']");
    expect(dialogSource).toContain('<ScrollArea');
  });

  it('delegates accessible method and provider tabs to the design system', () => {
    expect(dialogSource).toContain('id="remote-connect-network-tabpanel"');
    expect(dialogSource).toContain('id="remote-connect-bot-tabpanel"');
    expect(dialogSource).toContain("panelId: 'remote-connect-network-tabpanel'");
    expect(dialogSource).toContain("panelId: 'remote-connect-bot-tabpanel'");
    expect(dialogSource.match(/<TabGroup/g)).toHaveLength(2);
    expect(dialogSource).not.toContain('handleTabArrowKey');
    expect(dialogSource).not.toContain('data-openbitfun-part="subtab"');
  });

  it('offers two relay endpoints and the supported chat providers', () => {
    const methods = dialogSource.slice(
      dialogSource.indexOf('const NETWORK_TABS'),
      dialogSource.indexOf('const RemoteConnectDialog'),
    );

    expect(methods).toContain("id: 'lan'");
    expect(methods).toContain("id: 'openbitfun_server'");
    expect(methods).not.toContain("id: 'ngrok'");
    expect(methods).not.toContain("id: 'custom_server'");
    expect(methods).toContain("id: 'telegram'");
    expect(methods).toContain("id: 'feishu'");
    expect(methods).toContain("id: 'weixin'");
  });

  it('uses the real monochrome app marks for every chat provider', () => {
    const identityBrandStyle = dialogStyleSource.slice(
      dialogStyleSource.indexOf('.openbitfun-remote-connect__bot-identity-icon'),
      dialogStyleSource.indexOf('.openbitfun-remote-connect__bot-identity-title'),
    );
    const footerMessageBrandStyle = navPanelStyleSource.slice(
      navPanelStyleSource.indexOf("&[data-openbitfun-device-kind='message-app'] {"),
      navPanelStyleSource.indexOf('.openbitfun-nav-panel__footer-device-status-attached-count'),
    );
    const footerBrandColorStyle = navPanelStyleSource.slice(
      navPanelStyleSource.indexOf('.openbitfun-nav-panel__footer-device-status-attached {'),
      navPanelStyleSource.indexOf('.openbitfun-nav-panel__footer-device-status-attached-group'),
    );
    const overviewMessageBrandStart = navPanelStyleSource.indexOf(
      "&[data-openbitfun-device-kind='message-app'] .openbitfun-device-overview__device-icon {",
    );
    const overviewMessageBrandStyle = navPanelStyleSource.slice(
      overviewMessageBrandStart,
      navPanelStyleSource.indexOf('  strong {', overviewMessageBrandStart),
    );

    expect(dialogSource).toContain('<ChatAppBrandIcon app={botTab} size={20} />');
    expect(dialogSource).toContain('icon: <MessageCircle size={18} />');
    expect(dialogSource).toContain('icon: <ChatAppBrandIcon app={tab.id} size={15} />');
    expect(chatAppBrandIconSource).toContain("app === 'telegram'");
    expect(chatAppBrandIconSource).toContain("app === 'feishu'");
    expect(chatAppBrandIconSource.match(/viewBox="0 0 24 24"/g)).toHaveLength(3);
    expect(chatAppBrandIconSource.match(/fill="currentColor"/g)).toHaveLength(5);
    expect(deviceStatusControlSource).toContain('chatAppBrandFromIdentity(identity)');
    expect(deviceStatusControlSource).toContain('<ChatAppBrandIcon app={chatApp} size={size} />');
    expect(identityBrandStyle).not.toContain('background:');
    expect(dialogStyleSource).not.toContain('connected-app-icon');
    expect(footerMessageBrandStyle).toContain('border: 0');
    expect(footerMessageBrandStyle).toContain('background: transparent');
    expect(footerBrandColorStyle).toContain('--openbitfun-color-content-primary');
    expect(overviewMessageBrandStyle).toContain('background: transparent');
    expect(overviewMessageBrandStyle).toContain('--openbitfun-color-content-primary');
    expect(dialogSource).not.toContain('<Send size={28} />');
    expect(dialogSource).not.toContain('<MessageSquareText size={28} />');
    expect(dialogSource).not.toContain('<MessagesSquare size={28} />');
  });

  it('keeps OpenBitFun Page out of the account and device lifecycle', () => {
    expect(accountPanelSource).not.toContain('pagesEntry');
    expect(accountPanelSource).not.toContain("openScene('pages')");
    expect(accountPanelSource).not.toContain('PanelsTopLeft');
  });

  it('does not issue an unconditional logout for a late 401 response', () => {
    const handler = accountPanelSource.slice(
      accountPanelSource.indexOf('const handleSessionExpired'),
      accountPanelSource.indexOf('const markRelayUnreachable'),
    );
    expect(handler).not.toContain('accountLogout');
    expect(handler).toContain('isAccountEpochCurrent(expectedEpoch)');
  });

  it('binds presence updates to the account epoch that created the listener', () => {
    const listener = accountPanelSource.slice(
      accountPanelSource.indexOf('// Subscribe only while a specific account epoch is active.'),
      accountPanelSource.indexOf('const validate'),
    );
    const invalidation = accountPanelSource.slice(
      accountPanelSource.indexOf('const invalidateAccountRequests'),
      accountPanelSource.indexOf('const isAccountEpochCurrent'),
    );

    expect(listener).toContain('const subscribedEpoch = activeAccountEpoch');
    expect(listener).toContain('isAccountEpochCurrent(subscribedEpoch)');
    expect(listener).not.toContain('isAccountEpochCurrent(accountEpochRef.current)');
    expect(invalidation).toContain('setActiveAccountEpoch(null)');
  });

  it('debounces transient device-list failures while device routing remains healthy', () => {
    const refreshFlow = accountPanelSource.slice(
      accountPanelSource.indexOf('const refreshDevices'),
      accountPanelSource.indexOf('const applyPresenceOnline'),
    );

    expect(refreshFlow).toContain('refreshInFlightRef.current?.epoch === epoch');
    expect(refreshFlow).toContain('deviceListFailureCountRef.current += 1');
    expect(refreshFlow).toContain('!deviceRoutingReadyRef.current');
    expect(refreshFlow).toContain('DEVICE_LIST_FAILURE_THRESHOLD');
    expect(refreshFlow.indexOf('!deviceRoutingReadyRef.current')).toBeLessThan(
      // The call passes the failure so it can be classified; only the order of
      // the healthy-routing guard against this call is contracted here.
      refreshFlow.indexOf('markRelayUnreachable('),
    );
  });

  it('retries initial device routing without starting a duplicate sync-time connection', () => {
    const retryHelper = accountPanelSource.slice(
      accountPanelSource.indexOf('async function connectDevicesWithRetry'),
      accountPanelSource.indexOf('function parseRelayServer'),
    );
    const backgroundSync = accountPanelSource.slice(
      accountPanelSource.indexOf('const startBackgroundSync'),
      accountPanelSource.indexOf('const handleRetrySync'),
    );

    expect(retryHelper).toContain('DEVICE_CONNECT_MAX_ATTEMPTS');
    expect(retryHelper).toContain('isRelayUnreachable(error)');
    expect(backgroundSync).not.toContain('accountConnectDevices');
  });

  it('keeps recovering an initial device-routing failure without overlapping attempts', () => {
    const recoveryFlow = accountPanelSource.slice(
      accountPanelSource.indexOf('const attemptDeviceReconnect'),
      accountPanelSource.indexOf('/** Connect presence + load the device list'),
    );

    expect(recoveryFlow).toContain('deviceReconnectInFlightRef.current');
    expect(recoveryFlow).toContain('DEVICE_CONNECT_RECOVERY_INTERVAL_MS');
    expect(recoveryFlow).toContain('attemptDeviceReconnect(false)');
    expect(recoveryFlow).toContain('startDevicePolling()');
  });

  it('does not expose the account bearer token in the login result contract', () => {
    const loginResult = remoteConnectApiSource.slice(
      remoteConnectApiSource.indexOf('export interface AccountLoginResult'),
      remoteConnectApiSource.indexOf('export interface AccountHint'),
    );
    expect(loginResult).toContain('user_id: string');
    expect(loginResult).not.toContain('token:');
  });

  it('does not reinterpret an account-status transport failure as logout', () => {
    const statusMethod = remoteConnectApiSource.slice(
      remoteConnectApiSource.indexOf('async accountStatus'),
      remoteConnectApiSource.indexOf('async accountGetCredentialHint'),
    );
    const accountPanelInitialization = accountPanelSource.slice(
      accountPanelSource.indexOf('    ensureAccountSession(remoteConnectAPI'),
      accountPanelSource.indexOf(
        'return () => {',
        accountPanelSource.indexOf('    ensureAccountSession(remoteConnectAPI'),
      ),
    );
    expect(statusMethod).toContain('throw e');
    expect(statusMethod).not.toContain('logged_in: false');
    expect(accountPanelInitialization).toContain('}).catch((e) => {');
    expect(accountLoginStateSource).toContain("identity.status === 'signed-in'");
    expect(accountLoginStateSource).not.toContain('accountStatus(');
  });

  it('fences Weixin poll rejection cleanup to the operation that owns the UI', () => {
    const pollEffect = dialogSource.slice(
      dialogSource.indexOf('// WeChat QR login: poll iLink'),
      dialogSource.indexOf('// ── Connection handlers'),
    );
    const rejectionCleanup = pollEffect.slice(
      pollEffect.lastIndexOf('} catch (e: unknown) {'),
      pollEffect.lastIndexOf('return;'),
    );

    expect(rejectionCleanup).toContain('updateIfOperationCurrent(isCurrent, () => {');
    expect(rejectionCleanup).toContain('setWeixinQrSessionKey(null)');
    expect(rejectionCleanup).toContain('setWeixinQrImageUrl(null)');
    expect(rejectionCleanup).toContain('setWeixinAwaitingPhoneConfirm(false)');
  });

  it('auto-starts Weixin after QR login without exposing a redundant Connect action', () => {
    const botContent = dialogSource.slice(
      dialogSource.indexOf('const renderBotContent'),
      dialogSource.indexOf('// ── Layout'),
    );

    expect(botContent).toContain("botTab !== 'weixin'");
    expect(botContent).not.toContain('botWeixinLinked');
    expect(dialogSource).toContain("t('remoteConnect.botWeixinRestriction')");
    expect(dialogSource).toContain('prepareAndStartWeixinBotFromQr');
  });

  it('restores connected method status without hijacking the overview', () => {
    const applyStatus = dialogSource.slice(
      dialogSource.indexOf('const applyStatus'),
      dialogSource.indexOf('const startPolling'),
    );
    const restoreFlow = dialogSource.slice(
      dialogSource.indexOf('const checkExisting'),
      dialogSource.indexOf("activeView !== 'network'"),
    );
    const connectedRestore = restoreFlow.slice(
      restoreFlow.indexOf('applyStatus(s, restoreSelection'),
      restoreFlow.indexOf("if (!pendingOwnerRef.current"),
    );

    expect(applyStatus).toContain('selectRemoteNetworkConnection(nextStatus, connectionResultRef.current)');
    expect(applyStatus).toContain('setNetworkTab(connectedTab)');
    expect(applyStatus).toContain('setBotTab(connectedBot)');
    expect(dialogSource).toContain("useState<ActiveView>(initialGroup ?? 'overview')");
    expect(connectedRestore).not.toContain('setActiveView');
  });
});
