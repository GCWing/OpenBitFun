import React, { useCallback } from 'react';
import { Icon, IconButton } from '@openbitfun/ui';
import { PagePublishToolCard } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import type { ToolCardProps } from '../types/flow-chat';
import { useToolCardDisclosure } from '../timeline/readerState';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import { usePageToolOpen } from './usePageToolOpen';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const PageManageDisplay: React.FC<ToolCardProps> = ({ toolItem, sessionId }) => {
  const { t, formatDate, formatNumber } = useI18n('flow-chat');
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const { canOpen, openPage, unavailableReason } = usePageToolOpen(sessionId);
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({ toolId: toolItem.id, toolName: toolItem.toolName });
  const input = record(toolItem.isParamsStreaming ? toolItem.partialParams : toolItem.toolCall?.input);
  const result = record(toolItem.toolResult?.result);
  const status = getToolCardStatus(toolItem);
  const success = status === 'completed' && toolItem.toolResult?.success === true;
  const action = text(input.action) || text(result.action);
  const slug = text(result.slug) || text(input.slug);
  const version = text(result.version_id);
  const pages = success && Array.isArray(result.pages) ? result.pages.map(record) : undefined;
  const versions = success && Array.isArray(result.versions) ? result.versions.map(record) : undefined;
  const labels: Record<string, string> = {
    list: t('toolCards.pageManage.list'), publish: t('toolCards.pageManage.publish'),
    update: t('toolCards.pageManage.update'), permissions: t('toolCards.pageManage.permissions'),
    delete: t('toolCards.pageManage.delete'), versions: t('toolCards.pageManage.versions'),
    deploy: t('toolCards.pageManage.deploy'), unpublish: t('toolCards.pageManage.unpublish'),
  };
  const visibility = (value: unknown) => {
    switch (value) {
      case 'private': return t('toolCards.pageManage.private');
      case 'relay': return t('toolCards.pageManage.relay');
      case 'public': return t('toolCards.pageManage.public');
      default: return text(value);
    }
  };
  const date = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? formatDate(value * 1000, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const fields = pages ? pages.map(page => ({
    label: text(page.name) || text(page.title) || text(page.slug),
    value: [text(page.url), visibility(page.visibility), date(page.updated_at)].filter(Boolean).join(' · '),
  })) : versions ? versions.map(item => ({
    label: text(item.version_id),
    value: [text(item.title), text(item.preview_url), date(item.created_at)].filter(Boolean).join(' · '),
  })) : success ? [
    result.title ? { label: t('toolCards.pageManage.name'), value: text(result.title) } : null,
    result.visibility ? { label: t('toolCards.pageManage.permissions'), value: visibility(result.visibility) } : null,
    result.url ? { label: t('toolCards.pagePublish.labelPath'), value: text(result.url) } : null,
    result.preview_url ? { label: t('toolCards.pagePublish.labelPreview'), value: text(result.preview_url) } : null,
    typeof result.updated_at === 'number' ? { label: t('toolCards.pageManage.updated'), value: date(result.updated_at) } : null,
  ].filter((field): field is NonNullable<typeof field> => field !== null) : [];
  if (pages?.length === 0 || versions?.length === 0) {
    fields.push({ label: labels[action] || '', value: t('toolCards.pageManage.empty') });
  }
  const error = status === 'error' ? text(toolItem.toolResult?.error) || t('toolCards.default.failed') : undefined;
  const toggle = useCallback(() => applyExpandedState(isExpanded, !isExpanded, setIsExpanded), [applyExpandedState, isExpanded, setIsExpanded]);
  const generation = typeof result.generation === 'string' ? result.generation : undefined;
  const live = result.deployed === true || result.published === true;
  const preview = result.deployed === false && Boolean(result.preview_url);
  const count = pages?.length ?? versions?.length;
  const summary = typeof count === 'number'
    ? t('toolCards.pageManage.count', { count: formatNumber(count) }) : slug;
  return <div ref={cardRootRef} data-openbitfun-adapter="page-manage" data-testid="chat-page-manage-card"
    data-tool-card-id={toolItem.id} data-status={status} data-expanded={isExpanded ? 'true' : 'false'}>
    <PagePublishToolCard action={labels[action] || t('toolCards.pageManage.title')} subject={summary}
      version={version || undefined} status={status} isExpanded={isExpanded} onToggle={toggle}
      loading={['preparing', 'running', 'streaming'].includes(status)} fields={fields} error={error}
      statusLabel={getToolCardStatusDescription(status, t, error)
        || (success && live ? t('toolCards.pagePublish.publishedTitle')
          : success && preview ? t('toolCards.pagePublish.previewTitle') : undefined)}
      actions={success && slug && (live || preview) ? <>
        {live && Boolean(result.url) && <IconButton size="sm" variant="quiet" disabled={!canOpen}
          title={!canOpen ? unavailableReason : t('toolCards.pagePublish.openProduction')}
          icon={<Icon name="arrow-up-right" size="sm" />} aria-label={t('toolCards.pagePublish.openProduction')}
          onClick={() => void openPage(slug, generation)} />}
        {Boolean(result.preview_url) && version && <IconButton size="sm" variant="quiet" disabled={!canOpen}
          title={!canOpen ? unavailableReason : t('toolCards.pagePublish.openPreview')}
          icon={<Icon name="eye" size="sm" />} aria-label={t('toolCards.pagePublish.openPreview')}
          onClick={() => void openPage(slug, generation, version)} />}
      </> : undefined} />
  </div>;
};
