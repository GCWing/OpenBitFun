import { useDeviceDirectory, resolveDeviceName, isDeviceControllable, deviceClientVersion } from '@/infrastructure/account/deviceDirectory';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Button, Card, CardBody, CardFooter, CardHeader, Icon, IconButton, ScrollArea, type IconSize } from '@openbitfun/ui';
import { ChevronLeft, ChevronRight, MessageCircle, Monitor, Server, Smartphone, Undo2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { useAccountIdentity } from '@/infrastructure/account-identity';
import { remoteConnectAPI, type AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { useNotification } from '@/shared/notification-system';
import {
  ChatAppBrandIcon,
  type ChatAppBrand,
} from '../../RemoteConnectDialog/ChatAppBrandIcon';
import {
  selectActivityFacts,
  selectAttachedGroups,
  type DeviceOverviewActivityFact,
  type DeviceOverviewDevice,
  type DeviceOverviewDeviceKind,
} from '../deviceInterconnectionOverview';
import { useDeviceInterconnectionOverview } from './useDeviceInterconnectionOverview';
import { DeviceArtwork } from './DeviceArtwork';

interface DeviceStatusControlProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onManageDevices: () => void;
}

/** Resolve the provider from backend ids, aliases, or display names. */
function chatAppBrandFromIdentity(identity: string | null | undefined): ChatAppBrand | null {
  const normalized = identity?.trim().toLocaleLowerCase();
  if (!normalized) return null;
  if (normalized.includes('telegram')) return 'telegram';
  if (normalized.includes('feishu') || normalized.includes('lark')) return 'feishu';
  if (normalized.includes('weixin') || normalized.includes('wechat')) return 'weixin';
  return null;
}

function DeviceIcon({
  identity,
  kind,
  size = 'sm',
}: {
  identity?: string | null;
  kind: DeviceOverviewDeviceKind;
  size?: IconSize;
}) {
  switch (kind) {
    case 'mobile':
      return <Icon glyph={Smartphone} size={size} />;
    case 'execution-host':
      return <Icon glyph={Server} size={size} />;
    case 'message-app': {
      const chatApp = chatAppBrandFromIdentity(identity);
      if (chatApp) {
        return <ChatAppBrandIcon app={chatApp} size={size} />;
      }
      return <Icon glyph={MessageCircle} size={size} />;
    }
    default:
      return <Icon glyph={Monitor} size={size} />;
  }
}

const DeviceStatusControl: React.FC<DeviceStatusControlProps> = ({
  open,
  onOpenChange,
  onManageDevices,
}) => {
  useDeviceDirectory();
  const { t } = useI18n('common');
  const { success, warning } = useNotification();
  const peerContext = usePeerDeviceModeOptional();
  const identity = useAccountIdentity();
  const accountId = identity.status === 'signed-in' ? (identity.me?.user.accountId ?? identity.me?.user.githubId) : undefined;
  const [switchTargets, setSwitchTargets] = useState<{
    accountId: string | number; localId: string; devices: AccountDeviceInfo[];
  } | null>(null);
  const [switchingDevice, setSwitchingDevice] = useState(false);
  const [returningLocal, setReturningLocal] = useState(false);
  const switchingRef = useRef(false);
  const activePeerId = peerContext?.peerMode.active ? peerContext.peerMode.deviceId : null;
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => { setPreviewId(null); }, [open, accountId, activePeerId]);

  useEffect(() => {
    if (!open || accountId === undefined) { setSwitchTargets(null); return; }
    let disposed = false;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      try {
        const [local, devices] = await Promise.all([
          remoteConnectAPI.getDeviceInfo(), remoteConnectAPI.accountListDevices(),
        ]);
        if (disposed || request !== generation) return;
        setSwitchTargets({ accountId, localId: local.device_id, devices: [
          { ...local, ...devices.find(device => device.device_id === local.device_id), online: true, last_seen_at: null },
          ...devices.filter(device => device.online && device.device_id !== local.device_id)
            .sort((a, b) => a.device_id.localeCompare(b.device_id)),
        ] });
      } catch (error) {
        if (disposed || request !== generation) return;
        setSwitchTargets(null);
        warning(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const unlisten = api.listen('account://device-presence', () => { void load(); });
    return () => { disposed = true; unlisten(); };
  }, [accountId, open, warning]);

  const availableTargets = switchTargets?.accountId === accountId ? switchTargets : null;
  const currentId = peerContext?.peerMode.active ? peerContext.peerMode.deviceId : availableTargets?.localId;
  const previewTarget = availableTargets?.devices.find(device => device.device_id === previewId);
  const isPreviewing = Boolean(previewTarget && previewTarget.device_id !== currentId);
  const browseDevice = (direction: -1 | 1) => {
    if (!availableTargets || switchingRef.current || returningLocal) return;
    const index = availableTargets.devices.findIndex(device => device.device_id === (previewTarget?.device_id ?? currentId));
    const targetIndex = index < 0
      ? (direction === 1 ? 0 : availableTargets.devices.length - 1)
      : (index + direction + availableTargets.devices.length) % availableTargets.devices.length;
    setPreviewId(availableTargets.devices[targetIndex]?.device_id ?? null);
  };
  const connectPreview = async () => {
    if (!peerContext || !availableTargets || !previewTarget || !isPreviewing || switchingRef.current || returningLocal) return;
    const target = previewTarget;
    // A confirmed-incompatible peer is shown so its state is legible, but it is
    // never a control target. This machine is never gated by its own flag.
    if (target.device_id !== availableTargets.localId && !isDeviceControllable(target)) return;
    switchingRef.current = true;
    setSwitchingDevice(true);
    try {
      if (target.device_id === availableTargets.localId) await peerContext.switchToLocal('manual');
      else await peerContext.switchToDevice(target.device_id, resolveDeviceName(target.device_id, target.device_alias ?? target.device_name ?? target.device_id));
    } catch (error) {
      warning(error instanceof Error ? error.message : String(error));
    } finally {
      switchingRef.current = false;
      setSwitchingDevice(false);
    }
  };
  const platformHint = typeof navigator === 'undefined'
    ? ''
    : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  const localDeviceLabel = /windows|win32/i.test(platformHint)
    ? t('deviceOverview.thisWindows')
    : /macintosh|macintel|mac os/i.test(platformHint)
      ? t('deviceOverview.thisMac')
      : /linux/i.test(platformHint)
        ? t('deviceOverview.thisLinux')
        : t('deviceOverview.thisDevice');
  const {
    overview,
    refresh,
  } = useDeviceInterconnectionOverview(localDeviceLabel, t('remoteConnect.mobileBrowserTitle'));
  const previewDevices: DeviceOverviewDevice[] = availableTargets?.devices.map(target =>
    target.device_id === currentId ? overview.primaryDevice
      : overview.devices.find(device => device.id === target.device_id) ?? {
        id: target.device_id, name: resolveDeviceName(target.device_id, target.device_alias ?? target.device_name ?? target.device_id), kind: 'desktop',
        local: target.device_id === availableTargets.localId, activities: [], backgroundTaskCount: 0,
      }) ?? [overview.primaryDevice];
  const previewIndex = Math.max(0, availableTargets?.devices.findIndex(
    device => device.device_id === (previewTarget?.device_id ?? currentId),
  ) ?? 0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverLayout = useAnchoredPopoverPosition({
    open,
    anchorRef: triggerRef,
    popoverRef,
    preferredPlacement: 'top',
    alignment: 'start',
    gap: 8,
  });

  useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };
    const removeOverlayKeydown0 = subscribeOverlayInteraction(popoverRef, 'keydown', onKeyDown);
    return () => removeOverlayKeydown0?.();
  }, [onOpenChange, open, refresh]);

  const handleReturnLocal = useCallback(async () => {
    if (!peerContext?.peerMode.active || returningLocal || switchingRef.current) return;
    setReturningLocal(true);
    try {
      const outcome = await peerContext.switchToLocal('manual');
      if (outcome === 'activated') {
        onOpenChange(false);
        success(t('deviceOverview.returnedToThisDevice'));
      }
    } catch (error) {
      warning(error instanceof Error ? error.message : String(error));
    } finally {
      setReturningLocal(false);
    }
  }, [onOpenChange, peerContext, returningLocal, success, t, warning]);

  const handleManageDevices = useCallback(() => {
    onOpenChange(false);
    onManageDevices();
  }, [onManageDevices, onOpenChange]);

  const activityFactSentence = useCallback((fact: DeviceOverviewActivityFact) => {
    switch (fact.kind) {
      case 'local':
        return t('deviceOverview.footerLocalSimple');
      case 'controlled-from-here':
        return t('deviceOverview.footerControlledFromHere');
      case 'controlled-by':
        return t('deviceOverview.footerControlledBy', { device: fact.device });
      case 'controllers':
        return t('deviceOverview.footerControllers', { count: fact.count });
      default:
        return t('deviceOverview.footerDistributedExecution', { count: fact.count });
    }
  }, [t]);
  const activityLines = useMemo(
    () => selectActivityFacts(overview).map(activityFactSentence),
    [activityFactSentence, overview],
  );
  const attachedGroups = useMemo(() => selectAttachedGroups(overview), [overview]);
  const attachedMessageAppIdentity = useMemo(() => (
    overview.connectedDevices.find(device => device.kind === 'message-app')?.name
  ), [overview.connectedDevices]);
  const accessibleSummary = [overview.currentWorkDeviceName, ...activityLines].join(' · ');

  const deviceActivity = useCallback((device: DeviceOverviewDevice) => {
    const parts: string[] = [];
    if (device.activities.includes('current-use')) {
      parts.push(t('deviceOverview.currentUse'));
    }
    if (device.activities.includes('controlling')) {
      parts.push(t('deviceOverview.controlling'));
    }
    if (device.activities.includes('background-execution')) {
      parts.push(t('deviceOverview.executingTasks', {
        count: device.backgroundTaskCount,
      }));
    }
    return parts.join(' · ');
  }, [t]);

  const deviceDisplayName = useCallback((device: DeviceOverviewDevice) => {
    const chatApp = device.kind === 'message-app'
      ? chatAppBrandFromIdentity(`${device.id} ${device.name}`)
      : null;
    if (chatApp === 'telegram') return 'Telegram';
    if (chatApp === 'feishu') return t('remoteConnect.feishu');
    if (chatApp === 'weixin') return t('remoteConnect.weixin');
    return device.name;
  }, [t]);

  return (
    <>
      <button data-overflow-trigger
        ref={triggerRef}
        type="button"
        className={`openbitfun-nav-panel__footer-device-status${open ? ' is-open' : ''}`}
        aria-label={accessibleSummary}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
        data-testid="nav-footer-device-status"
        data-openbitfun-component="nav-panel"
        data-openbitfun-part="deviceStatus"
        data-openbitfun-state={overview.mode}
      >
        <DeviceIcon kind={overview.primaryDevice.kind} size="sm" />
        <OverflowText className="openbitfun-nav-panel__footer-device-status-label">
          {overview.currentWorkDeviceName}
        </OverflowText>
        {attachedGroups.length > 0 && (
          <span
            className="openbitfun-nav-panel__footer-device-status-attached"
            aria-hidden="true"
          >
            {attachedGroups.map(group => (
              <span
                className="openbitfun-nav-panel__footer-device-status-attached-group"
                data-openbitfun-device-kind={group.kind}
                key={group.kind}
              >
                <DeviceIcon
                  identity={group.kind === 'message-app' ? attachedMessageAppIdentity : null}
                  kind={group.kind}
                  size="xs"
                />
                {group.count > 1 && (
                  <span className="openbitfun-nav-panel__footer-device-status-attached-count">
                    {group.count}
                  </span>
                )}
              </span>
            ))}
          </span>
        )}
      </button>

      {open && createOverlayPortal(
        <>
          <div
            className="openbitfun-nav-panel__footer-backdrop"
            onMouseDown={() => onOpenChange(false)}
            data-testid="nav-device-status-backdrop"
          />
          <Card
            ref={popoverRef}
            appearance="raised"
            className="openbitfun-device-overview"
            gap="none"
            padding="none"
            radius="lg"
            role="dialog"
            aria-label={t('deviceOverview.title')}
            data-testid="nav-device-status-popover"
            data-openbitfun-product-component="device-overview"
            data-openbitfun-product-part="root"
            data-openbitfun-state={overview.mode}
            data-openbitfun-placement={popoverLayout?.placement ?? 'top'}
            style={{
              top: `${popoverLayout?.top ?? 0}px`,
              left: `${popoverLayout?.left ?? 0}px`,
              visibility: popoverLayout ? 'visible' : 'hidden',
            }}
          >
            <CardHeader
              className="openbitfun-device-overview__header"
              contentAlign="center"
              title={<h2 className="openbitfun-device-overview__title">{t('deviceOverview.title')}</h2>}
            />
            <ScrollArea className="openbitfun-device-overview__scroll">
            <CardBody className="openbitfun-device-overview__body">
              {overview.mode === 'connected' && (
                <>
                  <section
                    className="openbitfun-device-overview__device-group"
                    data-testid="nav-device-status-connected-devices"
                  >
                    <div className="openbitfun-device-overview__device-rows">
                      {overview.connectedDevices.map(device => (
                        <div
                          className="openbitfun-device-overview__device-row"
                          key={device.id}
                          data-openbitfun-device-kind={device.kind}
                          data-openbitfun-activities={device.activities.join(' ')}
                        >
                          <span className="openbitfun-device-overview__device-icon" aria-hidden="true">
                            <DeviceIcon
                              identity={`${device.id} ${device.name}`}
                              kind={device.kind}
                              size="md"
                            />
                          </span>
                          <strong><OverflowText>{deviceDisplayName(device)}</OverflowText></strong>
                          <span>{deviceActivity(device)}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
              <div className="openbitfun-device-overview__summary" data-testid="nav-device-status-summary">
                <div className="openbitfun-device-overview__carousel-viewport">
                  <div className="openbitfun-device-overview__carousel-track"
                    style={{ transform: `translateX(-${previewIndex * 100}%)` }}>
                    {previewDevices.map((device, index) => {
                      const slideTarget = availableTargets?.devices[index];
                      // A confirmed-incompatible peer stays in the carousel so its
                      // state is legible, but it never becomes a control target.
                      const incompatible = Boolean(slideTarget
                        && slideTarget.device_id !== availableTargets?.localId
                        && !isDeviceControllable(slideTarget));
                      const incompatibleVersion = slideTarget ? deviceClientVersion(slideTarget) : null;
                      const incompatibleNotice = incompatibleVersion
                        ? t('deviceOverview.deviceClientIncompatibleWithVersion', { version: incompatibleVersion })
                        : t('deviceOverview.deviceClientIncompatible');
                      return (
                      <div className="openbitfun-device-overview__carousel-slide" key={availableTargets?.devices[index]?.device_id ?? device.id}
                        aria-hidden={index !== previewIndex}>
                        <div className="openbitfun-device-overview__device-switcher">
                          <DeviceArtwork device={device} />
                          {index === previewIndex && isPreviewing && (
                            <div className="openbitfun-device-overview__connect-overlay">
                              {incompatible ? (
                                <span
                                  className="openbitfun-device-overview__incompatible"
                                  data-testid="nav-device-status-incompatible"
                                  title={incompatibleNotice}
                                >
                                  {incompatibleNotice}
                                </span>
                              ) : (
                                <Button variant="outline" size="sm" disabled={switchingDevice || returningLocal}
                                  onClick={() => { void connectPreview(); }}>
                                  {t('deviceOverview.connectDevice')}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                        <span className="openbitfun-device-overview__device-name" title={device.name}>
                          {device.name}
                        </span>
                        <span className="openbitfun-device-overview__activity">
                          {index === previewIndex && !isPreviewing
                            ? (incompatible ? incompatibleNotice : deviceActivity(overview.primaryDevice))
                            : '\u00a0'}
                        </span>
                      </div>
                      );
                    })}
                  </div>
                </div>
                <div className="openbitfun-device-overview__carousel-controls">
                  <IconButton
                    variant="quiet" size="xs" shape="circle"
                    aria-label={t('deviceOverview.previousDevice')}
                    title={t('deviceOverview.previousDevice')}
                    icon={<Icon glyph={ChevronLeft} size="sm" />}
                    disabled={!peerContext || !availableTargets || availableTargets.devices.length < 2 || switchingDevice || returningLocal}
                    onClick={() => { browseDevice(-1); }}
                  />
                  <IconButton
                    variant="quiet" size="xs" shape="circle"
                    aria-label={t('deviceOverview.nextDevice')}
                    title={t('deviceOverview.nextDevice')}
                    icon={<Icon glyph={ChevronRight} size="sm" />}
                    disabled={!peerContext || !availableTargets || availableTargets.devices.length < 2 || switchingDevice || returningLocal}
                    onClick={() => { browseDevice(1); }}
                  />
                </div>
              </div>

              {overview.topologyUnavailable && (
                <Button
                  variant="outline"
                  size="sm"
                  leadingIcon={<Icon name="refresh" size="sm" />}
                  className="openbitfun-device-overview__notice"
                  onClick={() => { void refresh(); }}
                >
                  {t('deviceOverview.statusUnavailable')}
                </Button>
              )}
            </CardBody>
            </ScrollArea>

            <CardFooter align="center" className="openbitfun-device-overview__actions">
              <Button
                className="openbitfun-device-overview__action"
                variant="primary"
                size="sm"
                leadingIcon={<Icon name="link" size="sm" />}
                onClick={handleManageDevices}
                data-testid="nav-device-status-manage"
              >
                {t('deviceOverview.devicesAndConnections')}
              </Button>
              {overview.peerActive && (
                <Button
                  className="openbitfun-device-overview__action"
                  variant="outline"
                  size="sm"
                  leadingIcon={<Icon glyph={Undo2} size="sm" />}
                  onClick={() => { void handleReturnLocal(); }}
                  disabled={returningLocal || switchingDevice}
                  data-testid="nav-device-status-return-local"
                >
                  {returningLocal
                    ? t('deviceOverview.returningToThisDevice')
                    : t('deviceOverview.backToThisDevice')}
                </Button>
              )}
            </CardFooter>
          </Card>
        </>,
        getAppearanceOverlayHost(),
      )}
    </>
  );
};

export default DeviceStatusControl;
