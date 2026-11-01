import { createContext, forwardRef, useContext, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { Menu, MenuList, MenuPopover, OverflowText, type MenuEntry } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { SessionTitleNumber } from '@/flow_chat/components/SessionTitleNumber';
import { useSessionTabLabels } from '../../hooks/useSessionTabLabels';
import { useSceneStore } from '../../stores/sceneStore';
import type { SceneTab } from './types';
import './SessionTabHistoryMenu.scss';

const HistorySurfaceContext = createContext<{
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  number?: string;
  onClose: () => void;
} | null>(null);

/** Keep one menu surface at the capsule's origin; reveal its size without scaling text. */
const HistorySurface: typeof Menu = forwardRef(function HistorySurface(props, forwardedRef) {
  const context = useContext(HistorySurfaceContext)!;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const anchor = context.anchorRef.current;
    const root = rootRef.current;
    if (!anchor || !root) return;
    const rect = anchor.getBoundingClientRect();
    const left = Number(props.style?.left ?? rect.left);
    const top = Number(props.style?.top ?? rect.top);
    root.style.setProperty('--_session-history-source-width', `${rect.width}px`);
    root.style.setProperty('--_session-history-source-height', `${rect.height}px`);
    root.style.setProperty('--_session-history-source-left', `${Math.max(0, rect.left - left)}px`);
    root.style.setProperty('--_session-history-source-top', `${Math.max(0, rect.top - top)}px`);
  }, [context.anchorRef, props.style?.left, props.style?.top]);

  return <div data-openbitfun-component="scene-bar" data-openbitfun-part="history"><Menu {...props}
    autoFocusFirstItem={!props['aria-hidden']}
    ref={node => {
      rootRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }}
    className={`${props.className ?? ''} openbitfun-session-tab-history`}
  >
    <button type="button" tabIndex={-1} className="openbitfun-session-tab-history__header"
      data-overflow-trigger
      onClick={event => { event.stopPropagation(); context.onClose(); context.anchorRef.current?.focus(); }}>
      <OverflowText behavior="marquee">{context.title}</OverflowText>
      {context.number && <SessionTitleNumber number={context.number} />}
    </button>
    <MenuList className="openbitfun-session-tab-history__rows">{props.children}</MenuList>
  </Menu></div>;
});

const historyParts = { root: HistorySurface };

interface SessionTabHistoryMenuProps {
  tab: SceneTab;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

export function SessionTabHistoryMenu({ tab, anchorRef, open, onClose }: SessionTabHistoryMenuProps) {
  const { t } = useI18n('common');
  const tabs = useMemo<SceneTab[]>(() => tab.session
    ? (tab.sessionHistory ?? [tab.session.sessionId]).slice(0, 5).map(sessionId => ({
      id: `session:${sessionId}`, lastUsed: 0, session: { ...tab.session!, sessionId },
    })) : [], [tab.session, tab.sessionHistory]);
  const labels = useSessionTabLabels(tabs);
  const scope = getActiveSurfaceScope();
  const items: MenuEntry[] = tabs.flatMap(entry => {
    const label = labels[entry.id];
    const target = entry.session!;
    if (!label || target.surfaceId !== scope.surfaceId) return [];
    return [{
      id: target.sessionId,
      label: label.title,
      shortcut: label.number ? <SessionTitleNumber number={label.number} /> : undefined,
      role: 'menuitemradio',
      checked: target.sessionId === tab.session?.sessionId,
      onSelect: () => {
        const isCurrent = () => scope.isCurrent()
          && useSceneStore.getState().openTabs.some(candidate => candidate.id === tab.id
            && candidate.session
            && candidate.session === tab.session
            && (candidate.sessionHistory ?? [candidate.session.sessionId]).includes(target.sessionId));
        useSceneStore.getState().openSessionScene(target, { isCurrent });
      },
    }];
  });
  const currentLabel = labels[`session:${tab.session?.sessionId}`];

  return <HistorySurfaceContext.Provider value={{ anchorRef, title: currentLabel?.title ?? '', number: currentLabel?.number, onClose }}><MenuPopover
    aria-label={t('sceneBar.recentSessions')}
    items={items}
    anchorRef={anchorRef}
    open={open}
    onClose={onClose}
    overlapAnchor
    exitDurationMs={140}
    parts={historyParts}
  /></HistorySurfaceContext.Provider>;
}
