import { ActionCard, Icon, MenuPopover, OverflowText, StatusPill } from '@openbitfun/ui';
import { MonitorDown, Play } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useI18n } from '@/infrastructure/i18n';
import { renderMiniAppIcon } from '../utils/miniAppIcons';
import { pickLocalizedString } from '../utils/pickLocalizedString';
import type { MiniAppLibraryStatus } from './MiniAppLibraryRow';
import './MiniAppInstalledCard.scss';

interface MiniAppInstalledCardProps {
  app: MiniAppMeta;
  itemKey: string;
  statuses: MiniAppLibraryStatus[];
  onOpenDetails: () => void;
  onLaunch: () => void;
  onAddToSystem: () => Promise<void>;
  onDelete: () => void;
  systemAppSupported: boolean;
  launchDisabled?: boolean;
  launchDisabledReason?: string;
  busy?: boolean;
}

export default function MiniAppInstalledCard({
  app, itemKey, statuses, onOpenDetails, onLaunch, onAddToSystem, onDelete, systemAppSupported,
  launchDisabled, launchDisabledReason, busy,
}: MiniAppInstalledCardProps) {
  const { t, currentLanguage } = useI18n('scenes/miniapp');
  const menuId = useId();
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addingToSystem, setAddingToSystem] = useState(false);
  const addingToSystemRef = useRef(false);
  const actionsDisabled = busy || addingToSystem;
  const name = pickLocalizedString(app, currentLanguage, 'name');
  const description = pickLocalizedString(app, currentLanguage, 'description');
  const activityStatuses = statuses.filter(status => status.tone === 'info' || status.tone === 'accent' || status.tone === 'warning');

  const addToSystem = async () => {
    if (!systemAppSupported || busy || addingToSystemRef.current) return;
    addingToSystemRef.current = true;
    setAddingToSystem(true);
    try {
      await onAddToSystem();
    } finally {
      addingToSystemRef.current = false;
      setAddingToSystem(false);
    }
  };

  return (
    <article className="miniapp-installed-card" role="listitem" data-market-key={itemKey}
      data-openbitfun-component="miniapp-gallery-view" data-openbitfun-part="item">
      <ActionCard
        className="miniapp-installed-card__surface"
        triggerClassName="miniapp-installed-card__content"
        actionPlacement="floating"
        aria-label={t('market.library.viewDetails', { name })}
        onClick={onOpenDetails}
        leading={renderMiniAppIcon(app.icon || 'box', 32)}
        actions={[
          { id: 'launch', label: t('card.start'), tooltip: launchDisabledReason ?? t('card.start'),
            icon: <Icon className="miniapp-installed-card__launch-icon" glyph={Play} size="sm" />, disabled: launchDisabled || actionsDisabled, loading: busy, onClick: onLaunch },
          { id: 'more', label: t('presentation.moreActions'), tooltip: t('presentation.moreActions'),
            icon: <Icon name="more" size="sm" />, disabled: actionsDisabled, loading: addingToSystem,
            'aria-haspopup': 'menu', 'aria-expanded': menuOpen, 'aria-controls': menuOpen ? menuId : undefined,
            onClick: (event) => {
              moreTriggerRef.current = event.currentTarget;
              setMenuOpen((open) => !open);
            } },
        ]}
        body={<span className="miniapp-installed-card__copy" data-openbitfun-component="miniapp-gallery-view" data-openbitfun-part="summary">
          <span className="miniapp-installed-card__title" data-openbitfun-component="miniapp-gallery-view" data-openbitfun-part="title">
            <OverflowText behavior="marquee">{name}</OverflowText>
            {activityStatuses.map(status => <StatusPill key={`${status.tone}:${status.label}`} tone={status.tone}>{status.label}</StatusPill>)}
          </span>
          <OverflowText className="miniapp-installed-card__description">{description}</OverflowText>
        </span>}
      />
      <MenuPopover
        id={menuId}
        anchorRef={moreTriggerRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        aria-label={t('presentation.moreActions')}
        title={systemAppSupported ? undefined : t('presentation.unsupported')}
        aria-description={systemAppSupported ? undefined : t('presentation.unsupported')}
        items={[
          { id: 'install', label: t('presentation.install'), icon: <Icon glyph={MonitorDown} size="sm" />,
            disabled: !systemAppSupported || actionsDisabled, onSelect: () => void addToSystem() },
          { id: 'delete', label: t('card.delete'), icon: <Icon name="delete" size="sm" />,
            disabled: actionsDisabled, tone: 'danger', onSelect: onDelete },
        ]}
      />
    </article>
  );
}
