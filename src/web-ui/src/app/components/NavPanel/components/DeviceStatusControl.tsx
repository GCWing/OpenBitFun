import { useDeviceDirectory, resolveDeviceName, isDeviceControllable, deviceClientVersion } from '@/infrastructure/account/deviceDirectory';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Button, Card, CardBody, CardHeader, Icon, IconButton, ScrollArea, StatusPill, type IconSize } from '@openbitfun/ui';
import { ChevronLeft, ChevronRight, CircleAlert, MessageCircle, Monitor, MonitorSmartphone, Smartphone, Undo2, Unplug } from 'lucide-react';
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
  type DeviceOverviewActivityFact,
  type DeviceOverviewDevice,
  type DeviceOverviewDeviceKind,
  type DeviceOverviewHostKind,
} from '../deviceInterconnectionOverview';
import { useDeviceInterconnectionOverview } from './useDeviceInterconnectionOverview';
import { DeviceArtwork } from './DeviceArtwork';
import { DeviceSystemGlyph } from './DeviceSystemGlyph';
import { useDevicePreviewMotion } from './useDevicePreviewMotion';

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
  const { t, formatNumber } = useI18n('common');
  const { warning } = useNotification();
  const peerContext = usePeerDeviceModeOptional();
  const identity = useAccountIdentity();
  const accountId = identity.status === 'signed-in' ? (identity.me?.user.accountId ?? identity.me?.user.githubId) : undefined;
  const [switchTargets, setSwitchTargets] = useState<{
    accountId: string | number; localId: string; devices: AccountDeviceInfo[];
  } | null>(null);
  const [switchingAction, setSwitchingAction] = useState<'connect' | 'switch' | 'disconnect' | null>(null);
  const switchingDevice = switchingAction !== null;
  const switchingRef = useRef(false);
  const activePeerId = peerContext?.peerMode.active ? peerContext.peerMode.deviceId : null;
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => {
    setPreviewId(null);
  }, [open, accountId, activePeerId]);

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
  const carouselDeviceIds = availableTargets?.devices.map(device => device.device_id) ?? [];
  // Presence can lag behind a live control link; keep its disconnect entry reachable.
  if (availableTargets && activePeerId && !carouselDeviceIds.includes(activePeerId)) {
    carouselDeviceIds.unshift(activePeerId);
  }
  const currentId = peerContext?.peerMode.active ? peerContext.peerMode.deviceId : availableTargets?.localId;
  const previewTarget = availableTargets?.devices.find(device => device.device_id === previewId);
  const isPreviewing = Boolean(previewTarget && previewTarget.device_id !== currentId);
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
    ? carouselDeviceIds.map(deviceId => {
        const target = availableTargets.devices.find(device => device.device_id === deviceId);
        const known = deviceId === currentId
          ? overview.primaryDevice
          : overview.devices.find(device => device.id === `device:${deviceId}`
            || (device.local && deviceId === availableTargets.localId));
        const device: DeviceOverviewDevice = known ?? {
          id: deviceId, name: resolveDeviceName(deviceId, target?.device_alias ?? target?.device_name ?? deviceId), kind: 'desktop',
          local: deviceId === availableTargets.localId, activities: [], backgroundTaskCount: 0,
        };
        return {
          ...device,
          os: target?.device_os ?? device.os ?? null,
          hostKind: deviceHostKind(deviceId, target?.device_kind) ?? device.hostKind ?? null,
        };
      })
    : [{
        // No account directory here, so the only new fact a device can bring is
        // what its control link says; the projection already carried the rest.
        ...overview.primaryDevice,
        hostKind: deviceHostKind(currentId) ?? overview.primaryDevice.hostKind,
      }];
  const previewIndex = Math.max(0, carouselDeviceIds.indexOf(previewTarget?.device_id ?? currentId ?? ''));
  const previewTargetDevice = availableTargets?.devices.find(device => device.device_id === carouselDeviceIds[previewIndex]);
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
  const artworkRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const paginationRef = useRef<HTMLSpanElement>(null);
  const selectPreview = useCallback((deviceId: string) => {
    setPreviewId(deviceId);
  }, []);
  const previewMotion = useDevicePreviewMotion({
    scope: JSON.stringify([open, accountId, activePeerId, carouselDeviceIds]),
    surfaceRef: popoverRef,
    artworkRef,
    headingRef,
    actionsRef,
    paginationRef,
    onSelect: selectPreview,
  });
  const connectPreview = async () => {
    if (!peerContext || !availableTargets || !previewTarget || !isPreviewing || switchingRef.current || previewMotion.isTransitioning) return;
    const target = previewTarget;
    // A confirmed-incompatible peer is shown so its state is legible, but it is
    // never a control target. This machine is never gated by its own flag.
    if (target.device_id !== availableTargets.localId && !isDeviceControllable(target)) return;
    switchingRef.current = true;
    const alreadyConnected = peerContext.attachments.some(attachment => (
      attachment.deviceId === target.device_id && attachment.health === 'ready'
    ));
    setSwitchingAction(target.device_id === availableTargets.localId || alreadyConnected ? 'switch' : 'connect');
    try {
      if (target.device_id === availableTargets.localId) await peerContext.switchToLocal('manual');
      else await peerContext.switchToDevice(target.device_id, resolveDeviceName(target.device_id, target.device_alias ?? target.device_name ?? target.device_id));
      popoverRef.current?.focus();
    } catch (error) {
      warning(error instanceof Error ? error.message : String(error));
    } finally {
      switchingRef.current = false;
      setSwitchingAction(null);
    }
  };
  const browseDevice = (direction: -1 | 1) => {
    if (!availableTargets || switchingRef.current) return;
    const selectedId = previewMotion.pendingDeviceId() ?? previewTarget?.device_id ?? currentId ?? '';
    const index = carouselDeviceIds.indexOf(selectedId);
    const targetIndex = index < 0
      ? (direction === 1 ? 0 : carouselDeviceIds.length - 1)
      : (index + direction + carouselDeviceIds.length) % carouselDeviceIds.length;
    const targetId = carouselDeviceIds[targetIndex];
    if (targetId) previewMotion.navigateTo(targetId, direction);
  };
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

  const handleDisconnect = useCallback(async () => {
    if (!peerContext || !activePeerId || switchingRef.current) return;
    switchingRef.current = true;
    setSwitchingAction('disconnect');
    try {
      await peerContext.disconnectDevice(activePeerId, 'manual');
      (popoverRef.current ?? triggerRef.current)?.focus();
    } catch (error) {
      warning(error instanceof Error ? error.message : String(error));
    } finally {
      switchingRef.current = false;
      setSwitchingAction(null);
    }
  }, [activePeerId, peerContext, warning]);

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
  const listedDevices = overview.connectedDevices.filter(device => !overview.peerActive || !device.local);
  const accessibleSummary = [overview.currentWorkDeviceName, ...activityLines].join(' · ');

  const deviceActivity = useCallback((device: DeviceOverviewDevice) => {
    const parts = [device.local
      ? t('deviceOverview.currentLocalDevice')
      : t('deviceOverview.currentUse')];
    if (device.activities.includes('controlling')
      || (overview.peerActive && !device.local && device.activities.includes('current-use'))) {
      parts.push(t('deviceOverview.controlling'));
    }
    if (device.activities.includes('background-execution')) {
      parts.push(t('deviceOverview.executingTasks', {
        count: device.backgroundTaskCount,
      }));
    }
    return parts.join(' · ');
  }, [overview.peerActive, t]);

  const deviceDisplayName = useCallback((device: DeviceOverviewDevice) => {
    const chatApp = device.kind === 'message-app'
      ? chatAppBrandFromIdentity(`${device.id} ${device.name}`)
      : null;
    if (chatApp === 'telegram') return 'Telegram';
    if (chatApp === 'feishu') return t('remoteConnect.feishu');
    if (chatApp === 'weixin') return t('remoteConnect.weixin');
    return device.name;
  }, [t]);
  const displayedDevice = previewDevices[previewIndex] ?? overview.primaryDevice;
  const displayedActive = !displayedDevice.local
    && displayedDevice.activities.includes('current-use') && overview.peerActive;
  const displayedConnected = peerContext?.attachments.some(attachment => (
    attachment.deviceId === carouselDeviceIds[previewIndex] && attachment.health === 'ready'
  )) ?? false;
  const displayedIncompatible = previewIncompatible && !displayedActive;
  const displayedHasAction = displayedActive || isPreviewing || displayedIncompatible;
  const displayedActionLabel = displayedIncompatible
    ? previewIncompatibleNotice
    : displayedActive ? t('deviceOverview.disconnectActionHint')
      : displayedDevice.local ? t('deviceOverview.backToThisDevice')
        : displayedConnected ? t('deviceOverview.switchUse') : t('deviceOverview.connectAndUse');
  const displayedIdleActionText = displayedIncompatible ? t('deviceOverview.unavailableAction')
    : displayedActive ? t('deviceOverview.disconnectAction')
      : displayedDevice.local ? t('deviceOverview.returnLocalAction')
        : displayedConnected ? t('deviceOverview.switchUse') : t('deviceOverview.connectAndUse');
  const displayedActionText = switchingAction === 'connect' ? t('deviceOverview.connectingAction')
    : switchingAction === 'switch' ? t('deviceOverview.switchingAction')
      : switchingAction === 'disconnect' ? t('deviceOverview.disconnectingAction')
        : displayedIdleActionText;

  return (
    <>
      <div className="openbitfun-nav-panel__footer-device-control">
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
          <OverflowText className="openbitfun-nav-panel__footer-device-status-label" title="">
            {overview.currentWorkDeviceName}
          </OverflowText>
        </button>
        {overview.peerActive && activePeerId && (
          <Button
            variant="text"
            size="xs"
            labelBehavior="static"
            className="openbitfun-nav-panel__footer-remote-control"
            leadingIcon={<Icon name="link" size="sm" />}
            aria-label={`${overview.currentWorkDeviceName} · ${t('deviceOverview.cancelRemoteControl')}`}
            title={t('deviceOverview.disconnectActionHint')}
            disabled={switchingDevice}
            loading={switchingAction === 'disconnect'}
            onClick={() => { void handleDisconnect(); }}
            data-testid="nav-footer-cancel-remote"
          >
            {switchingAction === 'disconnect'
              ? t('deviceOverview.disconnectingAction')
              : t('deviceOverview.cancelRemoteControl')}
          </Button>
        )}
      </div>

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
            clip
            role="dialog"
            tabIndex={-1}
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
              align="center"
              contentAlign="start"
              actions={(
                <div className="openbitfun-device-overview__header-actions">
                  <IconButton
                    className="openbitfun-device-overview__manage-devices"
                    variant="quiet"
                    size="sm"
                    shape="circle"
                    icon={<Icon glyph={MonitorSmartphone} size="md" />}
                    aria-label={t('deviceOverview.devicesAndConnections')}
                    title={t('deviceOverview.devicesAndConnections')}
                    onClick={handleManageDevices}
                    data-testid="nav-device-status-manage"
                  />
                </div>
              )}
            />
            <ScrollArea className="openbitfun-device-overview__scroll">
            <CardBody className="openbitfun-device-overview__body">
              <div className="openbitfun-device-overview__summary" data-testid="nav-device-status-summary">
                <div className="openbitfun-device-overview__carousel-viewport">
                  <div className="openbitfun-device-overview__device-scene"
                    ref={artworkRef}
                    role="group"
                    aria-label={[displayedDevice.name, deviceActivity(displayedDevice)].join(' · ')}
                    data-control-state={displayedIncompatible ? 'incompatible' : displayedActive ? 'active' : displayedDevice.local ? 'local' : 'available'}>
                    <DeviceArtwork device={displayedDevice} />
                  </div>
                </div>
                <div className="openbitfun-device-overview__device-details">
                  {carouselDeviceIds.length > 1 && (
                    <div className="openbitfun-device-overview__carousel-controls">
                      <IconButton
                        className="openbitfun-device-overview__carousel-button"
                        variant="quiet" size="sm" shape="circle"
                        aria-label={t('deviceOverview.previousDevice')}
                        title={t('deviceOverview.previousDevice')}
                        icon={<Icon glyph={ChevronLeft} size="sm" />}
                        disabled={!peerContext || switchingDevice}
                        onClick={() => { browseDevice(-1); }}
                      />
                      <IconButton
                        className="openbitfun-device-overview__carousel-button"
                        variant="quiet" size="sm" shape="circle"
                        aria-label={t('deviceOverview.nextDevice')}
                        title={t('deviceOverview.nextDevice')}
                        icon={<Icon glyph={ChevronRight} size="sm" />}
                        disabled={!peerContext || switchingDevice}
                        onClick={() => { browseDevice(1); }}
                      />
                    </div>
                  )}
                  {previewDevices.length > 1 && (
                    <span className="openbitfun-device-overview__pagination" data-testid="nav-device-status-pagination">
                      <span className="openbitfun-device-overview__pagination-index" ref={paginationRef}
                        style={{ minInlineSize: `${formatNumber(previewDevices.length).length}ch` }}>
                        {formatNumber(previewIndex + 1)}
                      </span>
                      {' / '}
                      <span data-testid="nav-device-status-total">{formatNumber(previewDevices.length)}</span>
                    </span>
                  )}
                  <div className="openbitfun-device-overview__device-heading" ref={headingRef} data-overflow-trigger aria-live="polite" aria-atomic="true">
                    <OverflowText className="openbitfun-device-overview__device-name" title="" data-testid="nav-device-status-name">
                      {displayedDevice.name}
                    </OverflowText>
                    {displayedActive && (
                      <StatusPill
                        className="openbitfun-device-overview__usage-badge"
                        tone="success"
                        data-testid="nav-device-usage-status"
                      >
                        {t('deviceOverview.inUse')}
                      </StatusPill>
                    )}
                  </div>
                </div>
                <div className="openbitfun-device-overview__device-actions" ref={actionsRef}>
                  {!displayedHasAction && displayedDevice.local && (
                    <StatusPill tone="neutral" data-testid="nav-device-status-local">
                      {t('deviceOverview.localDevice')}
                    </StatusPill>
                  )}
                  {displayedHasAction && (
                    <div className="openbitfun-device-overview__device-status"
                      role="group"
                      aria-label={[displayedDevice.name, deviceActivity(displayedDevice)].join(' · ')}
                      data-control-state={displayedIncompatible ? 'incompatible' : displayedActive ? 'active' : displayedDevice.local ? 'local' : 'available'}>
                      <Button
                        className="openbitfun-device-overview__connection-status"
                        variant={displayedIncompatible ? 'fill' : 'primary'}
                        size="xs"
                        labelBehavior="static"
                        leadingIcon={displayedIncompatible
                          ? <Icon glyph={CircleAlert} size="sm" tone="warning" />
                          : displayedActive ? <Icon glyph={Unplug} size="sm" />
                            : displayedDevice.local ? <Icon glyph={Undo2} size="sm" /> : <Icon name="link" size="sm" />}
                        aria-label={`${displayedDevice.name} · ${displayedActionLabel}`}
                        title={displayedActionLabel}
                        disabled={displayedIncompatible || (!displayedActive && !isPreviewing) || !peerContext || switchingDevice || previewMotion.isTransitioning}
                        loading={switchingDevice}
                        data-testid={displayedIncompatible ? 'nav-device-status-incompatible'
                          : displayedActive ? 'nav-device-status-disconnect'
                            : displayedDevice.local ? 'nav-device-status-return-local' : 'nav-device-status-connect'}
                        onClick={displayedIncompatible ? undefined : displayedActive
                          ? () => { void handleDisconnect(); }
                          : () => { void connectPreview(); }}
                      >
                        <OverflowText title="">{displayedActionText}</OverflowText>
                      </Button>
                    </div>
                  )}
                </div>
                {overview.topologyUnavailable && (
                  <IconButton
                    variant="quiet"
                    size="xs"
                    shape="circle"
                    icon={<Icon name="refresh" size="sm" tone="warning" />}
                    className="openbitfun-device-overview__notice"
                    aria-label={t('deviceOverview.statusUnavailable')}
                    title={t('deviceOverview.statusUnavailable')}
                    onClick={() => { void refresh(); }}
                  />
                )}
              </div>

              {listedDevices.length > 0 && (
                <section
                  className="openbitfun-device-overview__device-group"
                  data-testid="nav-device-status-connected-devices"
                >
                  <div className="openbitfun-device-overview__device-rows">
                    {listedDevices.map(device => (
                      <div
                        className="openbitfun-device-overview__device-row"
                        key={device.id}
                        data-openbitfun-device-kind={device.kind}
                        data-openbitfun-activities={device.activities.join(' ')}
                        role="group"
                        aria-label={`${deviceDisplayName(device)} · ${deviceActivity(device)}`}
                      >
                        <span className="openbitfun-device-overview__device-icon" aria-hidden="true">
                          <DeviceMark
                            device={device}
                            identity={`${device.id} ${device.name}`}
                            size="md"
                          />
                        </span>
                        <strong><OverflowText title="">{deviceDisplayName(device)}</OverflowText></strong>
                        {device.backgroundTaskCount > 0 && (
                          <span className="openbitfun-device-overview__task-count">
                            {formatNumber(device.backgroundTaskCount)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

            </CardBody>
            </ScrollArea>

          </Card>
        </>,
        getAppearanceOverlayHost(),
      )}
    </>
  );
};

export default DeviceStatusControl;
