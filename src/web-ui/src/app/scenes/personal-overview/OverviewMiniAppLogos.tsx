import { useLayoutEffect, useRef, useState } from 'react';
import { ActionCard, Avatar, Icon, Tooltip } from '@openbitfun/ui';
import { Play } from 'lucide-react';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { pickLocalizedString } from '../miniapps/utils/pickLocalizedString';
import { renderMiniAppIcon } from '../miniapps/utils/miniAppIcons';
import './OverviewMiniAppLogos.scss';

export function OverviewMiniAppLogos({ apps, onDetails, onLaunch, onViewAll }: {
  apps: MiniAppMeta[];
  onDetails: (app: MiniAppMeta) => void;
  onLaunch: (appId: string) => void;
  onViewAll: () => void;
}) {
  const { t, currentLanguage, formatNumber } = useI18n('scenes/personal-overview');
  const rowRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [visibleCount, setVisibleCount] = useState<number | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const probe = probeRef.current;
    if (!row || !probe) return;
    const measure = () => {
      const style = getComputedStyle(row);
      const width = row.clientWidth - (Number.parseFloat(style.paddingInlineStart) || 0) - (Number.parseFloat(style.paddingInlineEnd) || 0);
      const size = probe.offsetWidth;
      // A retained, hidden overview has no measurable width until revealed.
      if (width <= 0 || size <= 0) return;
      const gap = Number.parseFloat(style.columnGap) || 0;
      const slots = Math.max(0, Math.floor((width + gap) / (size + gap)));
      const count = apps.length <= slots ? apps.length : Math.max(0, slots - 1);
      const focusedApp = document.activeElement?.closest('[data-openbitfun-component="action-card"]')?.querySelector('[data-miniapp-id]');
      const focusedIndex = focusedApp ? Array.from(row.querySelectorAll('[data-miniapp-id]')).indexOf(focusedApp) : -1;
      if (focusedIndex >= count) restoreFocus.current = true;
      setVisibleCount(count);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [apps.length]);

  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    moreRef.current?.focus({ preventScroll: true });
  }, [visibleCount]);

  const visibleApps = apps.slice(0, visibleCount ?? apps.length);
  const hiddenCount = apps.length - visibleApps.length;
  return <div className="overview-miniapp-logos" ref={rowRef} data-testid="personal-overview-miniapp-logos" data-openbitfun-scene="personal-overview" data-openbitfun-part="miniAppLogos">
    <span className="overview-miniapp-logos__probe" ref={probeRef} aria-hidden="true"><Avatar size="lg" /></span>
    {visibleApps.map(app => {
      const name = pickLocalizedString(app, currentLanguage, 'name');
      return <Tooltip key={app.id} content={name}>
        <ActionCard
          className="overview-miniapp-logos__item"
          triggerClassName="overview-miniapp-logos__trigger"
          actionPlacement="floating"
          aria-label={name}
          body={<Avatar size="lg" icon={renderMiniAppIcon(app.icon || 'box', 'lg')} aria-hidden="true" />}
          onClick={() => onDetails(app)}
          actions={[{ id: 'launch', label: t('miniApps.start'), icon: <Icon glyph={Play} size="sm" />, onClick: () => onLaunch(app.id) }]}
          data-testid="personal-overview-installed-miniapp"
          data-miniapp-id={app.id}
        />
      </Tooltip>;
    })}
    {hiddenCount > 0 && <Tooltip content={t('miniApps.moreInstalled', { count: formatNumber(hiddenCount) })}>
      <ActionCard
        ref={moreRef}
        className="overview-miniapp-logos__item"
        triggerClassName="overview-miniapp-logos__trigger"
        aria-label={t('miniApps.moreInstalled', { count: formatNumber(hiddenCount) })}
        body={<Avatar size="lg" aria-hidden="true">…</Avatar>}
        onClick={onViewAll}
        data-testid="personal-overview-more-miniapps"
      />
    </Tooltip>}
  </div>;
}
