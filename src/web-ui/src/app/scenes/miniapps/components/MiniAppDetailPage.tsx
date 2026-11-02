import { Button, Icon } from '@openbitfun/ui';
import React, { useLayoutEffect, useRef } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import './MiniAppDetailPage.scss';

interface MiniAppDetailPageProps {
  title: string;
  description?: string;
  icon: React.ReactNode;
  badges?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  preview?: React.ReactNode;
  loading?: boolean;
  children?: React.ReactNode;
}

export function MiniAppDetailBackButton({ onBack, label }: { onBack: () => void; label?: string }) {
  const { t } = useI18n('scenes/miniapp');
  return (
    <Button variant="quiet" size="sm" leadingIcon={<Icon name="arrow-left" size="sm" />} onClick={onBack}>
      {label ?? t('detail.back')}
    </Button>
  );
}

/** Shared in-scene detail frame for installed and marketplace MiniApps. */
export function MiniAppDetailPage({
  title, description, icon, badges, meta, actions, preview, loading, children,
}: MiniAppDetailPageProps) {
  const pageRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    pageRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <article
      ref={pageRef}
      className="miniapp-detail-page"
      tabIndex={-1}
      aria-label={title}
      aria-busy={loading || undefined}
      data-openbitfun-component="miniapp-gallery-view"
      data-openbitfun-part="detail"
      data-testid="miniapp-detail-page"
    >
      <header className="miniapp-detail-page__hero">
        <div className="miniapp-detail-page__icon" aria-hidden="true">{icon}</div>
        <div className="miniapp-detail-page__identity">
          <div className="miniapp-detail-page__title-row">
            <h1 className="miniapp-detail-page__title">{title}</h1>
            {actions && <div className="miniapp-detail-page__actions">{actions}</div>}
          </div>
          {description?.trim() && <p className="miniapp-detail-page__description">{description.trim()}</p>}
        </div>
        {(badges || meta) && <div className="miniapp-detail-page__metadata">{badges}{meta}</div>}
      </header>
      {preview && <div className="miniapp-detail-page__preview">{preview}</div>}
      <div className="miniapp-detail-page__body">{children}</div>
    </article>
  );
}
