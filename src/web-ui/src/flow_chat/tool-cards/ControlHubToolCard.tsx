import { useToolCardDisclosure } from '../timeline/readerState';
import React, { useMemo } from 'react';
import { ControlHubToolCard as ControlHubToolCardView, type ToolCardField, type ControlHubToolCardRecord } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import type { ToolCardProps } from '../types/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { getToolCardStatusDescription } from './toolCardStatus';
import { buildControlHubCardModel, formatRuntimeToolValue, runtimeToolNeedsConfirmation, runtimeToolText } from './runtimeToolCardModel';

export const ControlHubToolCard: React.FC<ToolCardProps> = ({ toolItem, onExpand }) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const [isExpanded, setExpanded] = useToolCardDisclosure('isExpanded');
  const model = useMemo(() => buildControlHubCardModel(toolItem), [toolItem]);
  const { cardRootRef, applyExpandedState, dispatchToolCardToggle } = useToolCardHeightContract({ toolId: toolItem.id, toolName: 'ControlHub' });
  const actions: Record<string, string> = {
    open_builtin: t('toolCards.controlHub.actions.open'), tab_new: t('toolCards.controlHub.actions.newTab'),
    connect: t('toolCards.controlHub.actions.connect'), navigate: t('toolCards.controlHub.actions.navigate'),
    back: t('toolCards.controlHub.actions.back'), forward: t('toolCards.controlHub.actions.forward'), reload: t('toolCards.controlHub.actions.reload'),
    snapshot: t('toolCards.controlHub.actions.snapshot'), screenshot: t('toolCards.controlHub.actions.screenshot'),
    click: t('toolCards.controlHub.actions.click'), hover: t('toolCards.controlHub.actions.hover'),
    fill: t('toolCards.controlHub.actions.fill'), type: t('toolCards.controlHub.actions.type'),
    check: t('toolCards.controlHub.actions.check'), uncheck: t('toolCards.controlHub.actions.uncheck'),
    select: t('toolCards.controlHub.actions.select'), press_key: t('toolCards.controlHub.actions.pressKey'),
    scroll: t('toolCards.controlHub.actions.scroll'), auto_scroll: t('toolCards.controlHub.actions.scroll'), wait: t('toolCards.controlHub.actions.wait'),
    get: t('toolCards.controlHub.actions.read'), get_text: t('toolCards.controlHub.actions.read'), get_html: t('toolCards.controlHub.actions.readHtml'),
    get_url: t('toolCards.controlHub.actions.readUrl'), get_title: t('toolCards.controlHub.actions.readTitle'), read_article: t('toolCards.controlHub.actions.readArticle'),
    evaluate: t('toolCards.controlHub.actions.evaluate'), fetch: t('toolCards.controlHub.actions.fetch'),
    cookies: t('toolCards.controlHub.actions.cookies'), set_cookies: t('toolCards.controlHub.actions.setCookies'),
    set_file_input_files: t('toolCards.controlHub.actions.upload'), cdp: t('toolCards.controlHub.actions.protocol'),
    network: t('toolCards.controlHub.actions.network'), console: t('toolCards.controlHub.actions.console'),
    errors: t('toolCards.controlHub.actions.errors'), trace: t('toolCards.controlHub.actions.trace'), dialog: t('toolCards.controlHub.actions.dialog'),
    close: t('toolCards.controlHub.actions.close'), list_pages: t('toolCards.controlHub.actions.listPages'),
    tab_query: t('toolCards.controlHub.actions.queryTabs'), switch_page: t('toolCards.controlHub.actions.switchPage'),
    list_sessions: t('toolCards.controlHub.actions.listSessions'), interrupt: t('toolCards.controlHub.actions.interrupt'), kill: t('toolCards.controlHub.actions.kill'),
    capabilities: t('toolCards.controlHub.actions.capabilities'), route_hint: t('toolCards.controlHub.actions.routeHint'),
  };
  const domain = model.domain === 'browser' || model.domain === 'terminal' || model.domain === 'meta' ? model.domain : 'unknown';
  const domainLabel = domain === 'browser' ? t('toolCards.controlHub.browser') : domain === 'terminal'
    ? t('toolCards.controlHub.terminal') : domain === 'meta' ? t('toolCards.controlHub.meta') : model.domain;
  const needsConfirmation = runtimeToolNeedsConfirmation(toolItem, model.status);
  const statusLabel = needsConfirmation ? t('toolCards.default.waitingConfirm')
    : model.status === 'error' ? t('toolCards.default.failed')
      : model.status === 'cancelled' ? t('toolCards.default.cancelled')
        : model.status === 'rejected' ? t('toolCards.default.rejected')
          : model.status === 'queued' ? t('toolCards.default.queued')
            : model.status === 'waiting' ? t('toolCards.default.waiting')
              : model.status === 'completed' ? (model.hasRecordList
                ? t('toolCards.controlHub.resultCount', { value: formatNumber(model.records.length) }) : t('toolCards.default.completed'))
                : t('toolCards.default.executing');
  const fields: ToolCardField[] = [];
  const addField = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) fields.push({ label, value });
  };
  addField(t('toolCards.controlHub.domain'), domainLabel);
  addField(t('toolCards.controlHub.operation'), [model.domain, model.action].filter(Boolean).join('.'));
  addField(t('toolCards.controlHub.url'), model.data.url ?? model.params.url ?? model.params.target_url);
  addField(t('toolCards.controlHub.pageTitle'), model.data.title ?? model.params.target_title);
  addField(t('toolCards.controlHub.selector'), model.params.selector ?? model.params.ref);
  addField(t('toolCards.controlHub.session'), model.data.session_id ?? model.data.terminal_session_id ?? model.params.session_id ?? model.params.terminal_session_id);
  const target = runtimeToolText(model.data.target) ?? runtimeToolText(model.params.target) ?? runtimeToolText(model.params.browser_target);
  addField(t('toolCards.controlHub.target'), target && (['builtin', 'built_in', 'embedded', 'openbitfun'].includes(target)
    ? t('toolCards.controlHub.builtin') : ['external', 'cdp'].includes(target) ? t('toolCards.controlHub.external') : target));
  if (typeof model.data.ms === 'number') addField(t('toolCards.controlHub.elapsed'), t('toolCards.controlHub.milliseconds', { value: formatNumber(model.data.ms) }));
  if (model.route) {
    addField(t('toolCards.controlHub.suggestedDomain'), model.route.domain);
    addField(t('toolCards.controlHub.suggestedTool'), model.route.tool);
    addField(t('toolCards.controlHub.suggestedAction'), model.route.action);
  }
  const records: ControlHubToolCardRecord[] = model.records.map(record => ({
    key: record.key, title: record.title!, description: record.description,
    fields: [record.id && { label: t('toolCards.controlHub.targetId'), value: record.id },
      record.status && { label: t('toolCards.controlHub.state'), value: record.status }].filter(Boolean) as ToolCardField[],
  }));
  const domainLabels: Record<string, string> = {
    browser: t('toolCards.controlHub.browser'), terminal: t('toolCards.controlHub.terminal'), meta: t('toolCards.controlHub.meta'),
  };
  const targetLabels: Record<string, string> = { builtin: t('toolCards.controlHub.builtin'), external: t('toolCards.controlHub.external') };
  for (const capability of model.capabilities) {
    const capabilityFields: ToolCardField[] = [];
    if (typeof capability.available === 'boolean') capabilityFields.push({ label: t('toolCards.controlHub.state'),
      value: capability.available ? t('toolCards.controlHub.available') : t('toolCards.controlHub.unavailable') });
    if (typeof capability.sessionCount === 'number') capabilityFields.push({ label: t('toolCards.controlHub.sessions'), value: formatNumber(capability.sessionCount) });
    const labelKey = capability.target ?? capability.domain;
    const labels = capability.target ? targetLabels : domainLabels;
    records.push({ key: capability.key, title: Object.prototype.hasOwnProperty.call(labels, labelKey) ? labels[labelKey] : labelKey,
      description: runtimeToolText(capability.reason), fields: capabilityFields });
  }
  const output = model.hasRecordList && model.records.length === 0 ? t('toolCards.controlHub.emptyResults') : model.output;
  const hasSemanticResult = model.capabilities.length > 0 || Boolean(model.route);
  const resultText = output ?? (hasSemanticResult ? undefined : isExpanded ? formatRuntimeToolValue(model.fallback) : undefined);
  return <div ref={cardRootRef} data-openbitfun-adapter="control-hub" data-tool-card-id={toolItem.id}>
    <ControlHubToolCardView status={model.status} attention={model.attention} domain={domain}
      action={Object.prototype.hasOwnProperty.call(actions, model.action) ? actions[model.action] : (model.action || t('toolCards.controlHub.title'))}
      summary={model.attention === 'ambient' ? model.target || domainLabel
        : [domainLabel, model.target, statusLabel].filter(Boolean).join(' · ')}
      resultSummary={model.status === 'completed' && model.hasRecordList
        ? t('toolCards.controlHub.resultCount', { value: formatNumber(model.records.length) }) : undefined}
      statusDescription={getToolCardStatusDescription(needsConfirmation ? 'pending_confirmation' : model.status, t, model.error)}
      fields={fields} records={records} resultLabel={t('toolCards.common.executionResult')}
      resultText={resultText} resultVariant={output && !model.outputIsCode ? 'prose' : 'code'}
      resultDetailsText={isExpanded && hasSemanticResult ? formatRuntimeToolValue(model.data) : undefined}
      resultDetailsLabel={t('toolCards.controlHub.resultDetails')}
      error={model.status === 'error' || model.error ? [model.errorCode, model.error ?? t('toolCards.default.failed')].filter(Boolean).join(' · ') : undefined}
      notices={model.notices} noticesLabel={t('toolCards.controlHub.notices')}
      images={isExpanded ? model.images.map(image => ({ src: `data:${image.mime_type};base64,${image.data_base64}`, alt: t('toolCards.controlHub.screenshot') })) : []}
      paramsText={isExpanded && Object.keys(model.params).length > 0 ? formatRuntimeToolValue(model.params) : undefined}
      paramsLabel={t('toolCards.common.inputParams')} onParamsOpenChange={dispatchToolCardToggle}
      isExpanded={isExpanded} requiresConfirmation={needsConfirmation}
      onToggle={() => applyExpandedState(isExpanded, !isExpanded, setExpanded, { onExpand })} />
  </div>;
};
