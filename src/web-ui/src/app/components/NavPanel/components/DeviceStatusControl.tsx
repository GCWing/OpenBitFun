import { useDeviceDirectory, resolveDeviceName, isDeviceControllable, deviceClientVersion } from '@/infrastructure/account/deviceDirectory';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Button, Card, CardBody, CardFooter, CardHeader, Icon, IconButton, ScrollArea, type IconSize } from '@openbitfun/ui';
import { ChevronLeft, ChevronRight, MessageCircle, Monitor, Smartphone, Undo2 } from 'lucide-react';
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
  reportedHostKind,
  selectActivityFacts,
  selectAttachedGroups,
  type DeviceOverviewActivityFact,
  type DeviceOverviewDevice,
  type DeviceOverviewDeviceKind,
  type DeviceOverviewHostKind,
} from '../deviceInterconnectionOverview';
import { useDeviceInterconnectionOverview } from './useDeviceInterconnectionOverview';
import { DeviceArtwork } from './DeviceArtwork';
import { DeviceSystemGlyph } from './DeviceSystemGlyph';

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

/**
 * The class of headless hosts the footer names as one group. A group is not a
 * device, so it carries the facts its mark is resolved from and nothing else:
 * the kind already decides that mark, and the name, system and host kind a row
 * would answer with do not exist at this level.
 */
const HEADLESS_HOST_CLASS: React.ComponentProps<typeof DeviceSystemGlyph>['device'] = {
  kind: 'execution-host',
  name: '',
  os: null,
  hostKind: null,
};

/**
 * The kinds that are not a system: a phone, a chat app, and the neutral monitor
 * for a kind this build cannot place. A desktop and a headless host are the
 * machines the device marks draw, so they never reach this switch.
 */
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

/**
 * The mark in front of a device's name. A host answers with the system it runs,
 * the same mark the device list draws. A phone and a chat app are the two kinds
 * that are not a system — one is drawn as a phone and one as its brand — so they
 * keep the silhouette that says what they are.
 */
