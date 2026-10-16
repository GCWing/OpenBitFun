import { OverflowText,
  Button,
  Icon,
  StatusPill,
  ScrollArea,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useMemo, useRef } from 'react';
import { Bot, Cpu, Database, FolderKanban, Play, ShieldCheck, Square } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { getMiniAppShowcaseAsset, renderMiniAppIcon } from '../utils/miniAppIcons';
import { MarketImage } from '@/app/components/GalleryLayout/MarketImage';
import { MiniAppDetailPage } from './MiniAppDetailPage';
import { pickLocalizedString, pickLocalizedTags } from '../utils/pickLocalizedString';
import {
  projectMiniAppDetailCapabilities,
  resolveMiniAppDetailSource,
  type MiniAppDetailCapability,
  type MiniAppDetailSource,
} from './miniAppDetailPresentation';
import './MiniAppDetailModal.scss';

interface MiniAppDetailModalProps {
  presentation?: 'dialog' | 'page';
  app: MiniAppMeta | null;
  marketReleaseNumber?: number;
  isActive: boolean;
  isCustomizing: boolean;
  onClose: () => void;
  onOpen: (appId: string) => void;
  launchActions?: React.ReactNode;
  systemAppActions?: React.ReactNode;
  onDelete: (appId: string) => void;
  onStop?: (appId: string) => void | Promise<void>;
}

