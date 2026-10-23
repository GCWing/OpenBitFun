import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Pin, PinOff, Settings, Trash2 } from 'lucide-react';
import { Button, Icon, IconButton, OverflowText } from '@openbitfun/ui';
import {
  desktopCardAPI,
  isDesktopPinned,
  type DesktopCardRecord,
} from '@/infrastructure/api/service-api/DesktopCardAPI';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import { useSceneStore } from '@/app/stores/sceneStore';
import { desktopCardIcon } from '@/app/components/DesktopCard/desktopCardIcons';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { OverviewSplitCard, OverviewSplitCardSection } from './OverviewSplitCard';
import './OverviewDesktopCardsSection.scss';

const log = createLogger('OverviewDesktopCardsSection');

type CardsState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; enabled: boolean; cards: DesktopCardRecord[]; pinningSupported: boolean };

function sortCards(cards: DesktopCardRecord[]): DesktopCardRecord[] {
  return [...cards].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function openDesktopCardSettings() {
  useSettingsStore.getState().openDestination({ pageId: 'application.pet', sectionId: 'desktop-cards' });
  useSceneStore.getState().openScene('settings');
}

/** Desktop cards are windows on this computer, so this section always reflects the local host. */
export function OverviewDesktopCardsSection({ isActive }: { isActive: boolean }) {
  const { t, formatNumber } = useI18n('scenes/personal-overview');
  const notification = useNotification();
  const [state, setState] = useState<CardsState>({ status: 'loading' });
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const supported = isTauriRuntime();

  const load = useCallback(async () => {
    try {
      const list = await desktopCardAPI.list();
      setState({
        status: 'ready',
        enabled: list.enabled,
        cards: sortCards(list.cards),
        pinningSupported: list.desktopPinningSupported === true,
      });
    } catch (error) {
      log.warn('Failed to load desktop cards', error);
      setState(current => current.status === 'ready' ? current : { status: 'failed' });
    }
  }, []);

  useEffect(() => {
    if (!supported || !isActive) return;
    void load();
    const unlistenChanged = desktopCardAPI.onChanged(payload => {
      setState(current => {
        if (current.status !== 'ready') return current;
        const rest = current.cards.filter(card => card.id !== payload.cardId);
        return { ...current, cards: payload.deleted || !payload.card ? rest : sortCards([...rest, payload.card]) };
      });
    });
    const unlistenState = desktopCardAPI.onStateChanged(payload => {
      setState(current => current.status === 'ready' ? { ...current, enabled: payload.enabled } : current);
    });
    return () => {
      unlistenChanged();
      unlistenState();
    };
  }, [supported, isActive, load]);

  if (!supported) return null;

  const toggleVisible = async (card: DesktopCardRecord) => {
    setBusyCardId(card.id);
    try {
      await desktopCardAPI.setVisible(card.id, !card.visible);
    } catch (error) {
      log.warn('Failed to change desktop card visibility', { cardId: card.id, error });
      notification.error(t('desktopCards.actionFailed'));
    } finally {
      setBusyCardId(null);
    }
  };

  const togglePinned = async (card: DesktopCardRecord) => {
    setBusyCardId(card.id);
    try {
      // Works for hidden cards too: the host keeps the preference and applies
      // it when the card is shown again.
      await desktopCardAPI.setDesktopPinned(card.id, !isDesktopPinned(card));
    } catch (error) {
      log.warn('Failed to change desktop card pinning', { cardId: card.id, error });
      notification.error(t('desktopCards.actionFailed'));
    } finally {
      setBusyCardId(null);
    }
  };

  const deleteCard = async (card: DesktopCardRecord) => {
    const confirmed = await confirmDanger(
      t('desktopCards.deleteConfirmTitle'),
      t('desktopCards.deleteConfirmMessage', { title: card.title }),
      { confirmText: t('desktopCards.delete') },
    );
    if (!confirmed) return;
    setBusyCardId(card.id);
    try {
      await desktopCardAPI.delete(card.id);
    } catch (error) {
      log.warn('Failed to delete desktop card', { cardId: card.id, error });
      notification.error(t('desktopCards.actionFailed'));
    } finally {
      setBusyCardId(null);
    }
  };

  const cards = state.status === 'ready' ? state.cards : [];
  const enabled = state.status === 'ready' && state.enabled;
  const pinningSupported = state.status === 'ready' && state.pinningSupported;
  const visibleCount = cards.filter(card => card.visible).length;
  const summaryValue = state.status === 'ready' ? formatNumber(cards.length) : t(state.status === 'loading' ? 'loadingValue' : 'unavailableValue');
  const summaryDescription = state.status !== 'ready'
    ? t(state.status === 'loading' ? 'desktopCards.loading' : 'desktopCards.failed')
    : enabled
      ? t('desktopCards.visibleCount', { count: formatNumber(visibleCount) })
      : t('desktopCards.disabled');

  return (
    <section className="personal-overview__section" aria-labelledby="overview-desktop-cards-title" aria-busy={state.status === 'loading'}
      data-openbitfun-scene="personal-overview" data-openbitfun-part="desktopCards">
      <div className="personal-overview__section-header">
        <h2 id="overview-desktop-cards-title" className="personal-overview__section-title">{t('desktopCards.title')}</h2>
        <Button className="personal-overview__section-action" variant="text" size="sm" leadingIcon={<Icon glyph={Settings} size="sm" />}
          onClick={openDesktopCardSettings} data-testid="personal-overview-desktop-card-settings">
          {t('desktopCards.settings')}
        </Button>
      </div>
      <div className="personal-overview__catalog">
        <OverviewSplitCard>
          <OverviewSplitCardSection title={t('desktopCards.title')}
            value={<span data-testid="personal-overview-desktop-card-count">{summaryValue}</span>}
            description={summaryDescription} />
          <OverviewSplitCardSection title={t('desktopCards.listTitle')}>
            {state.status === 'failed' ? (
              <div className="personal-overview__catalog-status" role="status">
                <span>{t('desktopCards.failed')}</span>
                <Button variant="secondary" size="sm" onClick={() => void load()}>{t('retry')}</Button>
              </div>
            ) : state.status === 'loading' ? (
              <p className="personal-overview__catalog-empty" role="status">{t('desktopCards.loading')}</p>
            ) : cards.length === 0 ? (
              <p className="personal-overview__catalog-empty">{t('desktopCards.empty')}</p>
            ) : (
              <ul className="overview-desktop-cards" data-testid="personal-overview-desktop-card-list">
                {cards.map(card => {
                  const CardIcon = desktopCardIcon(card);
                  const busy = busyCardId === card.id;
                  const pinned = isDesktopPinned(card);
                  return (
                    <li key={card.id} className="overview-desktop-cards__item"
                      data-visible={card.visible ? 'true' : 'false'}
                      data-pinned={pinned ? 'true' : 'false'}>
                      <span className="overview-desktop-cards__icon" aria-hidden="true"><Icon glyph={CardIcon} size="sm" /></span>
                      <div className="overview-desktop-cards__copy" data-overflow-trigger>
                        <OverflowText className="overview-desktop-cards__title">{card.title}</OverflowText>
                        <OverflowText className="overview-desktop-cards__meta">
                          {card.visible ? t('desktopCards.shown') : t('desktopCards.hidden')}
                          {pinned ? ` · ${t('desktopCards.pinned')}` : ''}
                          {card.subtitle ? ` · ${card.subtitle}` : ''}
                        </OverflowText>
                      </div>
                      {pinningSupported && (
                        <IconButton size="sm" disabled={busy}
                          aria-label={pinned ? t('desktopCards.unpin') : t('desktopCards.pin')}
                          aria-pressed={pinned}
                          icon={<Icon glyph={pinned ? PinOff : Pin} size="sm" />}
                          onClick={() => void togglePinned(card)} />
                      )}
                      <IconButton size="sm" disabled={busy || (!card.visible && !enabled)}
                        aria-label={card.visible ? t('desktopCards.hide') : t('desktopCards.show')}
                        icon={<Icon glyph={card.visible ? EyeOff : Eye} size="sm" />}
                        onClick={() => void toggleVisible(card)} />
                      <IconButton size="sm" tone="danger" disabled={busy} aria-label={t('desktopCards.delete')}
                        icon={<Icon glyph={Trash2} size="sm" />} onClick={() => void deleteCard(card)} />
                    </li>
                  );
                })}
              </ul>
            )}
          </OverviewSplitCardSection>
        </OverviewSplitCard>
      </div>
    </section>
  );
}