function DeviceMark({
  device,
  identity,
  size = 'sm',
}: {
  device: DeviceOverviewDevice;
  identity?: string | null;
  size?: IconSize;
}) {
  if (device.kind === 'mobile' || device.kind === 'message-app') {
    return <DeviceIcon identity={identity} kind={device.kind} size={size} />;
  }
  return <DeviceSystemGlyph device={device} size={size} />;
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
  /**
   * This machine as the overview sees it: its own entry while a peer is in use,
   * the primary device while none is. The attached cluster draws its system
   * instead of a generic kind icon, so a controller reads as the device it is,
   * the way the same device reads in the device list.
   */
  const thisMachine = useMemo(() => (
    overview.primaryDevice.local
      ? overview.primaryDevice
      : overview.devices.find(device => device.local) ?? overview.primaryDevice
  ), [overview]);
  /**
   * A device says what it is by the kind it reported to the Relay, so the
   * account directory is enough for any device. A live control link can say
   * something newer — a host that just changed profile, or one on an older
   * Relay that could not report the kind — so it wins when it answers.
   */
  const deviceHostKind = useCallback((
    deviceId: string | null | undefined,
    reportedKind?: string | null,
  ): DeviceOverviewHostKind | null => {
    const fromLink = !deviceId || !peerContext
      ? null
      : peerContext.peerMode.active && peerContext.peerMode.deviceId === deviceId
        ? peerContext.currentPeerCapabilities?.hostKind ?? null
        : peerContext.attachments
          .find(attachment => attachment.deviceId === deviceId)?.capabilities?.hostKind ?? null;
    return fromLink ?? reportedHostKind(reportedKind);
  }, [peerContext]);
  const previewDevices: DeviceOverviewDevice[] = availableTargets
    ? availableTargets.devices.map(target => {
        const known = target.device_id === currentId
          ? overview.primaryDevice
          : overview.devices.find(device => device.id === target.device_id);
        const device: DeviceOverviewDevice = known ?? {
          id: target.device_id, name: resolveDeviceName(target.device_id, target.device_alias ?? target.device_name ?? target.device_id), kind: 'desktop',
          local: target.device_id === availableTargets.localId, activities: [], backgroundTaskCount: 0,
        };
        return {
          ...device,
          os: target.device_os ?? device.os ?? null,
          hostKind: deviceHostKind(target.device_id, target.device_kind) ?? device.hostKind ?? null,
        };
      })
    : [{
        // No account directory here, so the only new fact a device can bring is
        // what its control link says; the projection already carried the rest.
        ...overview.primaryDevice,
        hostKind: deviceHostKind(currentId) ?? overview.primaryDevice.hostKind,
      }];
  const previewIndex = Math.max(0, availableTargets?.devices.findIndex(
    device => device.device_id === (previewTarget?.device_id ?? currentId),
  ) ?? 0);
  const previewTargetDevice = availableTargets?.devices[previewIndex];
  // A confirmed-incompatible peer stays in the carousel so its state is legible,
  // but it never becomes a control target.
  const previewIncompatible = Boolean(previewTargetDevice
    && previewTargetDevice.device_id !== availableTargets?.localId
    && !isDeviceControllable(previewTargetDevice));
  const previewIncompatibleVersion = previewTargetDevice ? deviceClientVersion(previewTargetDevice) : null;
  const previewIncompatibleNotice = previewIncompatibleVersion
    ? t('deviceOverview.deviceClientIncompatibleWithVersion', { version: previewIncompatibleVersion })
    : t('deviceOverview.deviceClientIncompatible');
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
      // "In use" says nothing about which machine it is; on this machine the row
      // has to name it, because the artwork above shows a device either way.
      parts.push(device.local
        ? t('deviceOverview.currentLocalDevice')
        : t('deviceOverview.currentUse'));
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
        {/* The label names a device, and this mark says which system that device
            is: the machine the window works on, whichever end of the connection
            it sits on. */}
        <DeviceMark device={overview.primaryDevice} size="sm" />
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
                {group.kind === 'desktop' ? (
                  // The only desktop a client can be attached to is itself: the
                  // overview marks this machine's own entry as the controlling
                  // one, and a peer is the device being used instead of an
                  // attached one. It draws the system this machine reported, so
                  // the group names the same device the list does, rather than a
                  // second generic monitor.
                  <DeviceMark device={thisMachine} size="xs" />
                ) : group.kind === 'execution-host' ? (
                  // A group of headless hosts is a class, not one device, so there
                  // is no row to read a system from: it draws the mark the list
                  // draws for each of them, the way the desktop group does, rather
                  // than a second server glyph of its own.
                  <DeviceSystemGlyph device={HEADLESS_HOST_CLASS} size="xs" />
                ) : (
                  <DeviceIcon
                    identity={group.kind === 'message-app' ? attachedMessageAppIdentity : null}
                    kind={group.kind}
                    size="xs"
                  />
                )}
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
                            <DeviceMark
                              device={device}
                              identity={`${device.id} ${device.name}`}
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
                      return (
                      <div className="openbitfun-device-overview__carousel-slide" key={availableTargets?.devices[index]?.device_id ?? device.id}
                        aria-hidden={index !== previewIndex}>
                        <div className="openbitfun-device-overview__device-switcher">
                          <DeviceArtwork device={device} />
                        </div>
                        <OverflowText className="openbitfun-device-overview__device-name" title={device.name}>
                          {device.name}
                        </OverflowText>
                      </div>
                      );
                    })}
                  </div>
                </div>
                {/* Reserve one action row when showing current-device status so
                    browsing peers keeps the artwork and name in place. */}
                <div className="openbitfun-device-overview__connect-action">
                  {!isPreviewing && (
                    <span className="openbitfun-device-overview__activity">
                      {previewIncompatible ? previewIncompatibleNotice : deviceActivity(overview.primaryDevice)}
                    </span>
                  )}
                  <Button
                    labelBehavior="static"
                    variant="outline"
                    size="sm"
                    // A device cannot connect to itself, so this machine's button
                    // is inert and invisible while still laying the row out.
                    className={isPreviewing ? undefined : 'openbitfun-device-overview__connect-reserved'}
                    disabled={!isPreviewing || previewIncompatible || switchingDevice || returningLocal}
                    aria-hidden={isPreviewing ? undefined : true}
                    tabIndex={isPreviewing ? undefined : -1}
                    title={previewIncompatible ? previewIncompatibleNotice : undefined}
                    data-testid={previewIncompatible ? 'nav-device-status-incompatible' : undefined}
                    onClick={isPreviewing && !previewIncompatible ? () => { void connectPreview(); } : undefined}
                  >
                    {previewIncompatible ? previewIncompatibleNotice : t('deviceOverview.connectDevice')}
                  </Button>
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
