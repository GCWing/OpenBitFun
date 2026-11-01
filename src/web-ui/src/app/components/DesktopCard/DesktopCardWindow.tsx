import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ellipsis, RefreshCw, X } from 'lucide-react';
import { Button, Icon, IconButton, MenuPopover, OverflowText, Spinner, type MenuEntry } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { desktopCardAPI, type DesktopCardRecord } from '@/infrastructure/api/service-api/DesktopCardAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import {
  DESKTOP_CARD_RESIZE_DIRECTIONS,
  openDesktopCardSourceSession,
  readDesktopCardIdFromLocation,
  startDesktopCardWindowDrag,
  startDesktopCardWindowResize,
} from '@/infrastructure/desktop-cards/desktopCardWindow';
import { isMacOSDesktopRuntime, supportsNativeWindowControls } from '@/infrastructure/runtime/environment';
import { createLogger } from '@/shared/utils/logger';
import {
  ChartTemplate,
  ChecklistTemplate,
  CountdownTemplate,
  CronJobTemplate,
  CustomTemplate,
  MetricsTemplate,
  NoteTemplate,
  ProgressTemplate,
} from './DesktopCardTemplates';
import { useNow } from './useNow';
import { desktopCardIcon } from './desktopCardIcons';
import {
  effectiveCardData,
  hasDataSource,
  hasUnresolvedTemplatePaths,
  isSafeWebLink,
  knownTemplate,
  normalizeTone,
  type DesktopCardFormatters,
} from './desktopCardModel';
import './DesktopCardWindow.scss';

const log = createLogger('DesktopCardWindow');

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, iframe, [role="menu"]'));
}

/**
 * Tauri's own resize border for undecorated windows is only a few pixels wide
 * and does not reliably reach these transparent card windows on Windows, so
 * these regions start the same OS resize loop. On Linux they overlap Tauri's
 * GTK edge handler harmlessly; macOS resizes natively.
 */
function DesktopCardResizeRegions({ cardId }: { cardId: string | null }) {
  const enabled = useMemo(() => supportsNativeWindowControls() && !isMacOSDesktopRuntime(), []);
  if (!enabled) return null;
  return (
    <>
      {DESKTOP_CARD_RESIZE_DIRECTIONS.map(direction => (
        <div key={direction} className="openbitfun-desktop-card__resize" data-direction={direction} aria-hidden="true"
          data-openbitfun-component="desktop-card" data-openbitfun-part="resizeHandle"
          onMouseDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            void startDesktopCardWindowResize(direction).catch(error => {
              log.debug('Failed to start desktop card resize', { cardId, direction, error });
            });
          }} />
      ))}
    </>
  );
}

