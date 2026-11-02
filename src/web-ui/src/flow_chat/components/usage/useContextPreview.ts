import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import type { UsageContextCategory } from '@/infrastructure/api/service-api/SessionAPI';
import { openSessionContextPreview } from '../../services/openSessionContextPreview';
import { notificationService } from '@/shared/notification-system';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';

/** Both usage surfaces open the same session-owned, capability-checked preview. */
export function useContextPreview(params: { sessionId?: string; reportSessionId?: string; workspaceId?: string }) {
  const { t } = useI18n('flow-chat');
  const [previewLoading, setPreviewLoading] = useState<UsageContextCategory | null>(null);
  const requestRef = useRef<symbol | null>(null);
  useEffect(() => {
    requestRef.current = null;
    setPreviewLoading(null);
    return () => { requestRef.current = null; };
  }, [params.sessionId, params.reportSessionId, params.workspaceId]);

  const previewContext = async (category: UsageContextCategory) => {
    if (!params.sessionId || !params.reportSessionId || requestRef.current) return;
    const request = Symbol();
    requestRef.current = request;
    const surface = getActiveSurfaceScope();
    const isCurrent = () => surface.isCurrent() && requestRef.current === request;
    setPreviewLoading(category);
    try {
      const result = await openSessionContextPreview({
        sessionId: params.sessionId, reportSessionId: params.reportSessionId, workspaceId: params.workspaceId,
        title: `${t(`usage.context.categories.${category}`)}${category === 'toolDefinitions' ? '' : '.md'}`,
        category, emptyContent: t('usage.context.previewEmpty'),
      });
      if (isCurrent() && result === 'unavailable') notificationService.warning(t('usage.context.previewUnavailable'));
    } catch (error) {
      if (isCurrent() && !isSurfaceChangedError(error)) notificationService.error(t('usage.context.previewFailed'));
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setPreviewLoading(null);
      }
    }
  };
  return { previewLoading, previewContext };
}
