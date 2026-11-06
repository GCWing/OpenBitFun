/**
 * The session list grouped by device.
 *
 * Exactly one device is rendered by the window (Peer Device Mode). Its section
 * is the live `WorkspaceListSection`; every other online host of the account
 * gets a section fed by the read-only device catalog, loaded only once the
 * section is expanded. Sections keep a fixed order, so opening something on
 * another device changes the rendered device without moving the list.
 *
 * With a single device the list renders exactly as before, without headers.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Icon, OverflowText } from '@openbitfun/ui';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceId, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { deviceWorkspaceCatalog } from '@/infrastructure/peer-device/deviceWorkspaceCatalog';
import WorkspaceListSection from '../workspaces/WorkspaceListSection';
import DeviceCatalogSection from './DeviceCatalogSection';
import { useDeviceOpenIntent } from '@/infrastructure/peer-device/deviceOpenIntent';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { installBackgroundSurfaceSeeding } from '@/flow_chat/services/backgroundSurfaceSeeding';
import { useDeviceVisibilityPreferences } from '@/app/navigation/deviceVisibilityPreferences';
import { devicePlatform, useDeviceSectionDisclosure, useSidebarDevices, type SidebarDeviceSlot } from './useSidebarDevices';
import './DeviceWorkspaceSections.scss';

interface DeviceWorkspaceSectionsProps {
  scrollRootRef?: React.RefObject<HTMLElement | null>;
}

function useCatalogHasWorkspaces(surfaceId: string): boolean {
  const subscribe = useCallback((notify: () => void) => deviceWorkspaceCatalog.subscribe(changed => {
    if (changed === surfaceId) notify();
  }), [surfaceId]);
  const read = useCallback(() => deviceWorkspaceCatalog.getSnapshot(surfaceId).workspaces.length > 0
    || workspaceManager.getSurfaceOpenedWorkspaces(surfaceId).length > 0, [surfaceId]);
  return useSyncExternalStore(subscribe, read, read);
}

function useCatalogLoading(surfaceId: string, rendered: boolean): boolean {
  const subscribe = useCallback((notify: () => void) => deviceWorkspaceCatalog.subscribe(changed => {
    if (changed === surfaceId) notify();
  }), [surfaceId]);
  const read = useCallback(
    () => !rendered && deviceWorkspaceCatalog.getSnapshot(surfaceId).status === 'loading',
    [rendered, surfaceId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Hold the list's height and scroll offset while a cross-device open runs.
 * Sections hand over between catalog and live rows during a switch; without
 * the hold, a momentarily shorter list clamps the scroll position to the top.
 */
function useSwitchLayoutHold(
  containerRef: React.RefObject<HTMLDivElement | null>,
  scrollRootRef?: React.RefObject<HTMLElement | null>,
): void {
  const switching = useDeviceOpenIntent(state => state.intent !== null);
  const held = useRef<{ scrollTop: number; userScrolled: boolean } | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const scrollRoot = scrollRootRef?.current;
    if (!container) return;
    if (switching) {
      container.style.minHeight = `${container.offsetHeight}px`;
      const hold = { scrollTop: scrollRoot?.scrollTop ?? 0, userScrolled: false };
      held.current = hold;
      const onWheel = () => { hold.userScrolled = true; };
      scrollRoot?.addEventListener('wheel', onWheel, { passive: true });
      scrollRoot?.addEventListener('touchmove', onWheel, { passive: true });
      return () => {
        scrollRoot?.removeEventListener('wheel', onWheel);
        scrollRoot?.removeEventListener('touchmove', onWheel);
      };
    }
    const hold = held.current;
    held.current = null;
    if (!hold) return;
    // Let the live rows settle, then restore the offset and release the floor.
    let frame = 0;
    let frames = 0;
    const settle = () => {
      if (scrollRoot && !hold.userScrolled && scrollRoot.scrollTop !== hold.scrollTop) scrollRoot.scrollTop = hold.scrollTop;
      if (++frames < 20) frame = requestAnimationFrame(settle);
      else container.style.minHeight = '';
    };
    frame = requestAnimationFrame(settle);
    return () => { cancelAnimationFrame(frame); container.style.minHeight = ''; };
  }, [containerRef, scrollRootRef, switching]);
}

