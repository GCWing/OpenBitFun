import { useCallback, useEffect, useRef, useState } from 'react';
import { Switch } from '@openbitfun/ui';
import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import {
  desktopCardAPI,
  isDesktopPinned,
  type DesktopCardRecord,
} from '@/infrastructure/api/service-api/DesktopCardAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('DesktopCardsSettingsSection');

const sortCards = (cards: DesktopCardRecord[]): DesktopCardRecord[] =>
  [...cards].sort((a, b) => b.updatedAtMs - a.updatedAtMs);

/**
 * Reads the pinning capability from the host. Desktop cards are windows on this
 * computer, so a surface that cannot reach them simply keeps the pin row hidden.
 */
function useDesktopCardPinning(active: boolean) {
  const [supported, setSupported] = useState(false);
  const [cards, setCards] = useState<DesktopCardRecord[]>([]);

  useEffect(() => {
    if (!active || !isTauriRuntime()) return;
    let disposed = false;
    void desktopCardAPI.list()
      .then(list => {
        if (disposed) return;
        setSupported(list.desktopPinningSupported === true);
        setCards(sortCards(list.cards));
      })
      .catch(error => log.warn('Failed to read desktop cards for pinning', error));
    const unlisten = desktopCardAPI.onChanged(payload => {
      setCards(current => {
        const rest = current.filter(card => card.id !== payload.cardId);
        return payload.deleted || !payload.card ? rest : sortCards([...rest, payload.card]);
      });
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [active]);

  return { supported, cards };
}

export default function DesktopCardsSettingsSection() {
  const { t } = useI18n('settings/runtime');
  const notification = useNotification();
  const [cachedSettings] = useState(() => aiExperienceConfigService.getCachedSettings());
  const [loading, setLoading] = useState(!cachedSettings);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState<boolean | undefined>(cachedSettings?.enable_desktop_cards);
  const saveInFlight = useRef(false);
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  const cardPinning = useDesktopCardPinning(enabled === true);

  const load = useCallback(async () => {
    setLoading(!cachedSettings);
    setLoadFailed(false);
    try {
      const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true, requireLoaded: true });
      setEnabled(settings.enable_desktop_cards);
    } catch (error) {
      log.error('Failed to load desktop card settings', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [cachedSettings]);

  useEffect(() => {
    if (!cachedSettings) void load();
    return aiExperienceConfigService.addChangeListener(next => {
      setEnabled(next.enable_desktop_cards);
    });
  }, [load, cachedSettings]);

  const sectionAnchor = useSettingsSectionAnchor('desktop-cards', !loading);

  const handleToggle = async (next: boolean) => {
    if (saveInFlight.current || enabled === undefined) return;
    const scope = getActiveSurfaceScope();
    saveInFlight.current = true;
    setSaving(true);
    try {
      await aiExperienceConfigService.saveSettings({ enable_desktop_cards: next });
      if (!scope.isCurrent()) return;
      setEnabled(next);
      notification.success(t('messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save desktop card settings', error);
      notification.error(t('messages.saveFailed'));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  /** Hidden cards have no window, so this row is their only pinning entry point. */
  const handlePinnedChange = async (card: DesktopCardRecord) => {
    if (pinBusyId !== null) return;
    setPinBusyId(card.id);
    try {
      await desktopCardAPI.setDesktopPinned(card.id, !isDesktopPinned(card));
    } catch (error) {
      log.warn('Failed to change desktop card pinning', { cardId: card.id, error });
      notification.error(t('features.desktopCards.pinFailed'));
    } finally {
      setPinBusyId(null);
    }
  };

  if (loading || loadFailed) {
    return (
      <ConfigPageSection id={sectionAnchor} title={t('features.desktopCards.title')}>
        {loading
          ? <ConfigLoadingState label={t('loading.text')} />
          : <ConfigRetryState message={t('loading.failed')} retryLabel={t('loading.retry')} onRetry={() => void load()} />}
      </ConfigPageSection>
    );
  }

  return (
    <ConfigPageSection id={sectionAnchor} title={t('features.desktopCards.title')} description={t('features.desktopCards.subtitle')}>
      <ConfigPageRow
        label={t('features.desktopCards.enable')}
        align="center"
        description={enabled === undefined
          ? t('features.desktopCards.unsupported')
          : t('features.desktopCards.description')}
      >
        <Switch
          checked={enabled === true}
          onChange={event => void handleToggle(event.currentTarget.checked)}
          disabled={saving || enabled === undefined}
          aria-label={t('features.desktopCards.enable')}
        />
      </ConfigPageRow>
      {enabled === true && cardPinning.supported && cardPinning.cards.map(card => {
        const pinned = isDesktopPinned(card);
        return (
          <ConfigPageRow
            key={card.id}
            label={card.title}
            align="center"
            description={pinned
              ? t('features.desktopCards.pinnedOn')
              : t('features.desktopCards.pinnedOff')}
            data-testid="desktop-card-pin-row"
          >
            <Switch
              checked={pinned}
              onChange={() => void handlePinnedChange(card)}
              disabled={pinBusyId !== null}
              aria-label={t('features.desktopCards.pinCard', { title: card.title })}
            />
          </ConfigPageRow>
        );
      })}
    </ConfigPageSection>
  );
}
