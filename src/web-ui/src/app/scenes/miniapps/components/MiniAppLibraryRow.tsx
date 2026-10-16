import { OverflowText, Button, Icon, StatusPill, type StatusPillTone } from '@openbitfun/ui';
import {
  GalleryHorizontalEnd,
  HardDrive,
  Package,
  Star,
  UserRound,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { MarketImage } from '@/app/components/GalleryLayout/MarketImage';
import type { MiniAppLibraryAction } from '../views/miniAppLibraryItems';

interface MiniAppLibraryStatus {
  label: string;
  tone: StatusPillTone;
}

interface MiniAppLibraryRowProps {
  itemKey: string;
  action: MiniAppLibraryAction;
  actionDisabled?: boolean;
  actionLabel: string;
  actionTitle?: string;
  busy?: boolean;
  category: string;
  description: string;
  detailsLabel: string;
  downloadCount?: string;
  localMeta?: string;
  launchActions?: React.ReactNode;
  metaLabel?: string;
  name: string;
  onOpenDetails: () => void;
  onPrimaryAction: () => void;
  owner?: string;
  rating?: string;
  showcaseAlt: string;
  showcaseFallbackLabel: string;
  showcaseUrl?: string;
  statuses: MiniAppLibraryStatus[];
  version: string;
}

const MiniAppLibraryRow: React.FC<MiniAppLibraryRowProps> = ({
  itemKey,
  action,
  actionDisabled = false,
  actionLabel,
  actionTitle,
  busy = false,
  category,
  description,
  detailsLabel,
  downloadCount,
  localMeta,
  launchActions,
  metaLabel,
  name,
  onOpenDetails,
  onPrimaryAction,
  owner,
  rating,
  showcaseAlt,
  showcaseFallbackLabel,
  showcaseUrl,
  statuses,
  version,
}) => {
  const [showcaseUnavailable, setShowcaseUnavailable] = useState(!showcaseUrl);

  useEffect(() => {
    setShowcaseUnavailable(!showcaseUrl);
  }, [showcaseUrl]);

  return (
    <article
      className="miniapp-library-row"
      role="listitem"
      data-market-key={itemKey}
      data-action={action}
      data-openbitfun-component="miniapp-gallery-view"
      data-openbitfun-part="item"
    >
      <button data-overflow-trigger
        type="button"
        className="miniapp-library-row__details"
        aria-label={detailsLabel}
        onClick={onOpenDetails}
      >
        <span
          className="miniapp-library-row__showcase"
          data-openbitfun-component="miniapp-gallery-view"
          data-openbitfun-part="showcase"
        >
          {!showcaseUnavailable && showcaseUrl ? (
            <MarketImage
              source={showcaseUrl}
              responsive
              sizes="auto, (min-width: 720px) 680px, 100vw"
              width={640}
              height={360}
              alt={showcaseAlt}
              loading="lazy"
              decoding="async"
              onError={() => setShowcaseUnavailable(true)}
            />
          ) : (
            <span
              className="miniapp-library-row__showcase-fallback"
              aria-label={showcaseFallbackLabel}
              role="img"
            >
              <GalleryHorizontalEnd size={34} strokeWidth={1.35} aria-hidden="true" />
            </span>
          )}
        </span>

        <span
          className="miniapp-library-row__summary"
          data-openbitfun-component="miniapp-gallery-view"
          data-openbitfun-part="summary"
        >
          <span
            className="miniapp-library-row__title-row"
            data-openbitfun-component="miniapp-gallery-view"
            data-openbitfun-part="title"
          >
            <strong className="miniapp-library-row__name"><OverflowText>{name}</OverflowText></strong>
            <StatusPill className="miniapp-library-row__category" tone="neutral">
              {category}
            </StatusPill>
          </span>
          <span className="miniapp-library-row__description">{description}</span>
          <span
            className="miniapp-library-row__meta"
            data-openbitfun-component="miniapp-gallery-view"
            data-openbitfun-part="meta"
            role="group"
            aria-label={[version, metaLabel].filter(Boolean).join(', ')}
          >
            <span className="miniapp-library-row__meta-item">
              <Package size={13} strokeWidth={1.8} aria-hidden="true" />
              <OverflowText>{version}</OverflowText>
            </span>
            {owner ? (
              <span className="miniapp-library-row__meta-item miniapp-library-row__meta-item--owner">
                <UserRound size={13} strokeWidth={1.8} aria-hidden="true" />
                <OverflowText>{owner.includes('@') ? owner : `@${owner}`}</OverflowText>
              </span>
            ) : null}
            {rating ? (
              <span className="miniapp-library-row__meta-item">
                <Star size={13} strokeWidth={1.8} aria-hidden="true" />
                <OverflowText>{rating}</OverflowText>
              </span>
            ) : null}
            {downloadCount ? (
              <span className="miniapp-library-row__meta-item">
                <Icon name="arrow-down" size="xs" aria-hidden />
                <OverflowText>{downloadCount}</OverflowText>
              </span>
            ) : null}
            {localMeta ? (
              <span className="miniapp-library-row__meta-item miniapp-library-row__meta-item--local">
                <HardDrive size={13} strokeWidth={1.8} aria-hidden="true" />
                <OverflowText>{localMeta}</OverflowText>
              </span>
            ) : null}
          </span>
        </span>
      </button>

      <div
        className="miniapp-library-row__actions"
        data-openbitfun-component="miniapp-gallery-view"
        data-openbitfun-part="actions"
      >
        {statuses.length > 0 ? (
          <div
            className="miniapp-library-row__status-rail"
            data-openbitfun-component="miniapp-gallery-view"
            data-openbitfun-part="status"
          >
            {statuses.map((status) => (
              <StatusPill
                className="miniapp-library-row__status"
                key={`${status.tone}:${status.label}`}
                tone={status.tone}
              >
                {status.label}
              </StatusPill>
            ))}
          </div>
        ) : null}
        <div className="miniapp-library-row__launch-actions">
          {launchActions}
          {action !== 'open' || !launchActions ? <Button
            className="miniapp-library-row__primary"
            size="sm"
            variant={action === 'open' ? 'outline' : 'primary'}
            disabled={actionDisabled}
            loading={busy}
            title={actionTitle}
            onClick={onPrimaryAction}
          >
            {actionLabel}
          </Button> : null}
        </div>
      </div>
    </article>
  );
};

export default MiniAppLibraryRow;
export type { MiniAppLibraryRowProps, MiniAppLibraryStatus };