function DesktopCardBody({ card, formatters, onOpenLink, onDismiss }: {
  card: DesktopCardRecord;
  formatters: DesktopCardFormatters;
  onOpenLink: (url: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n('components');
  const template = knownTemplate(card);
  const data = effectiveCardData(card);
  const toggleItem = useCallback((itemId: string, done: boolean) => {
    void desktopCardAPI.setChecklistItem(card.id, itemId, done).catch(error => {
      log.warn('Failed to update desktop card checklist item', { cardId: card.id, itemId, error });
    });
  }, [card.id]);

  if (!template) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.unsupportedTemplate')}</p>;
  if (hasDataSource(card) && !card.lastData && template.kind !== 'custom') {
    return <div className="openbitfun-desktop-card__empty" role="status"><Spinner size="sm" /><span>{t('desktopCard.loading')}</span></div>;
  }
  switch (template.kind) {
    case 'countdown': return <CountdownTemplate template={template} onDismiss={onDismiss} />;
    case 'checklist': return <ChecklistTemplate template={template} onToggle={toggleItem} />;
    case 'note': return <NoteTemplate template={template} />;
    case 'progress': return <ProgressTemplate template={template} data={data} formatters={formatters} />;
    case 'metrics': return <MetricsTemplate template={template} data={data} formatters={formatters} />;
    case 'chart': return <ChartTemplate template={template} data={data} formatters={formatters} />;
    case 'cronJob': return <CronJobTemplate template={template} formatters={formatters} />;
    case 'custom': return <CustomTemplate template={template} card={card} data={data} onOpenLink={onOpenLink} />;
  }
}

function DesktopCardFooter({ card, formatRelativeTime }: {
  card: DesktopCardRecord;
  formatRelativeTime: (value: number) => string;
}) {
  const { t } = useI18n('components');
  useNow(30_000);
  if (!hasDataSource(card) || !card.lastData) return null;
  const { error, warning, fetchedAtMs } = card.lastData;
  // Commands often write progress or notices to stderr; only flag it when values are missing.
  const stderrExplainsGaps = Boolean(warning) && hasUnresolvedTemplatePaths(card);
  const state = error ? 'error' : stderrExplainsGaps ? 'warning' : undefined;
  const time = formatRelativeTime(fetchedAtMs);
  return (
    <footer className="openbitfun-desktop-card__footer" data-state={state} title={error ?? warning}
      data-openbitfun-component="desktop-card" data-openbitfun-part="footer"
      data-openbitfun-state={state}>
      <OverflowText>
        {error
          ? t('desktopCard.refreshFailed', { error })
          : stderrExplainsGaps
            ? t('desktopCard.updatedWithWarning', { time })
            : t('desktopCard.updated', { time })}
      </OverflowText>
    </footer>
  );
}

export default function DesktopCardWindow() {
  const { t, formatNumber, formatDate, formatRelativeTime } = useI18n('components');
  const cardId = useMemo(() => readDesktopCardIdFromLocation(), []);
  const [card, setCard] = useState<DesktopCardRecord | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const formatters = useMemo<DesktopCardFormatters>(() => ({
    formatNumber,
    formatDate,
    formatRelativeTime: value => formatRelativeTime(value),
  }), [formatNumber, formatDate, formatRelativeTime]);

  useEffect(() => {
    document.documentElement.classList.add('openbitfun-desktop-card-window-root');
    document.body.classList.add('openbitfun-desktop-card-window-body');
    return () => {
      document.documentElement.classList.remove('openbitfun-desktop-card-window-root');
      document.body.classList.remove('openbitfun-desktop-card-window-body');
    };
  }, []);

  useEffect(() => {
    if (!cardId) {
      setLoadFailed(true);
      return;
    }
    let disposed = false;
    const unlisten = desktopCardAPI.onChanged(payload => {
      if (disposed || payload.cardId !== cardId) return;
      if (payload.card) setCard(payload.card);
    });
    void desktopCardAPI.get(cardId)
      .then(record => { if (!disposed) setCard(record); })
      .catch(error => {
        log.warn('Failed to load desktop card', { cardId, error });
        if (!disposed) setLoadFailed(true);
      });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [cardId]);

  const openLink = useCallback((url: string) => {
    if (!isSafeWebLink(url)) return;
    void systemAPI.openExternal(url).catch(error => {
      log.warn('Failed to open desktop card link', { cardId, error });
    });
  }, [cardId]);

  const hide = useCallback(() => {
    if (!cardId) return;
    void desktopCardAPI.setVisible(cardId, false).catch(error => {
      log.warn('Failed to hide desktop card', { cardId, error });
    });
  }, [cardId]);

  const remove = useCallback(() => {
    if (!cardId) return;
    void desktopCardAPI.delete(cardId).catch(error => {
      log.warn('Failed to delete desktop card', { cardId, error });
    });
  }, [cardId]);

  const refresh = useCallback(() => {
    if (!cardId || refreshing) return;
    setRefreshing(true);
    void desktopCardAPI.refresh(cardId)
      .then(setCard)
      .catch(error => log.warn('Failed to refresh desktop card', { cardId, error }))
      .finally(() => setRefreshing(false));
  }, [cardId, refreshing]);

  const onHeaderMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.detail > 1 || isInteractiveTarget(event.target)) return;
    event.preventDefault();
    void startDesktopCardWindowDrag().catch(error => {
      log.debug('Failed to start desktop card drag', { cardId, error });
    });
  };

  if (!card) {
    return (
      <div className="openbitfun-desktop-card" data-state="loading"
        data-openbitfun-component="desktop-card" data-openbitfun-part="root" data-openbitfun-state="loading">
        <div className="openbitfun-desktop-card__empty" role="status">
          {loadFailed ? <span>{t('desktopCard.loadFailed')}</span> : <Spinner size="sm" />}
        </div>
        <DesktopCardResizeRegions cardId={cardId} />
      </div>
    );
  }

  const tone = normalizeTone(card.accent) ?? 'accent';
  const sessionId = card.origin?.sessionId;
  const link = isSafeWebLink(card.link) ? card.link : null;
  const menuItems: MenuEntry[] = [
    ...(hasDataSource(card) ? [{ id: 'refresh', label: t('desktopCard.menu.refresh'), onSelect: refresh }] : []),
    ...(link ? [{ id: 'open-link', label: t('desktopCard.menu.openLink'), onSelect: () => openLink(link) }] : []),
    ...(sessionId ? [{
      id: 'open-session',
      label: t('desktopCard.menu.openSession'),
      onSelect: () => {
        void openDesktopCardSourceSession(sessionId).catch(error => {
          log.warn('Failed to open desktop card source session', { cardId: card.id, error });
        });
      },
    }] : []),
    {
      id: 'always-on-top',
      label: t('desktopCard.menu.alwaysOnTop'),
      role: 'menuitemcheckbox',
      checked: card.alwaysOnTop,
      onSelect: () => {
        void desktopCardAPI.setAlwaysOnTop(card.id, !card.alwaysOnTop).catch(error => {
          log.warn('Failed to toggle desktop card always-on-top', { cardId: card.id, error });
        });
      },
    },
    { id: 'separator', label: '', separator: true },
    { id: 'hide', label: t('desktopCard.menu.hide'), onSelect: hide },
    { id: 'delete', label: t('desktopCard.menu.delete'), tone: 'danger', onSelect: () => setConfirmingDelete(true) },
  ];
  const CardIcon = desktopCardIcon(card);

  return (
    <div className="openbitfun-desktop-card" data-tone={tone} data-template={card.template?.kind}
      data-openbitfun-component="desktop-card" data-openbitfun-part="root">
      <header className="openbitfun-desktop-card__header" onMouseDown={onHeaderMouseDown}
        onDoubleClick={() => { if (link) openLink(link); }}
        data-openbitfun-component="desktop-card" data-openbitfun-part="header">
        <span className="openbitfun-desktop-card__icon" aria-hidden="true"
          data-openbitfun-component="desktop-card" data-openbitfun-part="icon"><Icon glyph={CardIcon} size="sm" /></span>
        <div className="openbitfun-desktop-card__titles">
          <OverflowText className="openbitfun-desktop-card__title"
            data-openbitfun-component="desktop-card" data-openbitfun-part="title">{card.title}</OverflowText>
          {card.subtitle && (
            <OverflowText className="openbitfun-desktop-card__subtitle"
              data-openbitfun-component="desktop-card" data-openbitfun-part="subtitle">{card.subtitle}</OverflowText>
          )}
        </div>
        <div className="openbitfun-desktop-card__actions" data-openbitfun-component="desktop-card" data-openbitfun-part="actions">
          {hasDataSource(card) && (
            <IconButton size="xs" aria-label={t('desktopCard.menu.refresh')} loading={refreshing}
              icon={<Icon glyph={RefreshCw} size="xs" />} onClick={refresh} />
          )}
          <IconButton ref={menuButtonRef} size="xs" aria-label={t('desktopCard.menu.more')} aria-haspopup="menu"
            aria-expanded={menuOpen} icon={<Icon glyph={Ellipsis} size="xs" />} onClick={() => setMenuOpen(open => !open)} />
          <IconButton size="xs" aria-label={t('desktopCard.menu.hide')} icon={<Icon glyph={X} size="xs" />} onClick={hide} />
        </div>
      </header>
      <div className="openbitfun-desktop-card__body" data-openbitfun-component="desktop-card" data-openbitfun-part="body">
        {confirmingDelete ? (
          <div className="openbitfun-desktop-card__confirm" role="alertdialog" aria-label={t('desktopCard.deleteConfirm.title')}>
            <p>{t('desktopCard.deleteConfirm.message')}</p>
            <div className="openbitfun-desktop-card__confirm-actions">
              <Button size="sm" variant="secondary" onClick={() => setConfirmingDelete(false)}>{t('desktopCard.deleteConfirm.cancel')}</Button>
              <Button size="sm" variant="primary" tone="danger" onClick={remove}>{t('desktopCard.deleteConfirm.confirm')}</Button>
            </div>
          </div>
        ) : (
          <DesktopCardBody card={card} formatters={formatters} onOpenLink={openLink} onDismiss={remove} />
        )}
      </div>
      <DesktopCardFooter card={card} formatRelativeTime={formatters.formatRelativeTime} />
      <MenuPopover items={menuItems} open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuButtonRef}
        placement="bottom" inlineSize="content" />
      <DesktopCardResizeRegions cardId={cardId} />
    </div>
  );
}
