import { useAccountIdentity } from '@/infrastructure/account-identity';
/**
 * Device & Connections center.
 *
 * Every connection uses the signed-in GitHub account. The detail views expose:
 *   - My devices (account and peer-device control)
 *   - Phone or browser (official or locally hosted Relay)
 *   - Chat apps (Telegram / Feishu / WeChat)
 * Connections are host-level services and do not require a selected project;
 * remote clients can use the primary assistant workspace.
 */

import { OverflowText,
  Button,
  Field,
  Icon,
  Input,
  PageHeader,
  ScrollArea,
  Select,
  StatusPill,
  Switch,
  TabGroup,
  type TabGroupItem,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowUpRight,
  CircleAlert,
  Globe,
  LayoutGrid,
  MessageCircle,
  Monitor,
  MonitorSmartphone,
  ShieldCheck,
  Smartphone,
  Wifi,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { getLocaleFallbackChain, type LocaleId } from '@/infrastructure/i18n/presets';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { useAccountLoginState } from '@/infrastructure/account/useAccountLoginState';
import { remoteConnectStatusSource, useRemoteConnectStatus } from '@/infrastructure/remote-connect/remoteConnectStatus';
import { isDeviceInvitation, invitationRelayUrl, OFFICIAL_RELAY_URL, selectRemoteNetworkConnection, type RemoteNetworkMethod } from '@/infrastructure/remote-connect/remoteConnectionState';
import { useNotification } from '@/shared/notification-system';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import { AccountPanel } from './AccountPanel';
import {
  remoteConnectAPI,
  type ConnectionResult,
  type RemoteConnectStatus,
  type LanNetworkInterface,
} from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { RemoteConnectDisclaimer } from './RemoteConnectDisclaimer';
import {
  getRemoteConnectDisclaimerAgreed,
  setRemoteConnectDisclaimerAgreed,
} from './remoteConnectDisclaimerStorage';
import {
  stopAfterPendingStart,
  updateIfOperationCurrent,
} from './remoteConnectOperationCleanup';
import { ChatAppBrandIcon } from './ChatAppBrandIcon';
import { RemotePairingCard } from './RemotePairingCard';
import { RemoteNetworkConnections } from './RemoteNetworkConnections';
import { WeixinLoginProgress } from './WeixinLoginProgress';
import './RemoteConnectDialog.scss';

// ── Types ────────────────────────────────────────────────────────────

type ActiveGroup = 'network' | 'bot' | 'account';
type ActiveView = 'overview' | ActiveGroup;
type ConnectionOwner = Exclude<ActiveGroup, 'account'>;
type NetworkTab = RemoteNetworkMethod;
type BotTab = 'telegram' | 'feishu' | 'weixin';

/**
 * iLink `qrcode_img_content` is the string to encode in a QR (OpenClaw passes it to
 * `qrcode-terminal.generate`), not necessarily an `<img src>` raster URL. Only treat
 * as raster when it is clearly a data-URL or direct image link.
 */
function isWeixinRasterQrSrc(raw: string): boolean {
  const t = raw.trim();
  if (/^data:image\//i.test(t)) return true;
  if (
    /^https?:\/\//i.test(t)
    && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(t)
  ) {
    return true;
  }
  return false;
}

const NETWORK_TABS: { id: NetworkTab; labelKey: string; descriptionKey: string }[] = [
  {
    id: 'lan',
    labelKey: 'remoteConnect.methodSameNetwork',
    descriptionKey: 'remoteConnect.methodSameNetworkDescription',
  },
  {
    id: 'openbitfun_server',
    labelKey: 'remoteConnect.methodOpenBitFunRelay',
    descriptionKey: 'remoteConnect.methodOpenBitFunRelayDescription',
  },
];

const VIEW_COPY: Record<ActiveView, { titleKey: string; descriptionKey: string }> = {
  overview: { titleKey: 'remoteConnect.overviewTitle', descriptionKey: 'remoteConnect.overviewIntro' },
  account: { titleKey: 'remoteConnect.myDevicesTitle', descriptionKey: 'remoteConnect.myDevicesDescription' },
  network: { titleKey: 'remoteConnect.mobileBrowserTitle', descriptionKey: 'remoteConnect.mobileBrowserDescription' },
  bot: { titleKey: 'remoteConnect.chatAppsTitle', descriptionKey: 'remoteConnect.chatAppsDescription' },
};

const BOT_TABS: { id: BotTab; label: string }[] = [
  { id: 'telegram', label: 'Telegram' },
  { id: 'feishu', label: '' }, // filled from i18n
  { id: 'weixin', label: '' },
];

const FEISHU_SETUP_GUIDE_URLS = {
  'zh-CN': 'https://github.com/GCWing/OpenBitFun/blob/main/docs/remote-connect/feishu-bot-setup.zh-CN.md',
  'en-US': 'https://github.com/GCWing/OpenBitFun/blob/main/docs/remote-connect/feishu-bot-setup.md',
} as const satisfies Partial<Record<LocaleId, string>>;

const FEISHU_OPEN_PLATFORM_URL = 'https://open.feishu.cn/app';

function pickLocalizedUrl(urls: Partial<Record<LocaleId, string>>, locale: LocaleId): string {
  for (const localeId of getLocaleFallbackChain(locale, true)) {
    const url = urls[localeId];
    if (url) return url;
  }

  return urls['en-US'] ?? Object.values(urls)[0] ?? '';
}



const botInfoToBotTab = (info: string | null | undefined): BotTab | null => {
  if (!info) return null;
  if (info.startsWith('Telegram')) return 'telegram';
  if (info.startsWith('Feishu')) return 'feishu';
  if (info.startsWith('Weixin')) return 'weixin';
  return null;
};

// ── Component ────────────────────────────────────────────────────────

interface RemoteConnectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Optional focused destination for contextual entry points. The generic
   * Device & Connections entry opens the overview.
   */
  initialGroup?: ActiveGroup;
}

export const RemoteConnectDialog: React.FC<RemoteConnectDialogProps> = ({
  isOpen,
  onClose,
  initialGroup,
}) => {
  const { t, currentLanguage } = useI18n('common');
  const { error: notifyError } = useNotification();
  const {
    loggedIn: accountLoggedIn,
  } = useAccountLoginState();
  const accountIdentity = useAccountIdentity();

  const [activeView, setActiveView] = useState<ActiveView>(initialGroup ?? 'overview');
  const [networkTab, setNetworkTab] = useState<NetworkTab>(NETWORK_TABS[0].id);
  const [botTab, setBotTab] = useState<BotTab>(BOT_TABS[0].id);

  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);
  const [connectionOwner, setConnectionOwner] = useState<ConnectionOwner | null>(null);
  const { status, state: statusState } = useRemoteConnectStatus();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lanNetworkInfo, setLanNetworkInfo] = useState<{
    localIp: string;
    gatewayIp: string | null;
    availableIps: LanNetworkInterface[];
  } | null>(null);
  const [selectedLanIp, setSelectedLanIp] = useState<string>('');
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [hasAgreedDisclaimer, setHasAgreedDisclaimer] = useState<boolean>(() => getRemoteConnectDisclaimerAgreed());
  const [botVerboseMode, setBotVerboseMode] = useState<boolean>(false);

  const [qrCopied, setQrCopied] = useState(false);
  const [tgToken, setTgToken] = useState('');
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');
  const [weixinIlinkToken, setWeixinIlinkToken] = useState('');
  const [weixinBaseUrl, setWeixinBaseUrl] = useState('');
  const [weixinBotAccountId, setWeixinBotAccountId] = useState('');
  const [weixinQrSessionKey, setWeixinQrSessionKey] = useState<string | null>(null);
  const [weixinQrImageUrl, setWeixinQrImageUrl] = useState<string | null>(null);
  const [weixinAwaitingPhoneConfirm, setWeixinAwaitingPhoneConfirm] = useState(false);
  const [weixinNeedsVerifyCode, setWeixinNeedsVerifyCode] = useState(false);
  const [weixinVerifyCode, setWeixinVerifyCode] = useState('');
  const [weixinQrPollNonce, setWeixinQrPollNonce] = useState(0);

  const formSnapshotRef = useRef({
    tgToken: '',
    feishuAppId: '',
    feishuAppSecret: '',
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollGenerationRef = useRef(0);
  const networkSelectionGenerationRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const pendingOwnerRef = useRef<ConnectionOwner | null>(null);
  const connectionOwnerRef = useRef<ConnectionOwner | null>(null);
  const connectionResultRef = useRef<ConnectionResult | null>(null);
  const pendingStartRef = useRef<{
    owner: ConnectionOwner;
    generation: number;
    promise: Promise<ConnectionResult>;
  } | null>(null);
  const cleanupPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const weixinVerifyCodeRef = useRef<string | null>(null);
  const isOpenRef = useRef(isOpen);
  connectionOwnerRef.current = connectionOwner;
  connectionResultRef.current = connectionResult;
  isOpenRef.current = isOpen;

  // ── Derived state ────────────────────────────────────────────────

  const networkConnection = selectRemoteNetworkConnection(status, connectionResult);
  const isRelayConnected = networkConnection.connected;
  const isBotConnected = !!status?.bot_connected;
  const connectedNetworkTab = networkConnection.method;
  const connectedBotTab = botInfoToBotTab(status?.bot_connected);

  const cancelPendingWork = useCallback(async () => {
    operationGenerationRef.current += 1;
    const currentStatus = remoteConnectStatusSource.getSnapshot().status;
    const candidateOwner = pendingOwnerRef.current ?? connectionOwnerRef.current;
    // Closing an invitation preserves an established account route.
    // Disconnect is an explicit action for both Relay endpoints.
    const owner = (candidateOwner === 'network' && !pendingStartRef.current && selectRemoteNetworkConnection(currentStatus).connected)
      || (candidateOwner === 'bot' && currentStatus?.bot_connected)
      ? null : candidateOwner;
    const pendingStart = pendingStartRef.current;
    pendingOwnerRef.current = null;
    connectionOwnerRef.current = null;
    setConnectionOwner(null);
    setConnectionResult(null);
    setWeixinQrSessionKey(null);
    setWeixinQrImageUrl(null);
    setWeixinAwaitingPhoneConfirm(false);
    setWeixinNeedsVerifyCode(false);
    setWeixinVerifyCode('');
    weixinVerifyCodeRef.current = null;
    setLoading(false);

    const previousCleanup = cleanupPromiseRef.current;
    const cleanup = previousCleanup
      .catch(() => undefined)
      .then(async () => {
        // If start is still in flight, stopping before it settles can leak a
        // connection that is created after the stop call. Wait, then stop.
        await stopAfterPendingStart(pendingStart?.promise ?? null, async () => {
          if (pendingStart && pendingStartRef.current === pendingStart) {
            pendingStartRef.current = null;
          }
          try {
            if (owner === 'bot') {
              remoteConnectStatusSource.invalidateReads();
              await remoteConnectAPI.stopBot();
            } else if (owner === 'network') {
              remoteConnectStatusSource.invalidateReads();
              await remoteConnectAPI.stopConnection();
            }
            if (owner) {
              remoteConnectStatusSource.invalidateReads();
              await remoteConnectStatusSource.refresh();
            }
          } catch {
            // Best-effort cleanup; the generation still blocks late UI writes.
          }
        });
      });
    cleanupPromiseRef.current = cleanup;
    await cleanup;
  }, []);

  const handleDialogClose = useCallback(() => {
    void cancelPendingWork();
    onClose();
  }, [cancelPendingWork, onClose]);

  const handleViewChange = useCallback((nextView: ActiveView) => {
    if (nextView === activeView) return;
    if (activeView !== 'overview') void cancelPendingWork();
    setActiveView(nextView);
    setError(null);
  }, [activeView, cancelPendingWork]);

  useEffect(() => {
    if (!isOpen) return;
    setActiveView(initialGroup ?? 'overview');
    setError(null);
  }, [initialGroup, isOpen]);

  useEffect(() => {
    if (!isOpen) void cancelPendingWork();
  }, [cancelPendingWork, isOpen]);

  useEffect(() => {
    isOpenRef.current = isOpen;
    return () => {
      isOpenRef.current = false;
      void cancelPendingWork();
    };
  }, [cancelPendingWork, isOpen]);

  // ── Polling ──────────────────────────────────────────────────────

  const applyStatus = useCallback((nextStatus: RemoteConnectStatus, restoreSelection = false) => {
    const network = selectRemoteNetworkConnection(nextStatus, connectionResultRef.current);
    // Keep the device invitation visible while the route remains available.
    const deviceInvitation = isDeviceInvitation(connectionResultRef.current);

    // Relay and bot connections can coexist. Restore both selected subtabs
    // before choosing which group to show, otherwise the bot-first open path
    // can leave a connected OpenBitFun Server relay rendering the default LAN UI.
    const hasPendingInvitation = connectionOwnerRef.current === 'network' && connectionResultRef.current !== null;
    if (!deviceInvitation && restoreSelection && network.connected
      && (!hasPendingInvitation || network.invitationConnected)) {
      const connectedTab = network.method;
      if (connectedTab) setNetworkTab(connectedTab);
    }
    const connectedBot = botInfoToBotTab(nextStatus.bot_connected);
    if (connectedBot) setBotTab(connectedBot);
    const owner = connectionOwnerRef.current;
    if (owner === 'bot' && connectedBot) {
      pendingOwnerRef.current = null;
      connectionOwnerRef.current = null;
      setConnectionOwner(null);
      setConnectionResult(null);
    } else if (owner === 'network' && !deviceInvitation && !nextStatus.active_method && !pendingStartRef.current) {
      pendingOwnerRef.current = null;
      connectionOwnerRef.current = null;
      setConnectionOwner(null);
      setConnectionResult(null);
    }
  }, []);

  useEffect(() => {
    if (isOpen && status) applyStatus(status);
  }, [applyStatus, isOpen, status]);

  const startPolling = useCallback((_target?: 'relay' | 'bot') => {
    const pollGeneration = ++pollGenerationRef.current;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await remoteConnectStatusSource.refresh();
        if (!s || !isOpenRef.current || pollGenerationRef.current !== pollGeneration) return;
        applyStatus(s);
      } catch { /* ignore */ }
    }, 2000);
  }, [applyStatus]);

  // On dialog open: check if a connection (restored bot / ongoing relay) is active.
  useEffect(() => {
    if (!isOpen) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }

    const agreed = getRemoteConnectDisclaimerAgreed();
    setHasAgreedDisclaimer(agreed);
    if (!agreed) return;
    // Overview and established connections still need expiry/reconnect updates.
    startPolling();

    let cancelled = false;
    const networkSelectionGeneration = networkSelectionGenerationRef.current;
    const checkExisting = async () => {
      let restoreSelection = true;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const s = await remoteConnectStatusSource.refresh();
          if (cancelled || !s) return;
          applyStatus(s, restoreSelection && networkSelectionGenerationRef.current === networkSelectionGeneration);
          restoreSelection = false;
          setBotVerboseMode(s.bot_verbose_mode);

          if (selectRemoteNetworkConnection(s).connected || s.bot_connected) return;
        } catch { /* ignore */ }
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1500));
          if (cancelled) return;
        }
      }
    };
    void checkExisting();
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      pollGenerationRef.current += 1;
    };
  }, [applyStatus, isOpen, hasAgreedDisclaimer, startPolling]);

  useEffect(() => {
    if (!isOpen || !hasAgreedDisclaimer || activeView !== 'network' || networkTab !== 'lan') return;
    let cancelled = false;
    const loadLanNetworkInfo = async () => {
      const info = await remoteConnectAPI.getLanNetworkInfo();
      if (!cancelled && info) {
        const availableIps = info.available_ips ?? [];
        setLanNetworkInfo({
          localIp: info.local_ip,
          gatewayIp: info.gateway_ip ?? null,
          availableIps,
        });
        // Auto-select the first (highest-priority) IP if nothing is selected yet
        // or the previous selection is no longer in the list.
        setSelectedLanIp(prev => {
          if (prev && availableIps.some(e => e.ip === prev)) return prev;
          return availableIps[0]?.ip ?? info.local_ip ?? '';
        });
      }
    };
    void loadLanNetworkInfo();
    return () => {
      cancelled = true;
    };
  }, [isOpen, hasAgreedDisclaimer, activeView, networkTab]);

  useEffect(() => {
    if (!isOpen || !hasAgreedDisclaimer) return;
    let cancelled = false;
    const loadFormState = async () => {
      try {
        const formState = await remoteConnectAPI.getFormState();
        if (cancelled) return;
        setTgToken(formState.telegram_bot_token ?? '');
        setFeishuAppId(formState.feishu_app_id ?? '');
        setFeishuAppSecret(formState.feishu_app_secret ?? '');
        setWeixinIlinkToken(formState.weixin_ilink_token ?? '');
        setWeixinBaseUrl(formState.weixin_base_url ?? '');
        setWeixinBotAccountId(formState.weixin_bot_account_id ?? '');
      } catch {
        // Ignore form-state restore failures and keep in-memory defaults.
      }
    };
    void loadFormState();
    return () => {
      cancelled = true;
    };
  }, [isOpen, hasAgreedDisclaimer]);

  // Refresh connection status when the active identity changes.
  useEffect(() => {
    const unlisten = api.listen<{ logged_in: boolean; relay_url?: string }>(
      'account://login-state',
      () => {
        // Invitations belong to the active account route.
        remoteConnectStatusSource.invalidate();
        void remoteConnectStatusSource.refresh().then((nextStatus) => {
          if (!nextStatus) return;
          if (!isOpenRef.current) return;
          applyStatus(nextStatus);
          if (!selectRemoteNetworkConnection(nextStatus, connectionResultRef.current).invitationConnected) {
            pendingOwnerRef.current = null;
            connectionOwnerRef.current = null;
            setConnectionOwner(null);
            setConnectionResult(null);
          }
        }).catch(() => undefined);
      },
    );
    return () => {
      unlisten();
    };
  }, [applyStatus]);

  useEffect(() => {
    formSnapshotRef.current = {
      tgToken,
      feishuAppId,
      feishuAppSecret,
    };
  }, [tgToken, feishuAppId, feishuAppSecret]);

  const prepareAndStartWeixinBotFromQr = useCallback(async (
    ilinkToken: string,
    baseUrl: string,
    botAccountId: string,
  ): Promise<ConnectionResult> => {
    const fs = formSnapshotRef.current;
    await remoteConnectAPI.setFormState({
      telegram_bot_token: fs.tgToken,
      feishu_app_id: fs.feishuAppId,
      feishu_app_secret: fs.feishuAppSecret,
      weixin_ilink_token: ilinkToken,
      weixin_base_url: baseUrl || undefined,
      weixin_bot_account_id: botAccountId,
    });
    await remoteConnectAPI.configureBot({
      botType: 'weixin',
      weixinIlinkToken: ilinkToken,
      weixinBaseUrl: baseUrl || undefined,
      weixinBotAccountId: botAccountId,
    });
    remoteConnectStatusSource.invalidateReads();
    const result = await remoteConnectAPI.startConnection('bot_weixin');
    remoteConnectStatusSource.invalidateReads();
    void remoteConnectStatusSource.refresh().catch(() => undefined);
    return result;
  }, []);

  // WeChat QR login: poll iLink until confirmed or error (session key cleared on completion).
  useEffect(() => {
    const key = weixinQrSessionKey;
    if (!key) return;
    const operationGeneration = operationGenerationRef.current;
    let cancelled = false;
    const isCurrent = () => (
      !cancelled
      && isOpenRef.current
      && operationGenerationRef.current === operationGeneration
      && pendingOwnerRef.current === 'bot'
    );
    void (async () => {
      let verifyCode = weixinVerifyCodeRef.current;
      weixinVerifyCodeRef.current = null;
      while (isCurrent()) {
        try {
          const p = await remoteConnectAPI.weixinQrPoll(key, null, verifyCode);
          verifyCode = null;
          if (!isCurrent()) return;
          if (p.status === 'scanned') {
            setWeixinQrImageUrl(null);
            setWeixinAwaitingPhoneConfirm(true);
            setWeixinNeedsVerifyCode(false);
            setWeixinVerifyCode('');
            await new Promise(resolve => setTimeout(resolve, 750));
            continue;
          }
          if (p.status === 'need_verify_code') {
            setWeixinQrImageUrl(null);
            setWeixinAwaitingPhoneConfirm(false);
            setWeixinNeedsVerifyCode(true);
            return;
          }
          if (p.status === 'confirmed' && p.ilink_token && p.bot_account_id) {
            const token = p.ilink_token;
            const base = p.base_url ?? '';
            const bid = p.bot_account_id;
            setWeixinAwaitingPhoneConfirm(false);
            setWeixinNeedsVerifyCode(false);
            setWeixinVerifyCode('');
            setWeixinIlinkToken(token);
            setWeixinBaseUrl(base);
            setWeixinBotAccountId(bid);
            // Hide QR immediately, but keep `weixinQrSessionKey` until the pipeline finishes.
            // Clearing the session key first re-runs this effect's cleanup and sets `cancelled`,
            // so after `await` we would skip `setConnectionResult` and never `setLoading(false)`.
            setWeixinQrImageUrl(null);
            setConnectionResult(null);
            setError(null);
            setLoading(true);
            try {
              await cleanupPromiseRef.current.catch(() => undefined);
              if (!isCurrent()) return;
              const startPromise = prepareAndStartWeixinBotFromQr(token, base, bid);
              const pendingStart = {
                owner: 'bot' as const,
                generation: operationGeneration,
                promise: startPromise,
              };
              pendingStartRef.current = pendingStart;
              const result = await startPromise;
              if (pendingStartRef.current === pendingStart) pendingStartRef.current = null;
              if (isCurrent()) {
                connectionOwnerRef.current = 'bot';
                setConnectionOwner('bot');
                setConnectionResult(result);
                startPolling('bot');
              }
            } catch (e: unknown) {
              if (pendingStartRef.current?.generation === operationGeneration) {
                pendingStartRef.current = null;
              }
              if (isCurrent()) {
                setError(e instanceof Error ? e.message : String(e));
              }
            } finally {
              if (isCurrent()) {
                setLoading(false);
              }
            }
            if (isCurrent()) {
              setWeixinQrSessionKey(null);
            }
            return;
          }
          if (p.status === 'error') {
            pendingOwnerRef.current = null;
            setError(p.message);
            setWeixinQrSessionKey(null);
            setWeixinQrImageUrl(null);
            setWeixinAwaitingPhoneConfirm(false);
            setWeixinNeedsVerifyCode(false);
            setWeixinVerifyCode('');
            return;
          }
          if (p.status === 'expired' && p.qr_image_url) {
            setWeixinQrImageUrl(p.qr_image_url);
            setWeixinAwaitingPhoneConfirm(false);
            setWeixinNeedsVerifyCode(false);
            setWeixinVerifyCode('');
          }
          await new Promise(resolve => setTimeout(resolve, 750));
        } catch (e: unknown) {
          updateIfOperationCurrent(isCurrent, () => {
            pendingOwnerRef.current = null;
            setError(e instanceof Error ? e.message : String(e));
            setWeixinQrSessionKey(null);
            setWeixinQrImageUrl(null);
            setWeixinAwaitingPhoneConfirm(false);
            setWeixinNeedsVerifyCode(false);
            setWeixinVerifyCode('');
          });
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weixinQrSessionKey, weixinQrPollNonce, prepareAndStartWeixinBotFromQr, startPolling]);

  // ── Connection handlers ──────────────────────────────────────────

  const handleConnect = useCallback(async () => {
    if (!accountLoggedIn) {
      setActiveView('account');
      return;
    }

    if (!hasAgreedDisclaimer) {
      setShowDisclaimer(true);
      return;
    }
    if (activeView !== 'network' && activeView !== 'bot') return;
    const owner: ConnectionOwner = activeView;
    const operationGeneration = ++operationGenerationRef.current;
    pendingOwnerRef.current = owner;
    setLoading(true);
    setError(null);
    setConnectionResult(null);
    setConnectionOwner(null);

    const isCurrent = () => (
      isOpenRef.current
      && operationGenerationRef.current === operationGeneration
      && pendingOwnerRef.current === owner
    );
    let ownsConnection = false;

    try {
      await cleanupPromiseRef.current.catch(() => undefined);
      if (!isCurrent()) return;
      await remoteConnectAPI.setFormState({
        telegram_bot_token: tgToken,
        feishu_app_id: feishuAppId,
        feishu_app_secret: feishuAppSecret,
        weixin_ilink_token: weixinIlinkToken,
        weixin_base_url: weixinBaseUrl,
        weixin_bot_account_id: weixinBotAccountId,
      });
      if (!isCurrent()) return;

      let method: string;

      if (activeView === 'bot') {
        if (botTab === 'telegram') {
          method = 'bot_telegram';
        } else if (botTab === 'feishu') {
          method = 'bot_feishu';
        } else {
          method = 'bot_weixin';
        }
        if (botTab === 'telegram' && tgToken) {
          await remoteConnectAPI.configureBot({ botType: 'telegram', botToken: tgToken });
        } else if (botTab === 'feishu' && feishuAppId) {
          await remoteConnectAPI.configureBot({
            botType: 'feishu', appId: feishuAppId, appSecret: feishuAppSecret,
          });
        } else if (botTab === 'weixin' && weixinIlinkToken && weixinBotAccountId) {
          await remoteConnectAPI.configureBot({
            botType: 'weixin',
            weixinIlinkToken: weixinIlinkToken,
            weixinBaseUrl: weixinBaseUrl || undefined,
            weixinBotAccountId: weixinBotAccountId,
          });
        }
        if (!isCurrent()) return;
      } else {
        method = networkTab;
      }
      const lanIp = networkTab === 'lan' ? (selectedLanIp || undefined) : undefined;
      remoteConnectStatusSource.invalidateReads();
      const startPromise = remoteConnectAPI.startConnection(method, lanIp);
      const pendingStart = { owner, generation: operationGeneration, promise: startPromise };
      pendingStartRef.current = pendingStart;
      const result = await startPromise;
      remoteConnectStatusSource.invalidateReads();
      if (pendingStartRef.current === pendingStart) pendingStartRef.current = null;
      if (!isCurrent()) return;
      connectionOwnerRef.current = owner;
      setConnectionOwner(owner);
      setConnectionResult(result);
      ownsConnection = true;
      startPolling(owner === 'bot' ? 'bot' : 'relay');
      void remoteConnectStatusSource.refresh().catch(() => undefined);
    } catch (e: any) {
      if (pendingStartRef.current?.generation === operationGeneration) {
        pendingStartRef.current = null;
      }
      if (isCurrent()) {
        pendingOwnerRef.current = null;
        setError(e?.message || String(e));
      }
    } finally {
      if (isCurrent()) {
        if (!ownsConnection) pendingOwnerRef.current = null;
        setLoading(false);
      }
    }
  }, [accountLoggedIn, activeView, networkTab, botTab, tgToken, feishuAppId, feishuAppSecret, weixinIlinkToken, weixinBaseUrl, weixinBotAccountId, selectedLanIp, startPolling, hasAgreedDisclaimer]);

  const handleStartWeixinQr = useCallback(async () => {
    if (!hasAgreedDisclaimer) {
      setShowDisclaimer(true);
      return;
    }
    const operationGeneration = ++operationGenerationRef.current;
    pendingOwnerRef.current = 'bot';
    setError(null);
    setWeixinAwaitingPhoneConfirm(false);
    setWeixinNeedsVerifyCode(false);
    setWeixinVerifyCode('');
    weixinVerifyCodeRef.current = null;
    setLoading(true);
    try {
      await cleanupPromiseRef.current.catch(() => undefined);
      if (!isOpenRef.current || operationGenerationRef.current !== operationGeneration) return;
      const r = await remoteConnectAPI.weixinQrStart(
        weixinBaseUrl || null,
        weixinIlinkToken || null,
        weixinBotAccountId || null,
      );
      if (!isOpenRef.current || operationGenerationRef.current !== operationGeneration) return;
      setWeixinQrSessionKey(r.session_key);
      setWeixinQrImageUrl(r.qr_image_url);
    } catch (e: unknown) {
      if (isOpenRef.current && operationGenerationRef.current === operationGeneration) {
        pendingOwnerRef.current = null;
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (isOpenRef.current && operationGenerationRef.current === operationGeneration) {
        setLoading(false);
      }
    }
  }, [hasAgreedDisclaimer, weixinBaseUrl, weixinBotAccountId, weixinIlinkToken]);

  const handleSubmitWeixinVerifyCode = useCallback(() => {
    const code = weixinVerifyCode.trim();
    if (!code || !weixinQrSessionKey) return;
    weixinVerifyCodeRef.current = code;
    setWeixinNeedsVerifyCode(false);
    setWeixinQrPollNonce(value => value + 1);
  }, [weixinQrSessionKey, weixinVerifyCode]);

  const handleCancelWeixinQr = useCallback(() => {
    void cancelPendingWork();
  }, [cancelPendingWork]);

  const handleDisconnectRelay = useCallback(async () => {
    try {
      remoteConnectStatusSource.invalidateReads();
      await remoteConnectAPI.stopConnection();
      remoteConnectStatusSource.invalidateReads();
      pendingOwnerRef.current = null;
      connectionOwnerRef.current = null;
      setConnectionOwner(null);
      setConnectionResult(null);
      const s = await remoteConnectStatusSource.refresh();
      if (s) applyStatus(s);
    } catch { /* best effort */ }
  }, [applyStatus]);

  const handleDisconnectBot = useCallback(async () => {
    try {
      remoteConnectStatusSource.invalidateReads();
      await remoteConnectAPI.stopBot();
      remoteConnectStatusSource.invalidateReads();
      pendingOwnerRef.current = null;
      connectionOwnerRef.current = null;
      setConnectionOwner(null);
      setConnectionResult(null);
      const s = await remoteConnectStatusSource.refresh();
      if (s) applyStatus(s);
    } catch { /* best effort */ }
  }, [applyStatus]);

  const handleBotVerboseModeChange = async (newMode: boolean) => {
    if (newMode === botVerboseMode) return;
    setBotVerboseMode(newMode);
    await remoteConnectAPI.setBotVerboseMode(newMode);
  };

  const handleCancelConnect = useCallback(async () => {
    await cancelPendingWork();
    if (!isOpenRef.current) return;
    try {
      const s = await remoteConnectStatusSource.refresh();
      if (s && isOpenRef.current) applyStatus(s);
    } catch { /* best effort */ }
  }, [applyStatus, cancelPendingWork]);

  const handleOpenFeishuGuide = useCallback(() => {
    void systemAPI.openExternal(pickLocalizedUrl(FEISHU_SETUP_GUIDE_URLS, currentLanguage));
  }, [currentLanguage]);

  const handleOpenFeishuPlatform = useCallback(() => {
    void systemAPI.openExternal(FEISHU_OPEN_PLATFORM_URL);
  }, []);

  const botLabel = (tabId: BotTab | null): string | null => {
    if (tabId === 'telegram') return 'Telegram';
    if (tabId === 'feishu') return t('remoteConnect.feishu');
    if (tabId === 'weixin') return t('remoteConnect.weixin');
    return null;
  };

  const botIntro = (tabId: BotTab): string => {
    if (tabId === 'telegram') return t('remoteConnect.botTelegramIntro');
    if (tabId === 'feishu') return t('remoteConnect.botFeishuIntro');
    return t('remoteConnect.botWeixinIntro');
  };

  const connectionStatusLabel = (connected: boolean): string => {
    if (statusState === 'unavailable') return t('remoteConnect.statusUnavailable');
    if (statusState === 'loading') return t('remoteConnect.statusChecking');
    return connected ? t('remoteConnect.stateConnected') : t('remoteConnect.notConnected');
  };

  // ── Sub-tab disabled logic ───────────────────────────────────────

  const isBotSubDisabled = (tabId: BotTab): boolean => {
    if (isBotConnected && connectedBotTab && connectedBotTab !== tabId) return true;
    return false;
  };

  // ── Renderers ────────────────────────────────────────────────────

  const renderErrorBlock = () => {
    if (!error) return null;
    return (
      <div
        data-openbitfun-component="remote-connect-dialog"
        data-openbitfun-part="error"
        className="openbitfun-remote-connect__error-group"
        role="alert"
      >
        <Icon glyph={CircleAlert} size="sm" tone="danger" />
        <p className="openbitfun-remote-connect__error">{error}</p>
      </div>
    );
  };

  const renderNotice = (children: React.ReactNode) => (
    <div className="openbitfun-remote-connect__notice">
      <Icon name="info" size="sm" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );

  const renderSetupSteps = (steps: React.ReactNode[], action?: React.ReactNode) => (
    <div className="openbitfun-remote-connect__setup">
      <div className="openbitfun-remote-connect__setup-heading">
        <h4 className="openbitfun-remote-connect__setup-title">{t('remoteConnect.setupStepsTitle')}</h4>
        {action}
      </div>
      <ol className="openbitfun-remote-connect__steps">
        {steps.map((step, index) => (
          <li className="openbitfun-remote-connect__step" key={index}>
            <span className="openbitfun-remote-connect__step-index" aria-hidden="true">{index + 1}</span>
            <span className="openbitfun-remote-connect__step-text">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );

  const renderBotStatus = (connected: boolean) => (
    <span
      className="openbitfun-remote-connect__status"
      role="status"
      data-openbitfun-component="remote-connect-dialog"
      data-openbitfun-part="status"
      data-openbitfun-state={connected ? 'connected' : undefined}
    >
      <StatusPill tone={statusState === 'ready' && connected ? 'success' : 'neutral'}>
        {connectionStatusLabel(connected)}
      </StatusPill>
    </span>
  );

  const renderBotIdentity = (status: React.ReactNode, description: string = botIntro(botTab)) => (
    <div className="openbitfun-remote-connect__bot-identity">
      <span className="openbitfun-remote-connect__bot-identity-icon" aria-hidden="true">
        <ChatAppBrandIcon app={botTab} size={20} />
      </span>
      <div className="openbitfun-remote-connect__bot-identity-copy">
        <h3 className="openbitfun-remote-connect__bot-identity-title">{botLabel(botTab)}</h3>
        <p className="openbitfun-remote-connect__bot-identity-description">{description}</p>
      </div>
      {status}
    </div>
  );

  const renderBotCard = (children: React.ReactNode, connected = false) => (
    <div
      data-openbitfun-component="remote-connect-dialog"
      data-openbitfun-part="body"
      data-openbitfun-state={connected ? 'connected' : undefined}
      className="openbitfun-remote-connect__body"
    >
      <section
        className="openbitfun-remote-connect__bot-card"
        data-openbitfun-component="remote-connect-dialog"
        data-openbitfun-part="botCard"
        aria-label={botLabel(botTab) ?? undefined}
      >
        {children}
      </section>
    </div>
  );

  const handleCopyPairingUrl = useCallback(async () => {
    if (!connectionResult?.qr_url) return;
    const copied = await copyTextToClipboard(connectionResult.qr_url);
    if (copied) {
      setQrCopied(true);
      window.setTimeout(() => setQrCopied(false), 2000);
    } else {
      notifyError(t('remoteConnect.copyUrlFailed'));
    }
  }, [connectionResult?.qr_url, notifyError, t]);

  // ── Network group content ────────────────────────────────────────

  const networkLabel = (tabId: NetworkTab | null): string | null => {
    const tab = NETWORK_TABS.find(item => item.id === tabId);
    return tab ? t(tab.labelKey) : null;
  };

  const networkDescription = (tabId: NetworkTab): string => {
    const tab = NETWORK_TABS.find(item => item.id === tabId);
    return tab ? t(tab.descriptionKey) : '';
  };

  const renderNetworkContent = () => {
    const invitation = connectionOwner === 'network' ? connectionResult : null;
    const relayUrl = invitationRelayUrl(invitation)
      ?? (networkConnection.method === networkTab ? networkConnection.relayUrl : null)
      ?? (networkTab === 'openbitfun_server' ? OFFICIAL_RELAY_URL : selectedLanIp ? `http://${selectedLanIp}:9700` : '');
    return <RemoteNetworkConnections
      status={status}
      method={networkTab}
      icon={networkTab === 'lan' ? <Wifi size={18} /> : <Globe size={18} />}
      title={networkLabel(networkTab) ?? ''}
      description={networkDescription(networkTab)}
      relayUrl={relayUrl}
      settings={networkTab === 'lan' && !invitation && !loading && (
        <Field
          className="openbitfun-remote-connect__field"
          controlWidth="fill"
          label={t('remoteConnect.currentIp')}
          orientation="horizontal"
        >
          <Select
            size="sm"
            value={selectedLanIp}
            onValueChange={(value) => setSelectedLanIp(String(value))}
            options={(lanNetworkInfo?.availableIps ?? []).map(entry => ({
              label: `${entry.ip} — ${entry.interface_name}`, value: entry.ip,
            }))}
          />
        </Field>
      )}
      invitation={invitation}
      statusState={statusState}
      loading={loading}
      pairingUrlCopied={qrCopied}
      error={renderErrorBlock()}
      onCopyPairingUrl={handleCopyPairingUrl}
      onConnect={handleConnect}
      onCancel={handleCancelConnect}
      onDisconnect={handleDisconnectRelay}
    />;
  };

  // ── Bot group content ────────────────────────────────────────────

  const renderBotContent = () => {
    if (statusState !== 'ready' && !connectionResult && !weixinQrSessionKey && !loading) {
      return renderBotCard(renderBotIdentity(renderBotStatus(false)));
    }

    if (isBotConnected && connectedBotTab === botTab) {
      return renderBotCard((
        <>
          {renderBotIdentity(renderBotStatus(true), t('remoteConnect.botConnectedDescription'))}
          {botTab === 'weixin' && (
            <div className="openbitfun-remote-connect__card-section">
              {renderNotice(t('remoteConnect.botWeixinRestriction'))}
            </div>
          )}
          <div className="openbitfun-remote-connect__setting-row">
            <div className="openbitfun-remote-connect__setting-copy">
              <span id="remote-connect-bot-details-title" className="openbitfun-remote-connect__setting-title">
                {t('remoteConnect.botExecutionDetailsTitle')}
              </span>
              <span id="remote-connect-bot-details-description" className="openbitfun-remote-connect__setting-description">
                {t('remoteConnect.botExecutionDetailsDescription')}
              </span>
            </div>
            <Switch
              aria-labelledby="remote-connect-bot-details-title"
              aria-describedby="remote-connect-bot-details-description"
              checked={botVerboseMode}
              onCheckedChange={(checked) => void handleBotVerboseModeChange(checked)}
            />
          </div>
          <div className="openbitfun-remote-connect__card-actions">
            <Button variant="outline" tone="danger" size="sm" onClick={handleDisconnectBot}>
              {t('remoteConnect.disconnect')}
            </Button>
          </div>
        </>
      ), true);
    }

    if (connectionResult && connectionOwner === 'bot') {
      return renderBotCard((
        <>
          {renderBotIdentity(null)}
          <div className="openbitfun-remote-connect__card-section">
            <RemotePairingCard
              qrUrl={connectionResult.qr_url}
              pairingCode={connectionResult.bot_pairing_code}
              owner="bot"
              statusState={statusState}
              copied={qrCopied}
              onCopyUrl={handleCopyPairingUrl}
            />
          </div>
          <div className="openbitfun-remote-connect__card-actions">
            <Button variant="fill" size="sm" onClick={handleCancelConnect}>
              {t('remoteConnect.cancel')}
            </Button>
          </div>
        </>
      ));
    }

    const weixinPhase: 'idle' | 'scan' | 'confirm' | 'starting' | 'verify' = weixinQrImageUrl
      ? 'scan'
      : !weixinQrSessionKey
        ? 'idle'
        : weixinNeedsVerifyCode
          ? 'verify'
          : weixinAwaitingPhoneConfirm
            ? 'confirm'
            : 'starting';

    const setupBody = botTab === 'telegram' ? (
      <>
        {renderSetupSteps([
          t('remoteConnect.botTgStep1'),
          t('remoteConnect.botTgStep2'),
          t('remoteConnect.botTgStep3'),
        ])}
        <Field className="openbitfun-remote-connect__field" controlWidth="fill" label="Bot Token">
          <Input
            type="text"
            placeholder="123456:xxxxxxxxxxxxxxxxxxxxxxxx"
            value={tgToken}
            onValueChange={setTgToken}
            size="sm"
          />
        </Field>
      </>
    ) : botTab === 'feishu' ? (
      <>
        {renderSetupSteps([
          <>
            {t('remoteConnect.botFeishuStep1Prefix')}
            <button type="button" className="openbitfun-remote-connect__inline-link" onClick={handleOpenFeishuPlatform}>
              {t('remoteConnect.botFeishuOpenPlatform')}
            </button>
            {t('remoteConnect.botFeishuStep1Suffix')}
          </>,
          t('remoteConnect.botFeishuStep2'),
          t('remoteConnect.botFeishuStep3'),
        ], (
          <Button
            size="xs"
            variant="text"
            trailingIcon={<ArrowUpRight size={14} />}
            onClick={handleOpenFeishuGuide}
          >
            {t('remoteConnect.botFeishuDocLink')}
          </Button>
        ))}
        <div className="openbitfun-remote-connect__field-grid">
          <Field className="openbitfun-remote-connect__field" controlWidth="fill" label="App ID">
            <Input
              type="text"
              placeholder="cli_xxxxxxxx"
              value={feishuAppId}
              onValueChange={setFeishuAppId}
              size="sm"
            />
          </Field>
          <Field className="openbitfun-remote-connect__field" controlWidth="fill" label="App Secret">
            <Input
              type="password"
              placeholder="xxxxxxxxxxxxxxxx"
              value={feishuAppSecret}
              onValueChange={setFeishuAppSecret}
              size="sm"
            />
          </Field>
        </div>
      </>
    ) : (
      <>
        {renderSetupSteps([
          t('remoteConnect.botWeixinStep1'),
          t('remoteConnect.botWeixinStep2'),
        ])}
        {renderNotice(t('remoteConnect.botWeixinRestriction'))}
        {weixinPhase === 'scan' && weixinQrImageUrl && (
          <div className="openbitfun-remote-connect__weixin-login">
            <div className="openbitfun-remote-connect__weixin-qr">
              {isWeixinRasterQrSrc(weixinQrImageUrl) ? (
                <img
                  src={weixinQrImageUrl}
                  alt={t('remoteConnect.weixinQrAlt')}
                  className="openbitfun-remote-connect__weixin-qr-img"
                />
              ) : (
                <div
                  className="openbitfun-remote-connect__weixin-qr-svg-wrap"
                  role="img"
                  aria-label={t('remoteConnect.weixinQrAlt')}
                >
                  <QRCodeSVG value={weixinQrImageUrl} size={164} level="M" includeMargin />
                </div>
              )}
            </div>
            <WeixinLoginProgress phase="scan" />
          </div>
        )}
        {(weixinPhase === 'confirm' || weixinPhase === 'starting') && (
          <div className="openbitfun-remote-connect__weixin-login openbitfun-remote-connect__weixin-login--progress">
            <WeixinLoginProgress phase={weixinPhase === 'starting' && loading ? 'starting' : 'confirm'} />
          </div>
        )}
        {weixinPhase === 'verify' && (
          <Field
            className="openbitfun-remote-connect__field"
            controlWidth="fill"
            description={t('remoteConnect.botWeixinVerifyCodeHint')}
            label={t('remoteConnect.botWeixinVerifyCodePlaceholder')}
          >
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={weixinVerifyCode}
              onValueChange={setWeixinVerifyCode}
              size="sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmitWeixinVerifyCode();
              }}
            />
          </Field>
        )}
      </>
    );

    const setupActions = botTab !== 'weixin' ? (
      <Button
        variant="primary"
        size="sm"
        loading={loading}
        onClick={handleConnect}
        disabled={botTab === 'telegram' ? !tgToken : !feishuAppId}
      >
        {loading ? t('remoteConnect.connecting') : t('remoteConnect.getPairingCode')}
      </Button>
    ) : weixinPhase === 'idle' ? (
      <Button variant="primary" size="sm" loading={loading} onClick={handleStartWeixinQr}>
        {t('remoteConnect.botWeixinQrButton')}
      </Button>
    ) : (
      <>
        <Button variant="fill" size="sm" onClick={handleCancelWeixinQr}>
          {t('remoteConnect.botWeixinQrCancel')}
        </Button>
        {weixinPhase === 'verify' && (
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmitWeixinVerifyCode}
            disabled={!weixinVerifyCode.trim()}
          >
            {t('remoteConnect.botWeixinVerifyCodeSubmit')}
          </Button>
        )}
      </>
    );

    return renderBotCard((
      <>
        {renderBotIdentity(renderBotStatus(false))}
        <div className="openbitfun-remote-connect__card-section openbitfun-remote-connect__bot-setup">
          {setupBody}
          {renderErrorBlock()}
        </div>
        <div className="openbitfun-remote-connect__card-actions">{setupActions}</div>
      </>
    ));
  };

  // ── Layout ───────────────────────────────────────────────────────

  const isNetworkConnecting = !!connectionResult && connectionOwner === 'network'
    && !networkConnection.connected && !networkConnection.invitationConnected;
  const isBotConnecting = !!connectionResult && connectionOwner === 'bot' && !isBotConnected;
  const isCurrentViewPairing = activeView === 'network'
    ? isNetworkConnecting || (loading && pendingOwnerRef.current === 'network')
    : activeView === 'bot'
      ? isBotConnecting || !!weixinQrSessionKey || (loading && pendingOwnerRef.current === 'bot')
      : false;

  const handleAgreeDisclaimer = useCallback(() => {
    setRemoteConnectDisclaimerAgreed();
    setHasAgreedDisclaimer(true);
    setShowDisclaimer(false);
  }, []);

  const renderOverviewAction = ({
    view,
    icon,
    title,
    description,
    statusLabel,
    statusDetail,
    statusPositive = false,
    state,
    disabled = false,
  }: {
    view: ActiveGroup;
    icon: React.ReactNode;
    title: string;
    description: string;
    statusLabel: string;
    statusDetail?: string | null;
    statusPositive?: boolean;
    state?: 'authenticated' | 'connected';
    disabled?: boolean;
  }) => (
    <button data-overflow-trigger
      type="button"
      className="openbitfun-remote-connect__overview-action"
      data-openbitfun-component="remote-connect-dialog"
      data-openbitfun-part="overviewAction"
      data-openbitfun-group={view}
      data-openbitfun-state={[
        state,
        disabled && 'disabled',
      ].filter(Boolean).join(' ') || undefined}
      onClick={() => handleViewChange(view)}
      disabled={disabled}
    >
      <span className="openbitfun-remote-connect__overview-action-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="openbitfun-remote-connect__overview-action-copy">
        <span className="openbitfun-remote-connect__overview-action-title">{title}</span>
        <span className="openbitfun-remote-connect__overview-action-description">{description}</span>
      </span>
      <span className="openbitfun-remote-connect__overview-action-status">
        {statusDetail && (
          <OverflowText className="openbitfun-remote-connect__overview-action-status-detail" title={statusDetail}>
            {statusDetail}
          </OverflowText>
        )}
        <StatusPill tone={statusPositive ? 'success' : 'neutral'}>{statusLabel}</StatusPill>
      </span>
      <Icon name="chevron-right" size="sm" className="openbitfun-remote-connect__overview-action-chevron" aria-hidden="true" />
    </button>
  );

  const renderOverview = () => (
    <ScrollArea
      className="openbitfun-remote-connect__overview"
      data-openbitfun-component="remote-connect-dialog"
      data-openbitfun-part="overview"
    >
      <section
        className="openbitfun-remote-connect__overview-section"
        data-openbitfun-component="remote-connect-dialog"
        data-openbitfun-part="overviewSection"
        aria-labelledby="remote-connect-my-devices-title"
      >
        <div className="openbitfun-remote-connect__overview-section-heading">
          <h3 id="remote-connect-my-devices-title" className="openbitfun-remote-connect__overview-section-title">
            <span
              className="openbitfun-remote-connect__visually-hidden"
              data-openbitfun-component="remote-connect-dialog"
              data-openbitfun-part="sectionMarker"
              aria-hidden="true"
            />
            {t('remoteConnect.controlOtherDevicesTitle')}
          </h3>
        </div>
        <div className="openbitfun-remote-connect__overview-actions">
          {renderOverviewAction({
            view: 'account',
            icon: <Monitor size={18} />,
            title: t('remoteConnect.myDevicesTitle'),
            description: t('remoteConnect.myDevicesDescription'),
            statusLabel: accountLoggedIn
              ? t('remoteConnect.accountSignedIn')
              : t('remoteConnect.accountSignedOut'),
            statusDetail: accountLoggedIn ? accountIdentity.me?.email ?? accountIdentity.me?.user.login ?? null : null,
            statusPositive: accountLoggedIn,
            state: accountLoggedIn ? 'authenticated' : undefined,
          })}
        </div>
      </section>

      {accountLoggedIn && <section
        className="openbitfun-remote-connect__overview-section"
        data-openbitfun-component="remote-connect-dialog"
        data-openbitfun-part="overviewSection"
        aria-labelledby="remote-connect-access-title"
      >
        <div className="openbitfun-remote-connect__overview-section-heading">
          <h3 id="remote-connect-access-title" className="openbitfun-remote-connect__overview-section-title">
            <span
              className="openbitfun-remote-connect__visually-hidden"
              data-openbitfun-component="remote-connect-dialog"
              data-openbitfun-part="sectionMarker"
              aria-hidden="true"
            />
            {t('remoteConnect.connectThisDeviceTitle')}
          </h3>
          <p className="openbitfun-remote-connect__overview-section-description">
            {t('remoteConnect.connectThisDeviceDescription')}
          </p>
        </div>
        <div className="openbitfun-remote-connect__overview-actions">
          {renderOverviewAction({
            view: 'network',
            icon: <Smartphone size={18} />,
            title: t('remoteConnect.mobileBrowserTitle'),
            description: t('remoteConnect.mobileBrowserDescription'),
            statusLabel: connectionStatusLabel(isRelayConnected),
            statusDetail: isRelayConnected
              ? networkLabel(connectedNetworkTab)
              : null,
            statusPositive: statusState === 'ready' && isRelayConnected,
            state: isRelayConnected ? 'connected' : undefined,
          })}
          {renderOverviewAction({
            view: 'bot',
            icon: <MessageCircle size={18} />,
            title: t('remoteConnect.chatAppsTitle'),
            description: t('remoteConnect.chatAppsDescription'),
            statusLabel: connectionStatusLabel(isBotConnected),
            statusDetail: isBotConnected
              ? botLabel(connectedBotTab)
              : null,
            statusPositive: statusState === 'ready' && isBotConnected,
            state: isBotConnected ? 'connected' : undefined,
          })}
        </div>
      </section>}
    </ScrollArea>
  );

  const renderNavigationItem = (view: ActiveView, label: string, icon: React.ReactNode) => (
    <button type="button" className="openbitfun-remote-connect__navigation-item"
      aria-current={activeView === view ? 'page' : undefined}
      onClick={() => handleViewChange(view)}>
      <span className="openbitfun-remote-connect__navigation-icon" aria-hidden="true">{icon}</span>
      <span className="openbitfun-remote-connect__navigation-label">{label}</span>
    </button>
  );

  const renderViewHeader = () => {
    const copy = VIEW_COPY[activeView];

    return (
      <div
        className="openbitfun-remote-connect__view-header"
        data-openbitfun-component="remote-connect-dialog"
        data-openbitfun-part="viewHeader"
      >
        {activeView !== 'overview' && (
          <Button
            className="openbitfun-remote-connect__back"
            leadingIcon={<Icon name="arrow-left" size="sm" />}
            onClick={() => handleViewChange('overview')}
            size="sm"
            variant="text"
          >
            {isCurrentViewPairing
              ? t('remoteConnect.cancelAndBack')
              : t('remoteConnect.backToOverview')}
          </Button>
        )}
        <PageHeader
          className="openbitfun-remote-connect__view-page-header"
          description={t(copy.descriptionKey)}
          level={2}
          size="sm"
          title={<span id="remote-connect-view-title">{t(copy.titleKey)}</span>}
        />
      </div>
    );
  };

  const renderConnectedMarker = (connected: boolean) => connected ? (
    <span className="openbitfun-remote-connect__tab-marker">
      <span className="openbitfun-remote-connect__dot-sm" aria-hidden="true" />
      <span className="openbitfun-remote-connect__visually-hidden">
        {t('remoteConnect.stateConnected')}
      </span>
    </span>
  ) : undefined;

  const networkTabItems: TabGroupItem[] = NETWORK_TABS.map(tab => ({
    disabled: (isNetworkConnecting && networkTab !== tab.id),
    icon: tab.id === 'lan' ? <Wifi size={15} /> : <Globe size={15} />,
    id: `remote-connect-network-tab-${tab.id}`,
    label: t(tab.labelKey),
    labelSuffix: renderConnectedMarker(networkConnection.connected && networkConnection.method === tab.id),
    panelId: 'remote-connect-network-tabpanel',
    value: tab.id,
  }));
  const botTabItems: TabGroupItem[] = BOT_TABS.map(tab => ({
    disabled: isBotSubDisabled(tab.id) || (isBotConnecting && botTab !== tab.id),
    icon: <ChatAppBrandIcon app={tab.id} size={15} />,
    id: `remote-connect-bot-tab-${tab.id}`,
    label: botLabel(tab.id) ?? tab.label,
    labelSuffix: renderConnectedMarker(isBotConnected && connectedBotTab === tab.id),
    panelId: 'remote-connect-bot-tabpanel',
    tabProps: isBotSubDisabled(tab.id) ? { title: t('remoteConnect.botSingleConnectionHint') } : undefined,
    value: tab.id,
  }));

  const handleNetworkTabValueChange = (value: string) => {
    networkSelectionGenerationRef.current += 1;
    const nextTab = value as NetworkTab;
    if (nextTab === networkTab) return;
    void cancelPendingWork();
    setNetworkTab(nextTab);
    setError(null);
  };

  const handleBotTabValueChange = (value: string) => {
    const nextTab = value as BotTab;
    if (nextTab === botTab) return;
    void cancelPendingWork();
    setBotTab(nextTab);
    setError(null);
  };

  const disclaimerIsGate = isOpen && !hasAgreedDisclaimer;
  const handleDisclaimerClose = disclaimerIsGate
    ? handleDialogClose
    : () => setShowDisclaimer(false);

  useEffect(() => {
    if (!accountLoggedIn && (activeView === 'network' || activeView === 'bot')) {
      handleViewChange('overview');
    }
  }, [accountLoggedIn, activeView, handleViewChange]);

  return (
    <>
      <Dialog
        open={isOpen && hasAgreedDisclaimer}
        onOpenChange={(nextOpen) => { if (!nextOpen) handleDialogClose(); }}
        size="2xl"
        aria-label={t('remoteConnect.centerTitle')}
        className="openbitfun-remote-connect-dialog"
      >
        <DialogHeader className="openbitfun-remote-connect-dialog__header">
          <DialogClose />
        </DialogHeader>
        <DialogBody className="openbitfun-remote-connect-dialog__body" inset="none">
          <div
            className="openbitfun-remote-connect"
            data-openbitfun-component="remote-connect-dialog"
            data-openbitfun-part="root"
            data-openbitfun-view={activeView}
          >
          <aside
            className="openbitfun-remote-connect__sidebar"
            data-openbitfun-component="remote-connect-dialog"
            data-openbitfun-part="sidebar"
          >
            <div
              className="openbitfun-remote-connect__sidebar-brand"
              data-openbitfun-component="remote-connect-dialog"
              data-openbitfun-part="sidebarBrand"
            >
              <span className="openbitfun-remote-connect__sidebar-icon" aria-hidden="true">
                <MonitorSmartphone size={18} strokeWidth={1.75} />
              </span>
              <h2 id="remote-connect-center-title" className="openbitfun-remote-connect__sidebar-title">
                {t('remoteConnect.centerTitle')}
              </h2>
            </div>
            <nav className="openbitfun-remote-connect__navigation" aria-label={t('remoteConnect.centerTitle')}>
              {renderNavigationItem('overview', t('remoteConnect.overviewTitle'), <LayoutGrid size={16} />)}
              {renderNavigationItem('account', t('remoteConnect.myDevicesTitle'), <Monitor size={16} />)}
              {accountLoggedIn && renderNavigationItem('network', t('remoteConnect.mobileBrowserTitle'), <Smartphone size={16} />)}
              {accountLoggedIn && renderNavigationItem('bot', t('remoteConnect.chatAppsTitle'), <MessageCircle size={16} />)}
            </nav>
            <div className="openbitfun-remote-connect__sidebar-footer">
              <Button
                className="openbitfun-remote-connect__disclaimer-trigger"
                leadingIcon={<ShieldCheck size={14} />}
                onClick={() => setShowDisclaimer(true)}
                size="xs"
                variant="text"
              >
                {t('remoteConnect.disclaimerReview')}
              </Button>
            </div>
          </aside>

          <main
            className="openbitfun-remote-connect__main"
            data-openbitfun-component="remote-connect-dialog"
            data-openbitfun-part="main"
            aria-labelledby="remote-connect-center-title"
          >
            {renderViewHeader()}

            {activeView === 'network' ? (
              <div
                className="openbitfun-remote-connect__subtabs"
                data-openbitfun-component="remote-connect-dialog"
                data-openbitfun-part="subtabs"
                data-openbitfun-group="network"
              >
                <TabGroup
                  aria-label={t('remoteConnect.mobileBrowserTitle')}
                  className="openbitfun-remote-connect__tab-group"
                  size="sm"
                  items={networkTabItems}
                  onClickCapture={() => { networkSelectionGenerationRef.current += 1; }}
                  onValueChange={handleNetworkTabValueChange}
                  value={networkTab}
                />
              </div>
            ) : activeView === 'bot' ? (
              <div
                className="openbitfun-remote-connect__subtabs"
                data-openbitfun-component="remote-connect-dialog"
                data-openbitfun-part="subtabs"
                data-openbitfun-group="bot"
              >
                <TabGroup
                  aria-label={t('remoteConnect.chatAppsTitle')}
                  className="openbitfun-remote-connect__tab-group"
                  size="sm"
                  items={botTabItems}
                  onValueChange={handleBotTabValueChange}
                  value={botTab}
                />
                {isBotConnected && (
                  <p className="openbitfun-remote-connect__subtabs-hint">
                    {t('remoteConnect.botSingleConnectionHint')}
                  </p>
                )}
              </div>
            ) : null}

            {activeView === 'overview' ? renderOverview() : activeView === 'account' ? (
              <div
                id="remote-connect-panel-account"
                data-openbitfun-component="remote-connect-dialog"
                data-openbitfun-part="panel"
                data-openbitfun-group="account"
                role="region"
                aria-labelledby="remote-connect-view-title"
              >
                <AccountPanel onCloseDialog={handleDialogClose} />
              </div>
            ) : activeView === 'network' ? (
              <ScrollArea
                id="remote-connect-panel-network"
                data-openbitfun-component="remote-connect-dialog"
                data-openbitfun-part="panel"
                data-openbitfun-group="network"
              >
                <div
                  id="remote-connect-network-tabpanel"
                  role="tabpanel"
                  aria-labelledby={`remote-connect-network-tab-${networkTab}`}
                >
                  {renderNetworkContent()}
                </div>
              </ScrollArea>
            ) : (
              <ScrollArea
                id="remote-connect-panel-bot"
                data-openbitfun-component="remote-connect-dialog"
                data-openbitfun-part="panel"
                data-openbitfun-group="bot"
              >
                <div
                  id="remote-connect-bot-tabpanel"
                  role="tabpanel"
                  aria-labelledby={`remote-connect-bot-tab-${botTab}`}
                >
                  {renderBotContent()}
                </div>
              </ScrollArea>
            )}
          </main>
          </div>
        </DialogBody>
      </Dialog>

      <Dialog
        open={isOpen && (disclaimerIsGate || showDisclaimer)}
        onOpenChange={(nextOpen) => { if (!nextOpen) handleDisclaimerClose(); }}
        size="lg"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('remoteConnect.disclaimerTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <RemoteConnectDisclaimer
          agreed={hasAgreedDisclaimer}
          onClose={handleDisclaimerClose}
          onAgree={hasAgreedDisclaimer ? undefined : handleAgreeDisclaimer}
        />
      </Dialog>
    </>
  );
};

export default RemoteConnectDialog;
