/**
 * NavBar — navigation controls and the current left-panel title.
 *
 * Sits at the top of the left column on the shared 45px workbench chrome row.
 * Layout: [panel][←][→] [scene title / drag region]
 *
 * - Back/Forward buttons mirror IDE navigation history.
 * - The title follows left-panel navigation, independently of the right scene.
 * - Non-interactive space remains a drag region for moving the window.
 */

import React, { useCallback, useMemo, useRef } from 'react';

import { useNavSceneStore } from '../../stores/navSceneStore';
import { getSceneNavTitleKey } from '../../scenes/nav-registry';
import { useI18n } from '../../../infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { isMacOSDesktopRuntime, startNativeWindowDragging, supportsNativeWindowDragging } from '@/infrastructure/runtime';
import './NavBar.scss';
import { Icon, OverflowText, Tooltip } from '@openbitfun/ui';

const log = createLogger('NavBar');

const INTERACTIVE_SELECTOR =
  'button, input, textarea, select, a, [role="button"], [contenteditable="true"], .window-controls, [role="menu"]';

interface NavBarProps {
  className?: string;
  isCollapsed?: boolean;
  onExpandNav?: () => void;
  onMaximize?: () => void;
}

const NavBar: React.FC<NavBarProps> = ({
  className = '',
  isCollapsed = false,
  onExpandNav,
  onMaximize,
}) => {
  const { t } = useI18n('common');
  const isMacOS = useMemo(() => {
    return isMacOSDesktopRuntime();
  }, []);
  const canDragWindow = supportsNativeWindowDragging();
  const showSceneNav = useNavSceneStore(s => s.showSceneNav);
  const navSceneId   = useNavSceneStore(s => s.navSceneId);
  const goBack       = useNavSceneStore(s => s.goBack);
  const goForward    = useNavSceneStore(s => s.goForward);
  const canGoBack    = showSceneNav && !!navSceneId;
  const canGoForward = !showSceneNav && !!navSceneId;
  const titleKey = showSceneNav && navSceneId ? getSceneNavTitleKey(navSceneId) : null;
  const title = titleKey ? t(titleKey) : null;
  const lastMouseDownTimeRef = useRef<number>(0);

  const handleBarMouseDown = useCallback((e: React.MouseEvent) => {
    if (!canDragWindow) return;

    const now = Date.now();
    const timeSinceLastMouseDown = now - lastMouseDownTimeRef.current;
    lastMouseDownTimeRef.current = now;

    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    if (timeSinceLastMouseDown < 500 && timeSinceLastMouseDown > 50) return;

    void startNativeWindowDragging().catch(error => {
      log.debug('startDragging failed', error);
    });
  }, [canDragWindow]);

  const handleBarDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    onMaximize?.();
  }, [onMaximize]);

  const rootClassName = `openbitfun-nav-bar${isCollapsed ? ' openbitfun-nav-bar--collapsed' : ''}${isMacOS ? ' openbitfun-nav-bar--macos' : ''} ${className}`;

  if (isCollapsed) {
    return (
      <div data-openbitfun-component="nav-bar" data-openbitfun-part="root" data-openbitfun-state="collapsed" data-openbitfun-theme-scope="chrome" className={rootClassName} role="toolbar" aria-label={t('nav.aria.navControl')} onMouseDown={handleBarMouseDown} onDoubleClick={handleBarDoubleClick}>
        <Tooltip content={t('header.expandLeftPanel')} placement="bottom" followCursor>
          <button
            type="button"
            className="openbitfun-nav-bar__panel-toggle"
            data-openbitfun-component="nav-bar"
            data-openbitfun-part="panelToggle"
            onClick={onExpandNav}
            aria-label={t('header.expandLeftPanel')}
          >
            <Icon name="sidebar-left" size="sm" />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div data-openbitfun-component="nav-bar" data-openbitfun-part="root" data-openbitfun-theme-scope="chrome" className={rootClassName} role="toolbar" aria-label={t('nav.aria.navControl')} onMouseDown={handleBarMouseDown} onDoubleClick={handleBarDoubleClick}>
      <Tooltip content={t('header.collapseLeftPanel')} placement="bottom" followCursor>
        <button
          type="button"
          className="openbitfun-nav-bar__panel-toggle"
          data-openbitfun-component="nav-bar"
          data-openbitfun-part="panelToggle"
          onClick={onExpandNav}
          aria-label={t('header.collapseLeftPanel')}
        >
          <Icon name="sidebar-left" size="sm" />
        </button>
      </Tooltip>

      {/* Back / Forward */}
      <Tooltip content={t('nav.backShortcut')} placement="bottom" followCursor disabled={!canGoBack}>
        <button
          type="button"
          className={`openbitfun-nav-bar__btn${!canGoBack ? ' is-inactive' : ''}`}
          data-openbitfun-component="nav-bar"
          data-openbitfun-part="back"
          onClick={canGoBack ? goBack : undefined}
          aria-disabled={!canGoBack}
          aria-label={t('nav.back')}
        >
          <Icon name="arrow-left" size="sm" />
        </button>
      </Tooltip>

      <Tooltip content={t('nav.forwardShortcut')} placement="bottom" followCursor disabled={!canGoForward}>
        <button
          type="button"
          className={`openbitfun-nav-bar__btn${!canGoForward ? ' is-inactive' : ''}`}
          data-openbitfun-component="nav-bar"
          data-openbitfun-part="forward"
          onClick={canGoForward ? goForward : undefined}
          aria-disabled={!canGoForward}
          aria-label={t('nav.forward')}
        >
          <Icon name="arrow-right" size="sm" />
        </button>
      </Tooltip>

      {title && (
        <OverflowText
          className="openbitfun-nav-bar__title"
          data-openbitfun-component="nav-bar"
          data-openbitfun-part="title"
          title={title}
        >
          {title}
        </OverflowText>
      )}
    </div>
  );
};

export default NavBar;