interface DetailSnapshot {
  app: MiniAppMeta;
  marketReleaseNumber?: number;
  isActive: boolean;
  isCustomizing: boolean;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

function capabilityIcon(capability: MiniAppDetailCapability): React.ReactNode {
  switch (capability.kind) {
    case 'ai': return <Icon name="spark" size="lg" />;
    case 'workspace': return <FolderKanban size={28} strokeWidth={1.6} />;
    case 'export': return <Icon name="arrow-down" size="lg" />;
    case 'shell': return <Icon name="terminal" size="lg" />;
    case 'network': return <Icon name="browser" size="lg" />;
    case 'worker': return <Cpu size={28} strokeWidth={1.6} />;
    case 'storage': return <Database size={28} strokeWidth={1.6} />;
    case 'desktop': return <Bot size={28} strokeWidth={1.6} />;
    case 'controlled': return <ShieldCheck size={28} strokeWidth={1.6} />;
    case 'instant': return <Play size={28} strokeWidth={1.6} />;
    case 'surface':
    default:
      return <Icon name="floating-window" size="lg" />;
  }
}

function capabilityCopy(
  capability: MiniAppDetailCapability,
  t: Translate,
): { title: string; description: string } {
  switch (capability.kind) {
    case 'ai':
      return {
        title: t('detail.capabilities.ai.title'),
        description: t('detail.capabilities.ai.description'),
      };
    case 'workspace':
      return {
        title: t('detail.capabilities.workspace.title'),
        description: t('detail.capabilities.workspace.description'),
      };
    case 'export':
      return {
        title: t('detail.capabilities.export.title'),
        description: t('detail.capabilities.export.description'),
      };
    case 'shell':
      return {
        title: t('detail.capabilities.shell.title'),
        description: t('detail.capabilities.shell.description', { commands: capability.value ?? '' }),
      };
    case 'network':
      return {
        title: t('detail.capabilities.network.title'),
        description: t('detail.capabilities.network.description', { count: capability.count ?? 0 }),
      };
    case 'worker':
      return {
        title: t('detail.capabilities.worker.title'),
        description: t('detail.capabilities.worker.description'),
      };
    case 'storage':
      return {
        title: t('detail.capabilities.storage.title'),
        description: t('detail.capabilities.storage.description'),
      };
    case 'desktop':
      return {
        title: t('detail.capabilities.desktop.title'),
        description: t('detail.capabilities.desktop.description', { count: capability.count ?? 0 }),
      };
    case 'controlled':
      return {
        title: t('detail.capabilities.controlled.title'),
        description: t('detail.capabilities.controlled.description'),
      };
    case 'instant':
      return {
        title: t('detail.capabilities.instant.title'),
        description: t('detail.capabilities.instant.description'),
      };
    case 'surface':
    default:
      return {
        title: t('detail.capabilities.surface.title'),
        description: t('detail.capabilities.surface.description'),
      };
  }
}

function sourceLabel(source: MiniAppDetailSource, t: Translate): string {
  switch (source) {
    case 'builtin': return t('detail.source.builtin');
    case 'market': return t('detail.source.market');
    case 'installed':
    default:
      return t('detail.source.installed');
  }
}

const MiniAppDetailModal: React.FC<MiniAppDetailModalProps> = ({
  presentation = 'dialog',
  app,
  marketReleaseNumber,
  isActive,
  isCustomizing,
  onClose,
  onOpen,
  launchActions,
  systemAppActions,
  onDelete,
  onStop,
}) => {
  const { t, currentLanguage } = useI18n('scenes/miniapp');
  const snapshotRef = useRef<DetailSnapshot | null>(null);

  if (app) {
    snapshotRef.current = {
      app,
      marketReleaseNumber,
      isActive,
      isCustomizing,
    };
  }

  const snapshot = app
    ? { app, marketReleaseNumber, isActive, isCustomizing }
    : snapshotRef.current;

  const displayedApp = snapshot?.app;
  const capabilities = useMemo(
    () => displayedApp ? projectMiniAppDetailCapabilities(displayedApp) : [],
    [displayedApp],
  );

  if (!displayedApp || !snapshot) return null;

  const localizedName = pickLocalizedString(displayedApp, currentLanguage, 'name');
  const localizedDescription = pickLocalizedString(displayedApp, currentLanguage, 'description');
  const localizedTags = pickLocalizedTags(displayedApp, currentLanguage);
  const source = resolveMiniAppDetailSource(displayedApp.id, snapshot.marketReleaseNumber !== undefined);
  const version = snapshot.marketReleaseNumber ?? displayedApp.version;
  const statusCopy = snapshot.isCustomizing
    ? t('detail.status.customizing')
    : snapshot.isActive
      ? t('detail.status.running')
      : t('detail.status.installed');

  if (presentation === 'page') {
    if (!app) return null;
    const showcase = getMiniAppShowcaseAsset(displayedApp.id);
    return (
      <MiniAppDetailPage
        title={localizedName}
        description={localizedDescription}
        icon={renderMiniAppIcon(displayedApp.icon || 'box', 40)}
        badges={<>
          <StatusPill tone="neutral">{sourceLabel(source, t)}</StatusPill>
          <StatusPill tone="neutral">v{version}</StatusPill>
          {localizedTags.map(tag => <StatusPill key={tag} tone="neutral">{tag}</StatusPill>)}
        </>}
        actions={<>
          {systemAppActions}
          {launchActions ?? <Button variant="outline" size="sm" onClick={() => onOpen(displayedApp.id)}>
            {t('detail.start')}
          </Button>}
          {snapshot.isActive && onStop && <Button variant="outline" size="sm" onClick={() => void onStop(displayedApp.id)}>
            {t('detail.stop')}
          </Button>}
          <Button variant="outline" tone="danger" size="sm" onClick={() => onDelete(displayedApp.id)}>{t('detail.uninstall')}</Button>
        </>}
        preview={showcase ? <MarketImage source={showcase} responsive width={1280} height={720}
          sizes="(min-width: 720px) 680px, 100vw" alt={t('market.library.showcaseAlt', { name: localizedName })} /> : undefined}
      >
        <section className="miniapp-detail-page__section">
          <h2 className="miniapp-detail-page__section-title">{t('detail.highlights')}</h2>
          <ul className="miniapp-detail-page__capabilities">
            {capabilities.map(capability => {
              const copy = capabilityCopy(capability, t);
              return <li key={capability.kind} className="miniapp-detail-page__capability">
                <span className="miniapp-detail-page__capability-icon" aria-hidden="true">{capabilityIcon(capability)}</span>
                <span className="miniapp-detail-page__capability-copy">
                  <strong className="miniapp-detail-page__label">{copy.title}</strong>
                  <span className="miniapp-detail-page__copy">{copy.description}</span>
                </span>
              </li>;
            })}
          </ul>
        </section>
        <section className="miniapp-detail-page__section">
          <h2 className="miniapp-detail-page__section-title">{t('detail.information')}</h2>
          <dl className="miniapp-detail-page__information">
            <div className="miniapp-detail-page__information-row"><dt>{t('detail.versionLabel')}</dt><dd>v{version}</dd></div>
            <div className="miniapp-detail-page__information-row"><dt>{t('detail.sourceLabel')}</dt><dd>{sourceLabel(source, t)}</dd></div>
            <div className="miniapp-detail-page__information-row"><dt>{t('detail.statusLabel')}</dt><dd>{statusCopy}</dd></div>
          </dl>
        </section>
      </MiniAppDetailPage>
    );
  }

  return (
    <Dialog
      open={Boolean(app)}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      size="2xl"
      className="miniapp-detail-dialog"
      data-testid="miniapp-detail-dialog"
    >
      <DialogHeader className="miniapp-detail-dialog__header">
        <DialogHeading className="miniapp-detail-dialog__heading">
          <DialogTitle className="miniapp-detail-dialog__title" data-testid="miniapp-detail-title">
            {localizedName}
          </DialogTitle>
          <span className="miniapp-detail-modal__source-badge" data-testid="miniapp-detail-source">
            {sourceLabel(source, t)}
          </span>
        </DialogHeading>
        <DialogClose data-testid="miniapp-detail-close" />
      </DialogHeader>
      <DialogBody className="miniapp-detail-dialog__body" inset="none">
        <ScrollArea
          className="miniapp-detail-modal"
          data-openbitfun-component="mini-app-detail-modal"
          data-openbitfun-part="root"
          data-openbitfun-state={[
            snapshot.isActive && 'running',
            snapshot.isCustomizing && 'customizing',
          ].filter(Boolean).join(' ') || undefined}
          data-openbitfun-source={source}
          data-miniapp-id={displayedApp.id}
        >
        <section className="miniapp-detail-modal__hero" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="hero">
          <div className="miniapp-detail-modal__icon-stage" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="iconStage">
            <div className="miniapp-detail-modal__icon" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="icon">
              {renderMiniAppIcon(displayedApp.icon || 'box', 72)}
            </div>
            {snapshot.isActive ? (
              <span
                className="miniapp-detail-modal__activity-dot"
                aria-label={t('detail.activity.running')}
                data-testid="miniapp-detail-activity"
              />
            ) : null}
          </div>

          <div className="miniapp-detail-modal__summary" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="summary">
            <div className="miniapp-detail-modal__identity">
              <h3 className="miniapp-detail-modal__name">{localizedName}</h3>
              <span className="miniapp-detail-modal__version" data-testid="miniapp-detail-version">v{version}</span>
            </div>
            {localizedDescription.trim() ? (
              <p className="miniapp-detail-modal__description" data-testid="miniapp-detail-description">
                {localizedDescription.trim()}
              </p>
            ) : null}
            {localizedTags.length ? (
              <div className="miniapp-detail-modal__tags" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="tags">
                {localizedTags.map((tag) => (
                  <span key={tag} className="miniapp-detail-modal__tag">{tag}</span>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section className="miniapp-detail-modal__highlights" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="highlights">
          <h4 className="miniapp-detail-modal__section-title">{t('detail.highlights')}</h4>
          <div className="miniapp-detail-modal__highlight-grid">
            {capabilities.map((capability) => {
              const copy = capabilityCopy(capability, t);
              return (
                <div
                  key={capability.kind}
                  className="miniapp-detail-modal__highlight"
                  data-openbitfun-component="mini-app-detail-modal"
                  data-openbitfun-part="highlight"
                  data-capability={capability.kind}
                  data-testid="miniapp-detail-capability"
                >
                  <span className="miniapp-detail-modal__highlight-icon" aria-hidden="true">
                    {capabilityIcon(capability)}
                  </span>
                  <span className="miniapp-detail-modal__highlight-copy">
                    <strong><OverflowText>{copy.title}</OverflowText></strong>
                    <OverflowText className="miniapp-detail-modal__highlight-description" lines={2}>
                      {copy.description}
                    </OverflowText>
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        </ScrollArea>
      </DialogBody>
      <DialogFooter
        separator
        className="miniapp-detail-modal__footer"
        data-openbitfun-component="mini-app-detail-modal"
        data-openbitfun-part="footer"
      >
          <div className="miniapp-detail-modal__status" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="status">
            <Icon name="check-circle" size="lg" aria-hidden="true" />
            <span data-testid="miniapp-detail-status">{statusCopy}</span>
          </div>
          <div className="miniapp-detail-modal__actions" data-openbitfun-component="mini-app-detail-modal" data-openbitfun-part="actions">
            {snapshot.isActive && onStop ? (
              <Button
                variant="outline"
                size="md"
                className="miniapp-detail-modal__stop"
                onClick={() => void onStop(displayedApp.id)}
                data-testid="miniapp-detail-stop"
                leadingIcon={<Square size={17} />}
              >

                {t('detail.stop')}
              </Button>
            ) : null}
            {launchActions ?? <Button
              variant="primary"
              size="md"
              className="miniapp-detail-modal__primary"
              onClick={() => onOpen(displayedApp.id)}
              data-testid="miniapp-detail-primary-action"
              leadingIcon={<Play size={18} fill="currentColor" strokeWidth={0} />}
            >

              {snapshot.isActive ? t('detail.open') : t('detail.start')}
            </Button>}
            {systemAppActions}
            <Button
              variant="outline"
              size="md"
              className="miniapp-detail-modal__delete"
              onClick={() => onDelete(displayedApp.id)}
              data-testid="miniapp-detail-delete"
              leadingIcon={<Icon name="delete" size="lg" style={{ width: 18, height: 18 }} />}
            >

              {t('detail.delete')}
            </Button>
          </div>
      </DialogFooter>
    </Dialog>
  );
};

export default MiniAppDetailModal;
export type { MiniAppDetailModalProps };

export function MiniAppInstalledDetailPage(props: Omit<MiniAppDetailModalProps, 'presentation'>) {
  return <MiniAppDetailModal {...props} presentation="page" />;
}
