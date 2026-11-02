import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { AlertTriangle } from 'lucide-react';
import { LoadingState } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import BrowserPanel from './BrowserPanel';
import { htmlPreviewApi } from '@/infrastructure/api/htmlPreviewApi';
import { getActiveSurfaceScope, isSurfaceChangedError, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('HtmlPreviewPanel');

export interface HtmlPreviewPanelProps {
  isActive: boolean;
  filePath: string;
  workspaceId: string;
}

const HtmlPreviewContent: React.FC<HtmlPreviewPanelProps> = ({
  isActive,
  filePath,
  workspaceId,
}) => {
  const { t } = useTranslation('common');
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | undefined;
    const release = (id: string) => {
      void htmlPreviewApi.release(id).catch(reason => log.warn('Failed to release HTML preview', reason));
    };
    setUrl(undefined);
    setError(undefined);
    void htmlPreviewApi.create({
      filePath,
      workspaceId,
    })
      .then((result) => {
        if (cancelled) {
          release(result.sessionId);
          return;
        }
        sessionId = result.sessionId;
        setUrl(result.url);
      })
      .catch((reason: unknown) => {
        if (!cancelled && !isSurfaceChangedError(reason)) setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
      if (sessionId) release(sessionId);
    };
  }, [filePath, workspaceId]);

  if (error) {
    return <div className="openbitfun-html-preview__error"><AlertTriangle size={16} /><span>{error}</span></div>;
  }
  if (!url) {
    return <div className="openbitfun-html-preview__loading"><LoadingState size="md">{t('loading.scenes')}</LoadingState></div>;
  }
  return <BrowserPanel isActive={isActive} initialUrl={url} />;
};

const HtmlPreviewPanel: React.FC<HtmlPreviewPanelProps> = (props) => {
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  return <HtmlPreviewContent key={surface.key(surface.epoch, props.workspaceId, props.filePath)} {...props} />;
};

export default HtmlPreviewPanel;
