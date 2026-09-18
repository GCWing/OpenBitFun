import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { LoadingState } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import BrowserPanel from './BrowserPanel';
import { htmlPreviewApi } from '@/infrastructure/api/htmlPreviewApi';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';

export interface HtmlPreviewPanelProps {
  isActive: boolean;
  filePath: string;
  workspaceId: string;
}

const HtmlPreviewPanel: React.FC<HtmlPreviewPanelProps> = ({
  isActive,
  filePath,
  workspaceId,
}) => {
  const { t } = useTranslation('common');
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const sessionIdRef = useRef<string>();

  useEffect(() => {
    let cancelled = false;
    setUrl(undefined);
    setError(undefined);
    void htmlPreviewApi.create({
      filePath,
      workspaceId,
      peerDeviceMode: isPeerDeviceModeActive(),
    })
      .then((result) => {
        if (cancelled) {
          void htmlPreviewApi.release(result.sessionId);
          return;
        }
        sessionIdRef.current = result.sessionId;
        setUrl(result.url);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
      if (sessionIdRef.current) {
        void htmlPreviewApi.release(sessionIdRef.current);
        sessionIdRef.current = undefined;
      }
    };
  // The session is intentionally recreated only when the opened file scope changes.
  }, [filePath, workspaceId]);

  if (error) {
    return <div className="openbitfun-html-preview__error"><AlertTriangle size={16} /><span>{error}</span></div>;
  }
  if (!url) {
    return <div className="openbitfun-html-preview__loading"><LoadingState size="md">{t('loading.scenes')}</LoadingState></div>;
  }
  return <BrowserPanel isActive={isActive} initialUrl={url} />;
};

export default HtmlPreviewPanel;