const DeviceSection: React.FC<{
  slot: SidebarDeviceSlot;
  scrollRootRef?: React.RefObject<HTMLElement | null>;
}> = ({ slot, scrollRootRef }) => {
  const { t } = useI18n('common');
  const bodyId = useId();
  const explicit = useDeviceSectionDisclosure(state => state.expanded[slot.surfaceId]);
  const setExpanded = useDeviceSectionDisclosure(state => state.setExpanded);
  // Every device starts open: its sessions coexist with this machine's.
  const expanded = explicit ?? true;
  const opening = useDeviceOpenIntent(state => state.intent?.surfaceId === slot.surfaceId);
  const loading = useCatalogLoading(slot.surfaceId, slot.rendered) || (opening && !slot.rendered);
  // While the rendered device's live catalog hydrates after a switch, keep
  // drawing its warm device catalog so the list neither empties nor jumps.
  // Only a live list that has nothing yet is hydrating: activating a workspace
  // also sets `loading`, and must not swap the list it is clicked in.
  const { loading: liveLoading, openedWorkspacesList } = useWorkspaceContext();
  const liveHydrating = liveLoading && openedWorkspacesList.length === 0;
  const hasCatalog = useCatalogHasWorkspaces(slot.surfaceId);
  // During a cross-device open every device draws its background projection,
  // which uses the live list's data and rules; the rendered device hands over
  // to its live list once, after the open, so its reads never delay the open.
  const switching = useDeviceOpenIntent(state => state.intent !== null);
  const showLive = slot.rendered && ((!switching && !liveHydrating) || !hasCatalog);
  // CLI hosts say so; client hosts name their platform.
  const platform = devicePlatform(slot.os);
  const hostTag = slot.hostKind === 'cli' ? t('nav.devices.hostCli')
    : platform ? t(`nav.devices.platform.${platform}`) : null;
  const toggleLabel = t(expanded ? 'nav.devices.collapse' : 'nav.devices.expand', { name: slot.name });

  return (
    <section className={['openbitfun-nav-panel__device-section', slot.rendered && 'is-rendered', expanded && 'is-expanded'].filter(Boolean).join(' ')}
      data-openbitfun-component="nav-device-section" data-openbitfun-part="root"
      data-openbitfun-state={[slot.rendered && 'rendered', expanded && 'expanded'].filter(Boolean).join(' ') || undefined}
      data-testid="nav-device-section" data-device-surface={slot.surfaceId}
      aria-label={slot.name}>
        <button type="button" className="openbitfun-nav-panel__device-header"
          data-openbitfun-component="nav-device-section" data-openbitfun-part="header"
          aria-expanded={expanded} aria-controls={bodyId} aria-label={toggleLabel}
          aria-current={slot.rendered ? 'true' : undefined}
          data-testid="nav-device-section-toggle"
          onClick={() => setExpanded(slot.surfaceId, !expanded)}>
          <OverflowText className="openbitfun-nav-panel__device-name">{slot.name}</OverflowText>
          {hostTag && <span className="openbitfun-nav-panel__device-pill" data-host-kind={slot.hostKind ?? undefined}>{hostTag}</span>}
          {slot.rendered && <span className="openbitfun-nav-panel__device-current" role="img" aria-label={t('nav.devices.current')} />}
          {loading && (
            <span className="openbitfun-nav-panel__device-spinner-wrap" role={opening ? 'status' : undefined}
              aria-label={opening ? t('nav.devices.connecting', { name: slot.name }) : undefined}>
              <Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" />
            </span>
          )}
        </button>
      {expanded && (
        <div id={bodyId} className="openbitfun-nav-panel__device-body" data-openbitfun-component="nav-device-section" data-openbitfun-part="body">
          {showLive
            ? <WorkspaceListSection variant="all" scrollRootRef={scrollRootRef} limitFlatRows />
            : <DeviceCatalogSection slot={slot} />}
        </div>
      )}
    </section>
  );
};

const DeviceWorkspaceSections: React.FC<DeviceWorkspaceSectionsProps> = ({ scrollRootRef }) => {
  const { t } = useI18n('common');
  const devices = useSidebarDevices(t('deviceOverview.thisDevice'));
  const hidden = useDeviceVisibilityPreferences(state => state.hidden);
  const slots = devices.filter(slot => hidden[slot.surfaceId] !== true);
  const activeSurfaceId = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceId, getActiveSurfaceId);
  const setExpanded = useDeviceSectionDisclosure(state => state.setExpanded);

  // Every listed host keeps its session statuses current (debounced host
  // invalidations), whether or not its section is open. The rendered device is
  // kept warm too, so leaving it shows its catalog at once instead of a reload.
  const backgroundSurfaces = slots.filter(slot => slot.controllable && (devices.length > 1 || !slot.rendered))
    .map(slot => slot.surfaceId).join('\n');
  const multiDevice = devices.length > 1;
  useEffect(() => (multiDevice ? installBackgroundSurfaceSeeding() : undefined), [multiDevice]);
  useEffect(() => {
    if (!backgroundSurfaces) return;
    const releases = backgroundSurfaces.split('\n').map(surfaceId => deviceWorkspaceCatalog.retainActivity(surfaceId));
    return () => { for (const release of releases) release(); };
  }, [backgroundSurfaces]);

  // Whatever renders a device (this list, the device switcher, a create flow)
  // reveals its section, so the opened item is never hidden behind a header.
  useEffect(() => {
    if (useDeviceSectionDisclosure.getState().expanded[activeSurfaceId] === false) {
      setExpanded(activeSurfaceId, true);
    }
  }, [activeSurfaceId, setExpanded]);

  const containerRef = useRef<HTMLDivElement>(null);
  useSwitchLayoutHold(containerRef, scrollRootRef);

  if (slots.length === 0) return null;
  if (devices.length === 1 && slots[0].rendered) {
    return <WorkspaceListSection variant="all" scrollRootRef={scrollRootRef} />;
  }
  return (
    <div ref={containerRef} className="openbitfun-nav-panel__device-sections" data-testid="nav-device-sections">
      {slots.map(slot => <DeviceSection key={slot.surfaceId} slot={slot} scrollRootRef={scrollRootRef} />)}
    </div>
  );
};

export default DeviceWorkspaceSections;
